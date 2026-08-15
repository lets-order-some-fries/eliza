/**
 * Authenticates X API calls across static, PKCE, and managed broker credentials.
 * The complete effective credential tuple identifies the cached client; changing
 * any OAuth field or mode discards the authenticated profile before reuse.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";
import { ElizaError, logger } from "@elizaos/core";
import { TwitterApi } from "twitter-api-v2";
import type {
  BrokerAuthCredentials,
  TwitterAuthProvider,
  TwitterBrokerProvider,
  TwitterOAuth1Provider,
} from "./auth-providers/types";
import type { Profile } from "./profile";

function credentialFingerprint(
  key: Buffer,
  providerMode: TwitterAuthProvider["mode"],
  credentials: BrokerAuthCredentials,
): string {
  const values =
    credentials.mode === "oauth1"
      ? [
          providerMode,
          credentials.mode,
          credentials.appKey,
          credentials.appSecret,
          credentials.accessToken,
          credentials.accessSecret,
        ]
      : [providerMode, credentials.mode, credentials.accessToken];
  const hash = createHmac("sha256", key);
  for (const value of values) {
    hash.update(String(Buffer.byteLength(value, "utf8")));
    hash.update(":");
    hash.update(value);
  }
  return hash.digest("hex");
}

function isCredentialRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; isAuthError?: unknown };
  return (
    candidate.isAuthError === true ||
    candidate.code === 401 ||
    candidate.code === 403
  );
}

type ClientGeneration = {
  id: number;
  fingerprint: string;
  client: TwitterApi;
};

export type AuthenticatedTwitterSession = {
  client: TwitterApi;
  profile: Profile;
  revision: number;
};

/**
 * Twitter API v2 authentication using developer credentials
 */
export class TwitterAuth {
  private generation?: ClientGeneration;
  private nextGeneration = 0;
  private lifecycle = 0;
  private authenticated = false;
  private loggedOut = false;
  private readonly fingerprintKey = randomBytes(32);
  private generationGate: Promise<void> = Promise.resolve();
  private readonly sessionContext = new AsyncLocalStorage<ClientGeneration>();
  private initialization?: {
    lifecycle: number;
    promise: Promise<ClientGeneration>;
  };
  private profileCache?: { generation: number; profile: Profile };
  private readonly profileLoads = new Map<number, Promise<Profile>>();

  constructor(private readonly provider: TwitterAuthProvider) {
    if (this.isOAuth1Provider(provider)) {
      this.authenticated = true;
    }
  }

  private isOAuth1Provider(p: TwitterAuthProvider): p is TwitterOAuth1Provider {
    const candidate = p as { getOAuth1Credentials?: unknown };
    return typeof candidate.getOAuth1Credentials === "function";
  }

  private isBrokerProvider(p: TwitterAuthProvider): p is TwitterBrokerProvider {
    const candidate = p as { getBrokerCredentials?: unknown };
    return typeof candidate.getBrokerCredentials === "function";
  }

  private async resolveCredentials(): Promise<BrokerAuthCredentials> {
    if (this.isBrokerProvider(this.provider)) {
      return this.provider.getBrokerCredentials();
    }
    if (this.isOAuth1Provider(this.provider)) {
      return {
        mode: "oauth1",
        ...(await this.provider.getOAuth1Credentials()),
      };
    }
    return {
      mode: "oauth2",
      accessToken: await this.provider.getAccessToken(),
    };
  }

  private async initializeClient(lifecycle: number): Promise<ClientGeneration> {
    this.assertActiveLifecycle(lifecycle);
    let credentials: BrokerAuthCredentials;
    try {
      credentials = await this.resolveCredentials();
    } catch {
      throw new ElizaError("Failed to resolve X credentials", {
        code: "X_AUTH_INITIALIZATION_FAILED",
      });
    }
    const fingerprint = credentialFingerprint(
      this.fingerprintKey,
      this.provider.mode,
      credentials,
    );
    return this.runGenerationExclusive(async () => {
      this.assertActiveLifecycle(lifecycle);
      if (this.generation?.fingerprint === fingerprint) {
        return this.generation;
      }
      const client =
        credentials.mode === "oauth1"
          ? new TwitterApi({
              appKey: credentials.appKey,
              appSecret: credentials.appSecret,
              accessToken: credentials.accessToken,
              accessSecret: credentials.accessSecret,
            })
          : new TwitterApi(credentials.accessToken);
      const generation = {
        id: ++this.nextGeneration,
        fingerprint,
        client,
      };
      this.generation = generation;
      this.profileCache = undefined;
      this.profileLoads.clear();
      this.authenticated = true;
      return generation;
    });
  }

  private assertActiveLifecycle(lifecycle: number): void {
    if (this.loggedOut || this.lifecycle !== lifecycle) {
      throw new ElizaError("Twitter API client not initialized", {
        code: "X_AUTH_NOT_INITIALIZED",
      });
    }
  }

  private isCurrent(generation: ClientGeneration): boolean {
    return !this.loggedOut && this.generation === generation;
  }

  private async runGenerationExclusive<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.generationGate;
    let release: () => void = () => undefined;
    this.generationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async ensureClientInitialized(): Promise<ClientGeneration> {
    const pinned = this.sessionContext.getStore();
    if (pinned) {
      if (this.loggedOut) {
        throw new ElizaError("Twitter API client not initialized", {
          code: "X_AUTH_NOT_INITIALIZED",
        });
      }
      return pinned;
    }
    if (this.loggedOut) {
      throw new ElizaError("Twitter API client not initialized", {
        code: "X_AUTH_NOT_INITIALIZED",
      });
    }
    const lifecycle = this.lifecycle;
    if (this.initialization?.lifecycle === lifecycle) {
      return this.initialization.promise;
    }

    const promise = this.initializeClient(lifecycle);
    const initialization = { lifecycle, promise };
    this.initialization = initialization;
    try {
      return await promise;
    } finally {
      if (this.initialization === initialization) {
        this.initialization = undefined;
      }
    }
  }

  private async fetchProfile(client: TwitterApi): Promise<Profile> {
    try {
      const { data: user } = await client.v2.me({
        "user.fields": [
          "id",
          "name",
          "username",
          "description",
          "profile_image_url",
          "public_metrics",
          "verified",
          "location",
          "created_at",
        ],
      });

      return {
        userId: user.id,
        username: user.username,
        name: user.name,
        biography: user.description,
        avatar: user.profile_image_url,
        followersCount: user.public_metrics?.followers_count,
        followingCount: user.public_metrics?.following_count,
        isVerified: user.verified,
        location: user.location || "",
        joined: user.created_at ? new Date(user.created_at) : undefined,
      };
    } catch (error) {
      if (isCredentialRejection(error)) {
        throw new ElizaError("X rejected the authenticated credentials", {
          code: "X_AUTH_REJECTED",
        });
      }
      throw new ElizaError("Failed to fetch authenticated user profile", {
        code: "X_ME_FETCH_FAILED",
      });
    }
  }

  private profileFor(generation: ClientGeneration): Promise<Profile> {
    if (this.profileCache?.generation === generation.id) {
      return Promise.resolve(this.profileCache.profile);
    }

    const activeLoad = this.profileLoads.get(generation.id);
    if (activeLoad) {
      return activeLoad;
    }

    let load: Promise<Profile>;
    load = this.fetchProfile(generation.client)
      .then((profile) => {
        if (this.isCurrent(generation)) {
          this.profileCache = { generation: generation.id, profile };
        }
        return profile;
      })
      .finally(() => {
        if (this.profileLoads.get(generation.id) === load) {
          this.profileLoads.delete(generation.id);
        }
      });
    this.profileLoads.set(generation.id, load);
    return load;
  }

  /**
   * Get the Twitter API v2 client
   */
  async getV2Client(): Promise<TwitterApi> {
    return (await this.ensureClientInitialized()).client;
  }

  /**
   * Check if authenticated
   */
  async isLoggedIn(): Promise<boolean> {
    // error-policy:J4 availability probe — this method's contract is a boolean
    // "are we authenticated" answer, so any init/verify failure is the designed
    // false, not a masked read. Callers that need the failure call me() instead.
    try {
      return await this.withAuthenticatedSession(
        async (session) =>
          typeof session.profile.userId === "string" &&
          session.profile.userId.length > 0,
      );
    } catch {
      // error-policy:J4 initialization failures are represented by the same
      // not-logged-in result; callers that need the cause use me().
      logger.debug(
        "[X.TwitterAuth] credential verification failed; reporting not-logged-in",
      );
      return false;
    }
  }

  /**
   * Get current user profile
   */
  async me(): Promise<Profile | undefined> {
    return (await this.getAuthenticatedSession()).profile;
  }

  async getAuthenticatedSession(): Promise<AuthenticatedTwitterSession> {
    return this.withAuthenticatedSession(async (session) => session);
  }

  async withAuthenticatedSession<T>(
    operation: (session: AuthenticatedTwitterSession) => Promise<T>,
  ): Promise<T> {
    const pinned = this.sessionContext.getStore();
    if (pinned) {
      const profile = await this.profileFor(pinned);
      return operation({
        client: pinned.client,
        profile,
        revision: pinned.id,
      });
    }

    while (true) {
      const generation = await this.ensureClientInitialized();
      let profile: Profile;
      try {
        profile = await this.profileFor(generation);
      } catch (error) {
        if (this.isCurrent(generation)) throw error;
        continue;
      }
      if (!this.isCurrent(generation)) continue;
      return this.sessionContext.run(generation, () =>
        operation({
          client: generation.client,
          profile,
          revision: generation.id,
        }),
      );
    }
  }

  isAuthenticatedSessionCurrent(
    session: Pick<AuthenticatedTwitterSession, "client" | "revision">,
  ): boolean {
    return (
      !this.loggedOut &&
      this.generation?.id === session.revision &&
      this.generation.client === session.client
    );
  }

  async withCurrentSession<T>(
    session: Pick<AuthenticatedTwitterSession, "client" | "revision">,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runGenerationExclusive(async () => {
      if (!this.isAuthenticatedSessionCurrent(session)) {
        throw new ElizaError("X credentials rotated during identity refresh", {
          code: "X_AUTH_SESSION_ROTATED",
        });
      }
      return operation();
    });
  }

  /** Invalidates this credential object before a Client replaces it. */
  invalidate(): void {
    if (this.loggedOut) return;
    this.loggedOut = true;
    this.lifecycle += 1;
    this.generation = undefined;
    this.authenticated = false;
    this.initialization = undefined;
    this.profileCache = undefined;
    this.profileLoads.clear();
    this.fingerprintKey.fill(0);
  }

  /**
   * Logout (clear credentials)
   */
  async logout(): Promise<void> {
    this.invalidate();
    await this.runGenerationExclusive(async () => undefined);
  }

  hasToken(): boolean {
    return this.authenticated && !this.loggedOut;
  }
}
