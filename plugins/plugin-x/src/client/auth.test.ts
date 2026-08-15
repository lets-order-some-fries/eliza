/**
 * Exercises the production X credential-to-client/profile boundary with a
 * deterministic twitter-api-v2 constructor and rotating broker generations.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TwitterAuth } from "./auth";
import type {
  BrokerAuthCredentials,
  TwitterBrokerProvider,
} from "./auth-providers/types";
import { Client } from "./client";

const twitterApiHarness = vi.hoisted(() => {
  type ProfileResult =
    | Record<string, unknown>
    | Promise<Record<string, unknown>>;
  const profiles: Array<ProfileResult | (() => ProfileResult)> = [];
  const instances: Array<{
    credentials: unknown;
    me: ReturnType<typeof vi.fn>;
    value: { v2: { me: ReturnType<typeof vi.fn> } };
  }> = [];
  const twitterApiConstructor = vi.fn(function TwitterApiMock(
    credentials: unknown,
  ) {
    const profile = profiles[instances.length];
    if (!profile) {
      throw new Error("TwitterApiMock profile was not configured");
    }
    const me = vi.fn(async () => ({
      data: await (typeof profile === "function" ? profile() : profile),
    }));
    const value = { v2: { me } };
    instances.push({ credentials, me, value });
    return value;
  });

  return { instances, profiles, twitterApiConstructor };
});

vi.mock("twitter-api-v2", () => ({
  TwitterApi: twitterApiHarness.twitterApiConstructor,
}));

type OAuth1Credentials = Extract<BrokerAuthCredentials, { mode: "oauth1" }>;

function oauth1(
  overrides: Partial<Omit<OAuth1Credentials, "mode">> = {},
): OAuth1Credentials {
  return {
    mode: "oauth1",
    appKey: "app-key-one",
    appSecret: "app-secret-one",
    accessToken: "shared-access-token",
    accessSecret: "access-secret-one",
    ...overrides,
  };
}

function user(id: string) {
  return {
    id,
    username: `user-${id}`,
    name: `User ${id}`,
    description: `Profile ${id}`,
    profile_image_url: `https://example.com/${id}.jpg`,
    public_metrics: { followers_count: 1, following_count: 2 },
    verified: false,
    location: "",
    created_at: "2026-08-15T00:00:00.000Z",
  };
}

function rotatingBroker(initial: BrokerAuthCredentials) {
  let credentials = initial;
  const getBrokerCredentials = vi.fn(async () => credentials);
  const provider: TwitterBrokerProvider = {
    mode: "broker",
    getAccessToken: async () => credentials.accessToken,
    getBrokerCredentials,
  };

  return {
    getBrokerCredentials,
    provider,
    rotate(next: BrokerAuthCredentials) {
      credentials = next;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  twitterApiHarness.twitterApiConstructor.mockClear();
  twitterApiHarness.instances.length = 0;
  twitterApiHarness.profiles.length = 0;
});

describe("TwitterAuth credential rotation", () => {
  it("rebuilds for every OAuth1 secret or app credential change with the same access token", async () => {
    twitterApiHarness.profiles.push(
      user("one"),
      user("two"),
      user("three"),
      user("four"),
    );
    const broker = rotatingBroker(oauth1());
    const auth = new TwitterAuth(broker.provider);

    const clients = [await auth.getV2Client()];
    broker.rotate(oauth1({ appKey: "app-key-two" }));
    clients.push(await auth.getV2Client());
    broker.rotate(
      oauth1({ appKey: "app-key-two", appSecret: "app-secret-two" }),
    );
    clients.push(await auth.getV2Client());
    broker.rotate(
      oauth1({
        appKey: "app-key-two",
        appSecret: "app-secret-two",
        accessSecret: "access-secret-two",
      }),
    );
    clients.push(await auth.getV2Client());

    expect(new Set(clients).size).toBe(4);
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledTimes(4);
    expect(
      twitterApiHarness.instances.map(({ credentials }) => credentials),
    ).toEqual([
      expect.objectContaining({
        appKey: "app-key-one",
        appSecret: "app-secret-one",
        accessSecret: "access-secret-one",
        accessToken: "shared-access-token",
      }),
      expect.objectContaining({ appKey: "app-key-two" }),
      expect.objectContaining({ appSecret: "app-secret-two" }),
      expect.objectContaining({ accessSecret: "access-secret-two" }),
    ]);
  });

  it("rebuilds when the broker changes OAuth mode without changing the access token", async () => {
    twitterApiHarness.profiles.push(user("oauth1"), user("oauth2"));
    const broker = rotatingBroker(oauth1());
    const auth = new TwitterAuth(broker.provider);

    const oauth1Client = await auth.getV2Client();
    broker.rotate({ mode: "oauth2", accessToken: "shared-access-token" });
    const oauth2Client = await auth.getV2Client();

    expect(oauth2Client).not.toBe(oauth1Client);
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ accessToken: "shared-access-token" }),
    );
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenNthCalledWith(
      2,
      "shared-access-token",
    );
  });

  it("invalidates the cached profile on rotation but reuses it for identical credentials", async () => {
    twitterApiHarness.profiles.push(user("old-account"), user("new-account"));
    const broker = rotatingBroker(oauth1());
    const auth = new TwitterAuth(broker.provider);

    await expect(auth.me()).resolves.toMatchObject({ userId: "old-account" });
    await expect(auth.me()).resolves.toMatchObject({ userId: "old-account" });
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledTimes(1);
    expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledTimes(1);

    broker.rotate(oauth1({ accessSecret: "access-secret-two" }));
    await expect(auth.me()).resolves.toMatchObject({ userId: "new-account" });

    expect(broker.getBrokerCredentials).toHaveBeenCalledTimes(3);
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledTimes(2);
    expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledTimes(1);
    expect(twitterApiHarness.instances[1]?.me).toHaveBeenCalledTimes(1);
  });

  it("stores only a fixed-length digest for credential equality", async () => {
    twitterApiHarness.profiles.push(user("one"));
    const credentials = oauth1();
    const auth = new TwitterAuth(rotatingBroker(credentials).provider);

    await auth.getV2Client();

    const fingerprint = (
      auth as unknown as { generation?: { fingerprint?: string } }
    ).generation?.fingerprint;
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    for (const secret of [
      credentials.appKey,
      credentials.appSecret,
      credentials.accessToken,
      credentials.accessSecret,
    ]) {
      expect(fingerprint).not.toContain(secret);
    }
  });

  it("serializes concurrent initialization and profile loading", async () => {
    twitterApiHarness.profiles.push(user("one"));
    const broker = rotatingBroker(oauth1());
    const auth = new TwitterAuth(broker.provider);

    const clients = await Promise.all([
      auth.getV2Client(),
      auth.getV2Client(),
      auth.getV2Client(),
    ]);
    expect(new Set(clients).size).toBe(1);
    expect(broker.getBrokerCredentials).toHaveBeenCalledOnce();
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledOnce();

    const profiles = await Promise.all([auth.me(), auth.me()]);
    expect(profiles).toEqual([
      expect.objectContaining({ userId: "one" }),
      expect.objectContaining({ userId: "one" }),
    ]);
    expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledOnce();
  });

  it("never resurrects a profile that resolves after rotation", async () => {
    const oldProfile = deferred<Record<string, unknown>>();
    twitterApiHarness.profiles.push(oldProfile.promise, user("new-account"));
    const broker = rotatingBroker(oauth1());
    const auth = new TwitterAuth(broker.provider);

    const startedBeforeRotation = auth.me();
    await vi.waitFor(() =>
      expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledOnce(),
    );

    broker.rotate(oauth1({ accessSecret: "rotated-secret" }));
    const current = auth.me();
    await expect(current).resolves.toMatchObject({ userId: "new-account" });

    oldProfile.resolve(user("old-account"));
    await expect(startedBeforeRotation).resolves.toMatchObject({
      userId: "new-account",
    });
    expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledOnce();
    expect(twitterApiHarness.instances[1]?.me).toHaveBeenCalledOnce();
  });

  it("ignores a stale profile failure after rotation", async () => {
    const oldProfile = deferred<Record<string, unknown>>();
    twitterApiHarness.profiles.push(oldProfile.promise, user("new-account"));
    const broker = rotatingBroker(oauth1());
    const auth = new TwitterAuth(broker.provider);

    const startedBeforeRotation = auth.me();
    await vi.waitFor(() =>
      expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledOnce(),
    );
    broker.rotate(oauth1({ accessSecret: "rotated-secret" }));
    await expect(auth.me()).resolves.toMatchObject({ userId: "new-account" });

    oldProfile.reject(new Error("old credential rejected"));
    await expect(startedBeforeRotation).resolves.toMatchObject({
      userId: "new-account",
    });
  });

  it("pins one operation to its captured generation without replaying failures after rotation", async () => {
    twitterApiHarness.profiles.push(user("account-a"), user("account-b"));
    const broker = rotatingBroker(oauth1());
    const auth = new TwitterAuth(broker.provider);
    const operationStarted = deferred<void>();
    const finishOperation = deferred<void>();
    const failure = new Error("local persistence failed after the X write");
    const operation = vi.fn(async (session: { client: unknown }) => {
      operationStarted.resolve();
      await finishOperation.promise;
      expect(await auth.getV2Client()).toBe(session.client);
      throw failure;
    });

    const accountAOperation = auth.withAuthenticatedSession(operation);
    await operationStarted.promise;

    broker.rotate(oauth1({ accessSecret: "account-b-secret" }));
    await expect(auth.me()).resolves.toMatchObject({ userId: "account-b" });

    finishOperation.resolve();
    await expect(accountAOperation).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledOnce();
    expect(operation.mock.calls[0]?.[0]).toMatchObject({
      profile: { userId: "account-a" },
    });
  });

  it("prevents ABA profile resurrection with credential generations", async () => {
    const firstA = deferred<Record<string, unknown>>();
    twitterApiHarness.profiles.push(
      firstA.promise,
      user("account-b"),
      user("account-a-current"),
    );
    const credentialsA = oauth1();
    const broker = rotatingBroker(credentialsA);
    const auth = new TwitterAuth(broker.provider);

    const staleA = auth.me();
    await vi.waitFor(() =>
      expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledOnce(),
    );
    broker.rotate(oauth1({ accessSecret: "account-b-secret" }));
    await expect(auth.me()).resolves.toMatchObject({ userId: "account-b" });
    broker.rotate(credentialsA);
    await expect(auth.me()).resolves.toMatchObject({
      userId: "account-a-current",
    });

    firstA.resolve(user("account-a-stale"));
    await expect(staleA).resolves.toMatchObject({
      userId: "account-a-current",
    });
  });

  it("retries a current-generation profile failure without exposing credential text", async () => {
    const profile = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockRejectedValueOnce(new Error("access-secret-one rejected"))
      .mockResolvedValueOnce(user("recovered"));
    twitterApiHarness.profiles.push(profile);
    const auth = new TwitterAuth(rotatingBroker(oauth1()).provider);

    const firstError = await auth.me().catch((error: unknown) => error);
    expect(firstError).toMatchObject({ code: "X_ME_FETCH_FAILED" });
    expect(String((firstError as Error).message)).not.toContain(
      "access-secret-one",
    );
    expect((firstError as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(firstError)).not.toContain("access-secret-one");
    await expect(auth.me()).resolves.toMatchObject({ userId: "recovered" });
    expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: "401", fields: { code: 401 } },
    { label: "403", fields: { code: 403 } },
    { label: "provider auth marker", fields: { code: 400, isAuthError: true } },
  ])(
    "classifies an X $label profile response as rejected credentials without retaining provider details",
    async ({ fields }) => {
      const providerError = Object.assign(
        new Error("access-secret-one rejected"),
        fields,
      );
      twitterApiHarness.profiles.push(() => Promise.reject(providerError));
      const auth = new TwitterAuth(rotatingBroker(oauth1()).provider);

      const error = await auth.me().catch((cause: unknown) => cause);

      expect(error).toMatchObject({ code: "X_AUTH_REJECTED" });
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain("access-secret-one");
    },
  );

  it("keeps rate limits and provider outages distinct from credential rejection", async () => {
    const providerError = Object.assign(
      new Error("access-secret-one provider overloaded"),
      { code: 429 },
    );
    twitterApiHarness.profiles.push(() => Promise.reject(providerError));
    const auth = new TwitterAuth(rotatingBroker(oauth1()).provider);

    const error = await auth.me().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "X_ME_FETCH_FAILED" });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String((error as Error).message)).not.toContain("access-secret-one");
    expect(JSON.stringify(error)).not.toContain("access-secret-one");
  });

  it("clears a rejected initialization flight so the next call can retry", async () => {
    twitterApiHarness.profiles.push(user("one"));
    const getBrokerCredentials = vi
      .fn<() => Promise<BrokerAuthCredentials>>()
      .mockRejectedValueOnce(new Error("broker unavailable"))
      .mockResolvedValueOnce(oauth1());
    const provider: TwitterBrokerProvider = {
      mode: "broker",
      getAccessToken: async () => "shared-access-token",
      getBrokerCredentials,
    };
    const auth = new TwitterAuth(provider);

    const initializationError = await auth
      .getV2Client()
      .catch((error: unknown) => error);
    expect(initializationError).toMatchObject({
      code: "X_AUTH_INITIALIZATION_FAILED",
      message: "Failed to resolve X credentials",
    });
    expect(
      (initializationError as Error & { cause?: unknown }).cause,
    ).toBeUndefined();
    expect(JSON.stringify(initializationError)).not.toContain(
      "broker unavailable",
    );
    await expect(auth.getV2Client()).resolves.toBeDefined();
    expect(getBrokerCredentials).toHaveBeenCalledTimes(2);
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledOnce();
  });

  it("cannot construct a client after logout wins credential resolution", async () => {
    const credentials = deferred<BrokerAuthCredentials>();
    const provider: TwitterBrokerProvider = {
      mode: "broker",
      getAccessToken: async () => "shared-access-token",
      getBrokerCredentials: vi.fn(() => credentials.promise),
    };
    const auth = new TwitterAuth(provider);

    const initialization = auth.getV2Client();
    await vi.waitFor(() =>
      expect(provider.getBrokerCredentials).toHaveBeenCalledOnce(),
    );
    await auth.logout();
    credentials.resolve(oauth1());

    await expect(initialization).rejects.toThrow(
      "Twitter API client not initialized",
    );
    expect(twitterApiHarness.twitterApiConstructor).not.toHaveBeenCalled();
  });

  it("cannot return or cache a profile after logout wins profile resolution", async () => {
    const profile = deferred<Record<string, unknown>>();
    twitterApiHarness.profiles.push(profile.promise);
    const auth = new TwitterAuth(rotatingBroker(oauth1()).provider);

    const pendingProfile = auth.me();
    await vi.waitFor(() =>
      expect(twitterApiHarness.instances[0]?.me).toHaveBeenCalledOnce(),
    );
    await auth.logout();
    profile.resolve(user("stale"));

    await expect(pendingProfile).rejects.toThrow(
      "Twitter API client not initialized",
    );
    await expect(auth.me()).rejects.toThrow(
      "Twitter API client not initialized",
    );
  });

  it("public Client.logout invalidates its TwitterAuth", async () => {
    twitterApiHarness.profiles.push(user("one"));
    const auth = new TwitterAuth(rotatingBroker(oauth1()).provider);
    const client = new Client();
    client.updateAuth(auth);

    await client.getV2Client();
    await client.logout();

    expect(client.getAuth()).toBeNull();
    expect(client.isAuthenticated()).toBe(false);
    await expect(auth.getV2Client()).rejects.toThrow(
      "Twitter API client not initialized",
    );
    await expect(client.getV2Client()).rejects.toThrow("Not authenticated");
  });

  it("invalidates the prior TwitterAuth when Client credentials are replaced", async () => {
    twitterApiHarness.profiles.push(user("old"), user("new"));
    const oldAuth = new TwitterAuth(rotatingBroker(oauth1()).provider);
    const newAuth = new TwitterAuth(
      rotatingBroker(oauth1({ accessSecret: "new-secret" })).provider,
    );
    const client = new Client();
    client.updateAuth(oldAuth);
    await expect(client.me()).resolves.toMatchObject({ userId: "old" });

    client.updateAuth(newAuth);

    await expect(oldAuth.getV2Client()).rejects.toMatchObject({
      code: "X_AUTH_NOT_INITIALIZED",
    });
    await expect(client.me()).resolves.toMatchObject({ userId: "new" });
  });

  it("never switches an in-flight Client operation from account A to replacement account B", async () => {
    twitterApiHarness.profiles.push(user("account-a"), user("account-b"));
    const accountAAuth = new TwitterAuth(rotatingBroker(oauth1()).provider);
    const accountBAuth = new TwitterAuth(
      rotatingBroker(oauth1({ accessSecret: "account-b-secret" })).provider,
    );
    const client = new Client();
    client.updateAuth(accountAAuth);
    const operationStarted = deferred<void>();
    const resumeOperation = deferred<void>();
    const operation = client.withAuthenticatedSession(async (session) => {
      expect(session.profile.userId).toBe("account-a");
      operationStarted.resolve();
      await resumeOperation.promise;
      return client.getV2Client();
    });
    await operationStarted.promise;

    client.updateAuth(accountBAuth);
    resumeOperation.resolve();

    await expect(operation).rejects.toMatchObject({
      code: "X_AUTH_NOT_INITIALIZED",
    });
    await expect(client.me()).resolves.toMatchObject({ userId: "account-b" });
    expect(twitterApiHarness.twitterApiConstructor).toHaveBeenCalledTimes(2);
  });
});
