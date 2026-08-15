/** Unit tests for X account status and trusted multi-account connector routing. Network clients are deterministic fakes. */
import {
  type Content,
  createUniqueUuid,
  ElizaError,
  type IAgentRuntime,
  type TargetInfo,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { ClientBase } from "../base";
import type { TwitterClientState } from "../types";
import { TwitterPostService } from "./PostService";
import { TwitterClientInstance, XService } from "./x.service";

function asRuntime<T extends object>(runtime: T): IAgentRuntime & T {
  return runtime as IAgentRuntime & T;
}

function runtimeWithSettings(settings: Record<string, string>): IAgentRuntime {
  return asRuntime({
    agentId: "agent-1",
    getSetting: (key: string) => settings[key],
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
  });
}

function serviceWithRuntime(settings: Record<string, string>): XService {
  return new XService(runtimeWithSettings(settings));
}

describe("ClientBase authenticated identity", () => {
  it("refreshes entity metadata and clears account A's cursor on rotation to B", async () => {
    let entity: {
      id: string;
      names: string[];
      metadata: Record<string, unknown>;
      agentId: string;
    } = {
      id: "agent-1",
      names: ["Account A", "account-a", "Unrelated"],
      metadata: {
        twitter: {
          id: "account-a",
          userName: "account-a",
          name: "Account A",
        },
      },
      agentId: "agent-1",
    };
    const updateEntity = vi.fn(async (next: typeof entity) => {
      entity = next;
    });
    const getCache = vi.fn(async (key: string) =>
      key.includes("account-a") ? "900" : undefined,
    );
    const runtime = asRuntime({
      agentId: "agent-1",
      character: { name: "Account A" },
      getSetting: () => undefined,
      getEntityById: vi.fn(async () => entity),
      updateEntity,
      getCache,
    });
    const client = new ClientBase(runtime, {} as TwitterClientState);
    let revision = 1;
    let apiClient = { account: "a" };
    let profile = {
      userId: "account-a",
      username: "account-a",
      name: "Account A",
      biography: "A",
    };
    client.twitterClient = {
      withAuthenticatedSession: vi.fn(
        async (
          operation: (session: {
            client: typeof apiClient;
            profile: typeof profile;
            revision: number;
          }) => Promise<unknown>,
        ) => operation({ client: apiClient, profile, revision }),
      ),
      withCurrentSession: vi.fn(
        async (_session: unknown, operation: () => Promise<unknown>) =>
          operation(),
      ),
      isAuthenticatedSessionCurrent: vi.fn(() => true),
    } as unknown as ClientBase["twitterClient"];

    await client.getAuthenticatedProfile();
    await client.loadLatestCheckedTweetId();
    expect(client.lastCheckedTweetId).toBe(900n);

    revision = 2;
    apiClient = { account: "b" };
    profile = {
      userId: "account-b",
      username: "account-b",
      name: "Account B",
      biography: "B",
    };
    await expect(client.getAuthenticatedProfile()).resolves.toMatchObject({
      id: "account-b",
      username: "account-b",
    });
    expect(client.lastCheckedTweetId).toBeNull();
    await client.loadLatestCheckedTweetId();
    expect(client.lastCheckedTweetId).toBeNull();
    expect(entity.metadata).toMatchObject({
      twitter: {
        id: "account-b",
        userName: "account-b",
        name: "Account B",
      },
    });
    expect(entity.names).toEqual([
      "Account A",
      "Unrelated",
      "Account B",
      "account-b",
    ]);
    expect(getCache).toHaveBeenLastCalledWith(
      "twitter/account-b/latest_checked_tweet_id",
    );
    expect(updateEntity).toHaveBeenCalled();
  });

  it("does not publish account B after durable identity metadata fails to update", async () => {
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
    const updateEntity = vi.fn(async () => {
      throw updateFailure;
    });
    const runtime = asRuntime({
      agentId: "agent-1",
      character: { name: "Agent" },
      getSetting: () => undefined,
      getEntityById: vi.fn(async () => entity),
      updateEntity,
      getCache: vi.fn(async () => undefined),
    });
    const client = new ClientBase(runtime, {} as TwitterClientState);
    let profile = {
      userId: "account-a",
      username: "account-a",
      name: "Account A",
      biography: "A",
    };
    client.twitterClient = {
      withAuthenticatedSession: vi.fn(
        async (
          operation: (session: {
            client: object;
            profile: typeof profile;
            revision: number;
          }) => Promise<unknown>,
        ) => operation({ client: {}, profile, revision: 1 }),
      ),
      withCurrentSession: vi.fn(
        async (_session: unknown, operation: () => Promise<unknown>) =>
          operation(),
      ),
      isAuthenticatedSessionCurrent: vi.fn(() => true),
    } as unknown as ClientBase["twitterClient"];

    await expect(client.getAuthenticatedProfile()).resolves.toMatchObject({
      id: "account-a",
    });
    profile = {
      userId: "account-b",
      username: "account-b",
      name: "Account B",
      biography: "B",
    };

    await expect(client.getAuthenticatedProfile()).rejects.toBe(updateFailure);
    expect(client.profile).toBeNull();
    expect(entity).toMatchObject({
      names: ["Agent", "Account A", "account-a"],
      metadata: { twitter: { id: "account-a" } },
    });
  });
});

describe("XService account status", () => {
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

  it("declares that its unscoped message connector dispatches trusted account ids", () => {
    const registerMessageConnector = vi.fn();
    const runtime = asRuntime({
      agentId: "agent-1",
      getSetting: () => undefined,
      registerMessageConnector,
      registerPostConnector: vi.fn(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });
    const service = new XService(runtime);

    XService.registerSendHandlers(runtime, service);

    expect(registerMessageConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "x",
        accountRouting: "connector",
      }),
    );
  });

  it("declares that its unscoped post connector dispatches trusted account ids", () => {
    const registerPostConnector = vi.fn();
    const runtime = asRuntime({
      agentId: "agent-1",
      getSetting: () => undefined,
      registerPostConnector,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });
    const service = new XService(runtime);

    (
      service as unknown as {
        registerPostConnector(runtime: IAgentRuntime): void;
      }
    ).registerPostConnector(runtime);

    expect(registerPostConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "x",
        accountRouting: "connector",
      }),
    );
  });

  it("routes connector user context through the trusted account id", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const getScreenNameByUserId = vi.fn(async () => "secondary-user");
    type ServiceInternals = {
      getTwitterClientForAccount: (accountId: unknown) => Promise<{
        client: {
          twitterClient: {
            getScreenNameByUserId: typeof getScreenNameByUserId;
          };
        };
      }>;
    };
    const getClient = vi
      .spyOn(
        service as unknown as ServiceInternals,
        "getTwitterClientForAccount",
      )
      .mockResolvedValue({
        client: { twitterClient: { getScreenNameByUserId } },
      });

    const context = {
      runtime,
      source: "x",
      accountId: "secondary",
      target: { source: "x", accountId: "secondary" },
    };
    const result = await service.getConnectorUserContext("123456", context);

    expect(getClient).toHaveBeenCalledWith("secondary");
    expect(result).toMatchObject({
      entityId: "123456",
      label: "@secondary-user",
      metadata: { accountId: "secondary" },
    });
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

  it("reports accountId-first env capabilities without making a network call", async () => {
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
    const currentProfile = {
      id: "account-b",
      username: "current-b",
      screenName: "Current B",
      bio: "",
      nicknames: [],
    };
    const getAuthenticatedProfile = vi.fn(async () => currentProfile);
    (
      service as unknown as {
        accountClients: Map<
          string,
          {
            accountId: string;
            client: {
              profile: typeof currentProfile;
              getAuthenticatedProfile: typeof getAuthenticatedProfile;
            };
          }
        >;
      }
    ).accountClients.set("default", {
      accountId: "default",
      client: { profile: currentProfile, getAuthenticatedProfile },
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
    expect(service.getActiveProfile("default")).toMatchObject({
      id: "account-b",
    });
    expect(getAuthenticatedProfile).toHaveBeenCalledOnce();
    await expect(
      service.refreshActiveProfile("default"),
    ).resolves.toMatchObject({ id: "account-b" });
    expect(getAuthenticatedProfile).toHaveBeenCalledTimes(2);
  });

  it("reports needs_reauth instead of stale identity after refresh failure", async () => {
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
    await expect(service.refreshActiveProfile("default")).rejects.toBe(
      authFailure,
    );
  });

  it("propagates provider and metadata failures instead of misreporting reauthentication", async () => {
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

describe("XService trusted account routing", () => {
  it("uses the refreshed identity for post room and author attribution", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const profile = {
      id: "account-b",
      username: "current-b",
      screenName: "Current B",
      bio: "",
      nicknames: [],
    };
    vi.spyOn(
      service as unknown as {
        getTwitterClientForAccount: (accountId: unknown) => Promise<{
          client: {
            withAuthenticatedSession: (
              operation: (session: {
                profile: typeof profile;
              }) => Promise<unknown>,
            ) => Promise<unknown>;
          };
        }>;
      },
      "getTwitterClientForAccount",
    ).mockResolvedValue({
      client: {
        withAuthenticatedSession: async (
          operation: (session: { profile: typeof profile }) => Promise<unknown>,
        ) => operation({ profile }),
      },
    });
    const roomId = createUniqueUuid(runtime, `x:default:feed:${profile.id}`);
    const createPost = vi
      .spyOn(TwitterPostService.prototype, "createPost")
      .mockResolvedValue({
        id: "tweet-b",
        agentId: runtime.agentId,
        roomId,
        userId: profile.id,
        username: profile.username,
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

    await service.handleSendPost(runtime, { text: "hello from b" });

    expect(createPost).toHaveBeenCalledWith(
      expect.objectContaining({ roomId, text: "hello from b" }),
      profile,
    );
  });

  it("classifies recent DMs with the identity bound to the API session", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const events = [
      {
        id: "2",
        dm_conversation_id: "conversation-b",
        sender_id: "account-b",
        text: "sent by current account",
        event_type: "MessageCreate",
        participant_ids: ["account-b", "person-1"],
      },
      {
        id: "1",
        dm_conversation_id: "conversation-a",
        sender_id: "account-a",
        text: "sent by prior account",
        event_type: "MessageCreate",
        participant_ids: ["account-a", "person-1"],
      },
    ];
    const iterator = {
      includes: {
        users: [
          { id: "account-a", username: "prior-a" },
          { id: "account-b", username: "current-b" },
        ],
      },
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    };
    const listDmEvents = vi.fn(() => iterator);
    const profile = {
      id: "account-b",
      username: "current-b",
      screenName: "Current B",
      bio: "",
      nicknames: [],
    };
    const api = { v2: { listDmEvents } };
    const withAuthenticatedSession = vi.fn(
      async (
        operation: (session: {
          client: typeof api;
          profile: typeof profile;
          revision: number;
        }) => Promise<unknown>,
      ) => operation({ client: api, profile, revision: 2 }),
    );
    vi.spyOn(
      service as unknown as {
        getTwitterClientForAccount: (accountId: unknown) => Promise<{
          client: {
            withAuthenticatedSession: typeof withAuthenticatedSession;
          };
        }>;
      },
      "getTwitterClientForAccount",
    ).mockResolvedValue({ client: { withAuthenticatedSession } });

    const messages = await (
      service as unknown as {
        listRecentDirectMessages: (
          accountId: string,
          limit: number,
        ) => Promise<Array<{ senderId: string; isInbound: boolean }>>;
      }
    ).listRecentDirectMessages("default", 10);

    expect(withAuthenticatedSession).toHaveBeenCalledOnce();
    expect(messages).toEqual([
      expect.objectContaining({ senderId: "account-b", isInbound: false }),
      expect.objectContaining({ senderId: "account-a", isInbound: true }),
    ]);
  });

  it("routes feed reads through the trusted secondary account context", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const fetchHomeTimeline = vi.fn(async () => []);
    const getClient = vi
      .spyOn(
        service as unknown as {
          getTwitterClientForAccount: (accountId: unknown) => Promise<{
            client: {
              fetchHomeTimeline: typeof fetchHomeTimeline;
              runtime: IAgentRuntime;
            };
          }>;
        },
        "getTwitterClientForAccount",
      )
      .mockResolvedValue({
        client: { fetchHomeTimeline, runtime },
      });

    await service.fetchConnectorFeed(
      {
        runtime,
        source: "x",
        accountId: "secondary",
        target: { source: "x", accountId: "primary" },
        metadata: { accountId: "primary" },
      },
      {
        target: { source: "x", accountId: "primary" },
      },
    );

    expect(getClient).toHaveBeenCalledWith("secondary");
    expect(fetchHomeTimeline).toHaveBeenCalledOnce();
  });

  it("routes post searches through the trusted secondary account context", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const fetchSearchTweets = vi.fn(async () => ({ tweets: [] }));
    const getClient = vi
      .spyOn(
        service as unknown as {
          getTwitterClientForAccount: (accountId: unknown) => Promise<{
            client: {
              fetchSearchTweets: typeof fetchSearchTweets;
            };
          }>;
        },
        "getTwitterClientForAccount",
      )
      .mockResolvedValue({ client: { fetchSearchTweets } });

    await service.searchConnectorPosts(
      {
        runtime,
        source: "x",
        accountId: "secondary",
        target: { source: "x", accountId: "primary" },
        metadata: { accountId: "primary" },
      },
      { query: "multi-account routing" },
    );

    expect(getClient).toHaveBeenCalledWith("secondary");
    expect(fetchSearchTweets).toHaveBeenCalledWith(
      "multi-account routing",
      20,
      expect.anything(),
      undefined,
    );
  });

  it("ignores spoofed content account metadata in the unscoped send handler", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const getClient = vi
      .spyOn(
        service as unknown as {
          getTwitterClientForAccount: (accountId: unknown) => Promise<{
            client: Record<string, never>;
          }>;
        },
        "getTwitterClientForAccount",
      )
      .mockResolvedValue({ client: {} });
    const sendXDirectMessage = vi
      .spyOn(
        service as unknown as {
          sendXDirectMessage: (
            accountId: string,
            recipient: string,
            text: string,
          ) => Promise<{ messageId: string | null }>;
        },
        "sendXDirectMessage",
      )
      .mockResolvedValue({ messageId: "dm-1" });

    await service.handleSendMessage(
      runtime,
      { source: "x", entityId: "123456" } as TargetInfo,
      {
        text: "hello",
        metadata: { accountId: "secondary" },
      } as Content,
    );

    expect(getClient).toHaveBeenCalledWith("default");
    expect(sendXDirectMessage).toHaveBeenCalledWith(
      "default",
      "123456",
      "hello",
    );
  });
});
