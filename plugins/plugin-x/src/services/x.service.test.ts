/** Verifies credential-bound X identity, multi-account attribution, and connector routing through deterministic provider fakes. */
import {
  type Content,
  createUniqueUuid,
  ElizaError,
  type IAgentRuntime,
  type TargetInfo,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClientBase,
  type TwitterAccountSession,
  type TwitterProfile,
} from "../base";
import type { TwitterClientState } from "../types";
import { TwitterPostService } from "./PostService";
import { TwitterClientInstance, XService } from "./x.service";

type RawProfile = {
  userId: string;
  username: string;
  name: string;
  biography: string;
};

const CURRENT_PROFILE: TwitterProfile = {
  id: "account-b",
  username: "current-b",
  screenName: "Current B",
  bio: "",
  nicknames: [],
};

function asRuntime<T extends object>(runtime: T): IAgentRuntime & T {
  return runtime as IAgentRuntime & T;
}

function runtimeWithSettings(settings: Record<string, string>): IAgentRuntime {
  return asRuntime({
    agentId: "agent-1",
    getSetting: (key: string) => settings[key],
    reportError: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  });
}

function serviceWithRuntime(settings: Record<string, string>): XService {
  return new XService(runtimeWithSettings(settings));
}

function attachRawSession(
  base: ClientBase,
  profile: RawProfile,
  options: {
    apiClient?: object;
    revision?: number;
    isCurrent?: () => boolean;
  } = {},
): void {
  const apiClient = options.apiClient ?? {};
  const revision = options.revision ?? 1;
  base.twitterClient = {
    withAuthenticatedSession: vi.fn(
      async (
        operation: (session: {
          client: object;
          profile: RawProfile;
          revision: number;
        }) => Promise<unknown>,
      ) => operation({ client: apiClient, profile, revision }),
    ),
    withCurrentSession: vi.fn(
      async (_session: unknown, operation: () => Promise<unknown>) =>
        operation(),
    ),
    isAuthenticatedSessionCurrent: vi.fn(options.isCurrent ?? (() => true)),
  } as unknown as ClientBase["twitterClient"];
}

function makeSessionBase(
  profile: TwitterProfile,
  apiClient: object = {},
  extra: Record<string, unknown> = {},
): ClientBase {
  const session = {
    client: apiClient,
    profile,
    revision: 2,
  } as unknown as TwitterAccountSession;
  return {
    runtime: runtimeWithSettings({}),
    withAuthenticatedSession: vi.fn(
      async (operation: (value: TwitterAccountSession) => Promise<unknown>) =>
        operation(session),
    ),
    isAuthenticatedSessionCurrent: vi.fn(() => true),
    ...extra,
  } as unknown as ClientBase;
}

function stubAccountClient(service: XService, base: ClientBase) {
  return vi
    .spyOn(
      service as unknown as {
        getTwitterClientForAccount: (
          accountId: unknown,
        ) => Promise<{ client: ClientBase }>;
      },
      "getTwitterClientForAccount",
    )
    .mockResolvedValue({ client: base });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ClientBase authenticated identity", () => {
  it("publishes only the default account while a secondary account keeps local identity and cursor state", async () => {
    let entity = {
      id: "agent-1",
      names: ["Agent"],
      metadata: {},
      agentId: "agent-1",
    };
    const getEntityById = vi.fn(async () => entity);
    const updateEntity = vi.fn(async (next: typeof entity) => {
      entity = next;
    });
    const getCache = vi.fn(async (key: string) =>
      key === "twitter/secondary/secondary-user/latest_checked_tweet_id"
        ? "88"
        : undefined,
    );
    const runtime = asRuntime({
      agentId: "agent-1",
      character: { name: "Agent" },
      getSetting: () => undefined,
      getEntityById,
      updateEntity,
      getCache,
      setCache: vi.fn(),
    });

    const defaultClient = new ClientBase(runtime, {
      accountId: "default",
    } as TwitterClientState);
    attachRawSession(defaultClient, {
      userId: "default-user",
      username: "default-name",
      name: "Default Name",
      biography: "default bio",
    });
    await expect(
      defaultClient.getAuthenticatedProfile(),
    ).resolves.toMatchObject({ id: "default-user", username: "default-name" });
    expect(getEntityById).toHaveBeenCalledOnce();
    expect(updateEntity).toHaveBeenCalledOnce();
    expect(entity).toMatchObject({
      metadata: {
        twitter: {
          id: "default-user",
          userName: "default-name",
          name: "Default Name",
        },
      },
    });

    getEntityById.mockClear();
    updateEntity.mockClear();
    const secondaryClient = new ClientBase(
      runtime,
      { accountId: "secondary" } as TwitterClientState,
      { publishLegacyIdentity: false },
    );
    attachRawSession(secondaryClient, {
      userId: "secondary-user",
      username: "secondary-name",
      name: "Secondary Name",
      biography: "secondary bio",
    });

    await expect(
      secondaryClient.getAuthenticatedProfile(),
    ).resolves.toMatchObject({
      id: "secondary-user",
      username: "secondary-name",
    });
    expect(secondaryClient.profile).toMatchObject({ id: "secondary-user" });
    expect(secondaryClient.lastCheckedTweetId).toBe(88n);
    expect(getEntityById).not.toHaveBeenCalled();
    expect(updateEntity).not.toHaveBeenCalled();
    expect(getCache).toHaveBeenCalledWith(
      "twitter/secondary/secondary-user/latest_checked_tweet_id",
    );
    expect(defaultClient.identityCacheKey(CURRENT_PROFILE, "cursor")).toBe(
      "twitter/default/account-b/cursor",
    );
    expect(secondaryClient.identityCacheKey(CURRENT_PROFILE, "cursor")).toBe(
      "twitter/secondary/account-b/cursor",
    );
  });

  it("migrates a same-user cursor from the prior username into the canonical account-and-id key", async () => {
    const canonicalKey = "twitter/default/same-user/latest_checked_tweet_id";
    const legacyKey = "twitter/old-name/latest_checked_tweet_id";
    const entity = {
      id: "agent-1",
      names: ["Agent", "Old Name", "old-name"],
      metadata: {
        twitter: {
          id: "same-user",
          userName: "old-name",
          name: "Old Name",
        },
      },
      agentId: "agent-1",
    };
    const getCache = vi.fn(async (key: string) =>
      key === legacyKey ? "42" : undefined,
    );
    const setCache = vi.fn();
    const runtime = asRuntime({
      agentId: "agent-1",
      character: { name: "Agent" },
      getSetting: () => undefined,
      getEntityById: vi.fn(async () => entity),
      updateEntity: vi.fn(),
      getCache,
      setCache,
    });
    const client = new ClientBase(runtime, {
      accountId: "default",
    } as TwitterClientState);
    attachRawSession(client, {
      userId: "same-user",
      username: "new-name",
      name: "New Name",
      biography: "",
    });

    await client.getAuthenticatedProfile();

    expect(getCache).toHaveBeenCalledWith(canonicalKey);
    expect(getCache).toHaveBeenCalledWith(legacyKey);
    expect(setCache).toHaveBeenCalledWith(canonicalKey, "42");
    expect(client.lastCheckedTweetId).toBe(42n);
  });

  it("clears its compatibility profile after any authenticated refresh failure", async () => {
    const entity = {
      id: "agent-1",
      names: ["Agent", "Current B", "current-b"],
      metadata: {
        twitter: {
          id: "account-b",
          userName: "current-b",
          name: "Current B",
        },
      },
      agentId: "agent-1",
    };
    const runtime = asRuntime({
      agentId: "agent-1",
      character: { name: "Agent" },
      getSetting: () => undefined,
      getEntityById: vi.fn(async () => entity),
      updateEntity: vi.fn(),
      getCache: vi.fn(async () => undefined),
      setCache: vi.fn(),
    });
    const client = new ClientBase(runtime, {
      accountId: "default",
    } as TwitterClientState);
    attachRawSession(client, {
      userId: "account-b",
      username: "current-b",
      name: "Current B",
      biography: "",
    });
    await client.getAuthenticatedProfile();
    expect(client.profile).toMatchObject({ id: "account-b" });

    const refreshFailure = new ElizaError("profile provider unavailable", {
      code: "X_ME_FETCH_FAILED",
    });
    client.twitterClient.withAuthenticatedSession = vi.fn(async () => {
      throw refreshFailure;
    });

    await expect(client.getAuthenticatedProfile()).rejects.toBe(refreshFailure);
    expect(client.profile).toBeNull();
  });

  it("does not publish a new account after durable identity metadata fails to update", async () => {
    const entity = {
      id: "agent-1",
      names: ["Agent", "Account A", "account-a"],
      metadata: {
        twitter: {
          id: "account-a",
          userName: "account-a",
          name: "Account A",
        },
      },
      agentId: "agent-1",
    };
    const updateFailure = new Error("entity store unavailable");
    const runtime = asRuntime({
      agentId: "agent-1",
      character: { name: "Agent" },
      getSetting: () => undefined,
      getEntityById: vi.fn(async () => entity),
      updateEntity: vi.fn(async () => {
        throw updateFailure;
      }),
      getCache: vi.fn(async () => undefined),
      setCache: vi.fn(),
    });
    const client = new ClientBase(runtime, {
      accountId: "default",
    } as TwitterClientState);
    attachRawSession(client, {
      userId: "account-b",
      username: "account-b",
      name: "Account B",
      biography: "B",
    });

    await expect(client.getAuthenticatedProfile()).rejects.toBe(updateFailure);
    expect(client.profile).toBeNull();
    expect(entity).toMatchObject({
      names: ["Agent", "Account A", "account-a"],
      metadata: { twitter: { id: "account-a" } },
    });
  });
});

describe("XService account status and registration", () => {
  it("honors account-scoped DM disablement over the runtime default", () => {
    const instance = new TwitterClientInstance(
      runtimeWithSettings({ TWITTER_ENABLE_DMS: "true" }),
      {
        accountId: "personal",
        TWITTER_ENABLE_DMS: "false",
      } as TwitterClientState,
    );

    expect(instance.directMessages).toBeUndefined();
  });

  it("registers trusted account routing for both connector surfaces", () => {
    const registerMessageConnector = vi.fn();
    const registerPostConnector = vi.fn();
    const runtime = asRuntime({
      ...runtimeWithSettings({}),
      registerMessageConnector,
      registerPostConnector,
      registerSendHandler: vi.fn(),
    });
    const service = new XService(runtime);

    XService.registerSendHandlers(runtime, service);
    (
      service as unknown as {
        registerPostConnector(runtime: IAgentRuntime): void;
      }
    ).registerPostConnector(runtime);

    expect(registerMessageConnector).toHaveBeenCalledWith(
      expect.objectContaining({ source: "x", accountRouting: "connector" }),
    );
    expect(registerPostConnector).toHaveBeenCalledWith(
      expect.objectContaining({ source: "x", accountRouting: "connector" }),
    );
  });

  it("reports config_missing when env auth credentials are absent", async () => {
    const service = serviceWithRuntime({ TWITTER_AUTH_MODE: "env" });

    await expect(service.getAccountStatus("default")).resolves.toMatchObject({
      accountId: "default",
      configured: false,
      connected: false,
      reason: "config_missing",
      grantedCapabilities: [],
      grantedScopes: [],
      authMode: "env",
    });
  });

  it("reports account-scoped env capabilities without a network call", async () => {
    const service = serviceWithRuntime({
      TWITTER_AUTH_MODE: "env",
      TWITTER_API_KEY: "api-key",
      TWITTER_API_SECRET_KEY: "api-secret",
      TWITTER_ACCESS_TOKEN: "access-token",
      TWITTER_ACCESS_TOKEN_SECRET: "access-secret",
    });

    await expect(service.getAccountStatus("primary")).resolves.toMatchObject({
      accountId: "primary",
      configured: true,
      connected: true,
      reason: "connected",
      grantedCapabilities: ["x.read", "x.write", "x.dm.read", "x.dm.write"],
      authMode: "env",
    });
  });

  it("maps OAuth scopes into X capabilities", async () => {
    const service = serviceWithRuntime({
      TWITTER_AUTH_MODE: "oauth",
      TWITTER_CLIENT_ID: "client-id",
      TWITTER_REDIRECT_URI: "http://127.0.0.1:8080/callback",
      TWITTER_SCOPES: "tweet.read users.read dm.read",
    });

    await expect(
      service.getAccountStatus("oauth-account"),
    ).resolves.toMatchObject({
      accountId: "oauth-account",
      configured: true,
      connected: true,
      grantedCapabilities: ["x.read", "x.dm.read"],
      grantedScopes: ["tweet.read", "users.read", "dm.read"],
      authMode: "oauth",
    });
  });

  it("refreshes a loaded account before exposing its identity", async () => {
    const service = serviceWithRuntime({ TWITTER_AUTH_MODE: "broker" });
    const getAuthenticatedProfile = vi.fn(async () => CURRENT_PROFILE);
    (
      service as unknown as {
        accountClients: Map<
          string,
          {
            accountId: string;
            client: {
              profile: TwitterProfile;
              getAuthenticatedProfile: typeof getAuthenticatedProfile;
            };
          }
        >;
      }
    ).accountClients.set("default", {
      accountId: "default",
      client: { profile: CURRENT_PROFILE, getAuthenticatedProfile },
    });

    await expect(service.getAccountStatus("default")).resolves.toMatchObject({
      connected: true,
      reason: "connected",
      identity: {
        userId: "account-b",
        username: "current-b",
        name: "Current B",
      },
    });
    expect(getAuthenticatedProfile).toHaveBeenCalledOnce();
  });

  it("reports needs_reauth instead of stale identity after auth rejection", async () => {
    const service = serviceWithRuntime({ TWITTER_AUTH_MODE: "broker" });
    const authFailure = new ElizaError("credentials rejected", {
      code: "X_AUTH_REJECTED",
    });
    const getAuthenticatedProfile = vi.fn(async () => {
      throw authFailure;
    });
    (
      service as unknown as {
        accountClients: Map<
          string,
          {
            accountId: string;
            client: { getAuthenticatedProfile: typeof getAuthenticatedProfile };
          }
        >;
      }
    ).accountClients.set("default", {
      accountId: "default",
      client: { getAuthenticatedProfile },
    });

    await expect(service.getAccountStatus("default")).resolves.toMatchObject({
      configured: true,
      connected: false,
      reason: "needs_reauth",
      identity: null,
      grantedCapabilities: [],
      grantedScopes: [],
    });
  });

  it("propagates provider failures instead of misreporting reauthentication", async () => {
    const service = serviceWithRuntime({ TWITTER_AUTH_MODE: "broker" });
    const providerFailure = new ElizaError("profile provider unavailable", {
      code: "X_ME_FETCH_FAILED",
    });
    const getAuthenticatedProfile = vi.fn(async () => {
      throw providerFailure;
    });
    (
      service as unknown as {
        accountClients: Map<
          string,
          {
            accountId: string;
            client: { getAuthenticatedProfile: typeof getAuthenticatedProfile };
          }
        >;
      }
    ).accountClients.set("default", {
      accountId: "default",
      client: { getAuthenticatedProfile },
    });

    await expect(service.getAccountStatus("default")).rejects.toBe(
      providerFailure,
    );
  });
});

describe("XService trusted account routing and attribution", () => {
  it("returns an own-post memory bound to the admitted profile", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const base = makeSessionBase(CURRENT_PROFILE);
    const getClient = stubAccountClient(service, base);
    const roomId = createUniqueUuid(
      runtime,
      `x:default:feed:${CURRENT_PROFILE.id}`,
    );
    const createPost = vi
      .spyOn(TwitterPostService.prototype, "createPost")
      .mockResolvedValue({
        id: "tweet-b",
        agentId: runtime.agentId,
        roomId,
        userId: CURRENT_PROFILE.id,
        username: CURRENT_PROFILE.username,
        text: "hello from b",
        timestamp: 1_786_800_000_000,
        metrics: {
          likes: 0,
          reposts: 0,
          replies: 0,
          quotes: 0,
          views: 0,
        },
        media: [],
        metadata: {},
      });

    const memory = await service.handleSendPost(runtime, {
      text: "hello from b",
      metadata: { accountId: "secondary" },
    });

    expect(getClient).toHaveBeenCalledWith("default");
    expect(createPost).toHaveBeenCalledWith(
      expect.objectContaining({ roomId, text: "hello from b" }),
      CURRENT_PROFILE,
    );
    expect(memory).toMatchObject({
      entityId: runtime.agentId,
      roomId,
      metadata: {
        accountId: "default",
        fromBot: true,
        sender: { id: "account-b", username: "current-b" },
        x: { userId: "account-b", username: "current-b" },
      },
    });
  });

  it("honors trusted context-scoped post routing", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const base = makeSessionBase(CURRENT_PROFILE);
    const getClient = stubAccountClient(service, base);
    vi.spyOn(TwitterPostService.prototype, "createPost").mockResolvedValue({
      id: "tweet-secondary",
      agentId: runtime.agentId,
      roomId: createUniqueUuid(
        runtime,
        `x:secondary:feed:${CURRENT_PROFILE.id}`,
      ),
      userId: CURRENT_PROFILE.id,
      username: CURRENT_PROFILE.username,
      text: "trusted secondary",
      timestamp: 1_786_800_000_000,
      metadata: {},
    });

    const memory = await service.handleSendPost(
      runtime,
      { text: "trusted secondary" },
      {
        runtime,
        source: "x",
        accountId: "secondary",
        target: { source: "x", accountId: "secondary" } as TargetInfo,
      },
    );

    expect(getClient).toHaveBeenCalledWith("secondary");
    expect(memory).toMatchObject({
      metadata: { accountId: "secondary", fromBot: true },
    });
  });

  it("attributes own and external feed rows using the current account id", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const base = makeSessionBase(CURRENT_PROFILE);
    stubAccountClient(service, base);
    vi.spyOn(TwitterPostService.prototype, "getPosts").mockResolvedValue([
      {
        id: "own-feed",
        agentId: runtime.agentId,
        roomId: createUniqueUuid(runtime, "own-conversation"),
        userId: "account-b",
        username: "current-b",
        text: "mine",
        timestamp: 1_786_800_000_000,
        metadata: { conversationId: "own-conversation" },
      },
      {
        id: "external-feed",
        agentId: runtime.agentId,
        roomId: createUniqueUuid(runtime, "external-conversation"),
        userId: "person-1",
        username: "person-one",
        text: "theirs",
        timestamp: 1_786_800_001_000,
        metadata: { conversationId: "external-conversation" },
      },
    ]);

    const memories = await service.fetchConnectorFeed(
      { runtime, source: "x", accountId: "secondary" },
      {},
    );

    expect(memories).toHaveLength(2);
    expect(memories[0]).toMatchObject({
      entityId: runtime.agentId,
      metadata: { accountId: "secondary", fromBot: true },
    });
    expect(memories[1]).toMatchObject({
      entityId: createUniqueUuid(runtime, "person-1"),
      metadata: { accountId: "secondary", fromBot: false },
    });
  });

  it("attributes own and external search rows using the current account id", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const fetchSearchTweets = vi.fn(async () => ({
      tweets: [
        {
          id: "own-search",
          userId: "account-b",
          username: "current-b",
          text: "mine",
          timestamp: 1_786_800_000_000,
          conversationId: "own-search-conversation",
        },
        {
          id: "external-search",
          userId: "person-2",
          username: "person-two",
          text: "theirs",
          timestamp: 1_786_800_001_000,
          conversationId: "external-search-conversation",
        },
      ],
    }));
    const base = makeSessionBase(CURRENT_PROFILE, {}, { fetchSearchTweets });
    const getClient = stubAccountClient(service, base);

    const memories = await service.searchConnectorPosts(
      { runtime, source: "x", accountId: "secondary" },
      { query: "identity" },
    );

    expect(getClient).toHaveBeenCalledWith("secondary");
    expect(fetchSearchTweets).toHaveBeenCalledWith(
      "identity",
      20,
      expect.anything(),
      undefined,
    );
    expect(memories[0]).toMatchObject({
      entityId: runtime.agentId,
      metadata: { accountId: "secondary", fromBot: true },
    });
    expect(memories[1]).toMatchObject({
      entityId: createUniqueUuid(runtime, "person-2"),
      metadata: { accountId: "secondary", fromBot: false },
    });
  });

  it("maps inbound and outbound DMs into one conversation while filtering by counterparty", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const events = [
      {
        id: "dm-in",
        dm_conversation_id: "conversation-1",
        sender_id: "person-1",
        text: "hello in",
        created_at: "2026-08-15T10:00:00.000Z",
        event_type: "MessageCreate",
        participant_ids: ["account-b", "person-1"],
      },
      {
        id: "dm-out",
        dm_conversation_id: "conversation-1",
        sender_id: "account-b",
        text: "hello out",
        created_at: "2026-08-15T10:01:00.000Z",
        event_type: "MessageCreate",
        participant_ids: ["account-b", "person-1"],
      },
      {
        id: "dm-other",
        dm_conversation_id: "conversation-2",
        sender_id: "person-2",
        text: "unrelated",
        created_at: "2026-08-15T10:02:00.000Z",
        event_type: "MessageCreate",
        participant_ids: ["account-b", "person-2"],
      },
    ];
    const listDmEvents = vi.fn(() => ({
      includes: {
        users: [
          { id: "account-b", username: "current-b" },
          { id: "person-1", username: "person-one" },
          { id: "person-2", username: "person-two" },
        ],
      },
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    }));
    const base = makeSessionBase(CURRENT_PROFILE, {
      v2: { listDmEvents },
    });
    stubAccountClient(service, base);
    const target = {
      source: "x",
      accountId: "secondary",
      entityId: "person-1",
    } as TargetInfo;

    const memories = await service.fetchConnectorMessages(
      { runtime, source: "x", target },
      { target },
    );

    expect(memories).toHaveLength(2);
    expect(memories[0]).toMatchObject({
      entityId: createUniqueUuid(runtime, "person-1"),
      roomId: createUniqueUuid(runtime, "x-dm:secondary:conversation-1"),
      metadata: {
        accountId: "secondary",
        fromBot: false,
        x: { isInbound: true, senderId: "person-1" },
      },
    });
    expect(memories[1]).toMatchObject({
      entityId: runtime.agentId,
      roomId: memories[0].roomId,
      metadata: {
        accountId: "secondary",
        fromBot: true,
        x: { isInbound: false, senderId: "account-b" },
      },
    });

    const recentTargets = await service.listRecentConnectorTargets({
      runtime,
      source: "x",
      target: { source: "x", accountId: "secondary" } as TargetInfo,
    });
    expect(recentTargets[0]).toMatchObject({
      label: "@person-one",
      target: { entityId: "person-1", accountId: "secondary" },
    });
  });

  it("rechecks the admitted session after username recipient resolution", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const lookupStarted = deferred<void>();
    const lookupResult = deferred<{ id: string }>();
    let current = true;
    const sendDmToParticipant = vi.fn();
    const base = makeSessionBase(
      CURRENT_PROFILE,
      { v2: { sendDmToParticipant } },
      {
        fetchProfile: vi.fn(async () => {
          lookupStarted.resolve();
          return lookupResult.promise;
        }),
        isAuthenticatedSessionCurrent: vi.fn(() => current),
      },
    );
    stubAccountClient(service, base);

    const sending = service.handleSendMessage(
      runtime,
      {
        source: "x",
        accountId: "secondary",
        entityId: "@person-one",
      } as TargetInfo,
      { text: "hello" } as Content,
    );
    await lookupStarted.promise;
    current = false;
    lookupResult.resolve({ id: "person-1" });

    await expect(sending).rejects.toMatchObject({
      code: "X_AUTH_SESSION_ROTATED",
    });
    expect(sendDmToParticipant).not.toHaveBeenCalled();
  });

  it("ignores spoofed content account metadata in the unscoped send handler", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const sendDmToParticipant = vi.fn(async () => ({ dm_event_id: "dm-1" }));
    const base = makeSessionBase(CURRENT_PROFILE, {
      v2: { sendDmToParticipant },
    });
    const getClient = stubAccountClient(service, base);

    await service.handleSendMessage(
      runtime,
      { source: "x", entityId: "123456" } as TargetInfo,
      {
        text: "hello",
        metadata: { accountId: "secondary" },
      } as Content,
    );

    expect(getClient).toHaveBeenCalledWith("default");
    expect(sendDmToParticipant).toHaveBeenCalledWith("123456", {
      text: "hello",
    });
  });
});

describe("XService profile lookup failure boundaries", () => {
  it("routes connector user context through the trusted account id", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const getScreenNameByUserId = vi.fn(async () => "secondary-user");
    const base = {
      twitterClient: { getScreenNameByUserId },
    } as unknown as ClientBase;
    const getClient = stubAccountClient(service, base);

    const result = await service.getConnectorUserContext("123456", {
      runtime,
      source: "x",
      accountId: "secondary",
      target: { source: "x", accountId: "secondary" } as TargetInfo,
    });

    expect(getClient).toHaveBeenCalledWith("secondary");
    expect(result).toMatchObject({
      entityId: "123456",
      label: "@secondary-user",
      metadata: { accountId: "secondary" },
    });
  });

  it("degrades target resolution only for an explicit profile-not-found error", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const notFound = new ElizaError("missing", {
      code: "X_PROFILE_NOT_FOUND",
    });
    const base = {
      fetchProfile: vi.fn().mockRejectedValue(notFound),
    } as unknown as ClientBase;
    stubAccountClient(service, base);

    await expect(
      service.resolveConnectorTargets("missing-user", {
        runtime,
        source: "x",
        accountId: "secondary",
      }),
    ).resolves.toEqual([]);
  });

  it.each([
    new ElizaError("auth rejected", { code: "X_AUTH_REJECTED" }),
    new ElizaError("session rotated", { code: "X_AUTH_SESSION_ROTATED" }),
    { status: 429, message: "rate limited" },
  ])("propagates non-404 target-resolution failures", async (failure) => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const base = {
      fetchProfile: vi.fn().mockRejectedValue(failure),
    } as unknown as ClientBase;
    stubAccountClient(service, base);

    await expect(
      service.resolveConnectorTargets("someone", {
        runtime,
        source: "x",
        accountId: "secondary",
      }),
    ).rejects.toBe(failure);
  });

  it("degrades user context only for an explicit profile-not-found error", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const notFound = new ElizaError("missing", {
      code: "X_PROFILE_NOT_FOUND",
    });
    const base = {
      fetchProfile: vi.fn().mockRejectedValue(notFound),
    } as unknown as ClientBase;
    stubAccountClient(service, base);

    await expect(
      service.getConnectorUserContext("missing-user", {
        runtime,
        source: "x",
        accountId: "secondary",
      }),
    ).resolves.toBeNull();
  });

  it.each([
    new ElizaError("auth rejected", { code: "X_AUTH_REJECTED" }),
    new ElizaError("session rotated", { code: "X_AUTH_SESSION_ROTATED" }),
    { statusCode: 429, message: "rate limited" },
  ])("propagates non-404 user-context failures", async (failure) => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const base = {
      fetchProfile: vi.fn().mockRejectedValue(failure),
    } as unknown as ClientBase;
    stubAccountClient(service, base);

    await expect(
      service.getConnectorUserContext("someone", {
        runtime,
        source: "x",
        accountId: "secondary",
      }),
    ).rejects.toBe(failure);
  });
});
