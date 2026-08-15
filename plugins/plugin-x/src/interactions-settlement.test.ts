/**
 * Adversarial mention-reply tests exercise callback re-entry, durable delivery
 * admission, local receipt loss, and credential rotation with a mocked X edge.
 */
import {
  type Content,
  type ElizaError,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase, TwitterAccountSession } from "./base";
import type { Tweet } from "./client";
import { TwitterInteractionClient } from "./interactions";
import type { TwitterClientState } from "./types";

function asRuntime<T extends object>(runtime: T): IAgentRuntime & T {
  return runtime as IAgentRuntime & T;
}

function createRuntime() {
  const cache = new Map<string, unknown>();
  const memories = new Map<UUID, Memory>();
  const createMemory = vi.fn(async (memory: Memory) => {
    memories.set(memory.id as UUID, memory);
  });

  return asRuntime({
    agentId: "agent-1" as UUID,
    character: { name: "Agent" },
    cache,
    memories,
    createMemory,
    deleteCache: vi.fn(async (key: string) => cache.delete(key)),
    emitEvent: vi.fn(),
    ensureConnection: vi.fn(async () => undefined),
    ensureRoomExists: vi.fn(async () => undefined),
    ensureWorldExists: vi.fn(async () => undefined),
    getCache: vi.fn(async (key: string) => cache.get(key)),
    getMemories: vi.fn(async ({ roomId }: { roomId: UUID }) =>
      [...memories.values()].filter((memory) => memory.roomId === roomId),
    ),
    getMemoryById: vi.fn(async (id: UUID) => memories.get(id) ?? null),
    getSetting: vi.fn(() => undefined),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    messageService: { handleMessage: vi.fn() },
    reportError: vi.fn(),
    setCache: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    }),
    updateWorld: vi.fn(async () => undefined),
  });
}

type TestRuntime = ReturnType<typeof createRuntime>;

function createClient(runtime: TestRuntime) {
  const profile = {
    id: "bot-a",
    username: "bot_a",
    screenName: "Bot A",
    bio: "",
    nicknames: [],
  };
  const twitterClientA = {
    getTweetsV2: vi.fn(async () => []),
    sendTweet: vi.fn(async (text: string) => ({
      data: { data: { id: "900", text } },
    })),
  };
  const twitterClientB = {
    sendTweet: vi.fn(async (text: string) => ({
      data: { data: { id: "901", text } },
    })),
  };
  const session = {
    client: twitterClientA,
    profile,
    revision: 1,
  } as unknown as TwitterAccountSession;
  let current = true;
  let lastCheckedTweetId: bigint | null = null;
  let failNextSettlementWrite = false;

  const client = {
    accountId: "account-a",
    runtime,
    profile,
    twitterClient: twitterClientA,
    get lastCheckedTweetId() {
      return lastCheckedTweetId;
    },
    set lastCheckedTweetId(value: bigint | null) {
      lastCheckedTweetId = value;
    },
    cacheLatestCheckedTweetId: vi.fn(async () => undefined),
    cacheTweet: vi.fn(async () => undefined),
    getAuthenticatedProfile: vi.fn(async () => profile),
    getIdentityCache: vi.fn(
      async (identity: typeof profile, suffix: string) =>
        runtime.cache.get(`twitter/account-a/${identity.id}/${suffix}`) as
          | string
          | undefined,
    ),
    getLatestCheckedTweetId: vi.fn(() => lastCheckedTweetId),
    identityCacheKey: vi.fn(
      (identity: typeof profile, suffix: string) =>
        `twitter/account-a/${identity.id}/${suffix}`,
    ),
    isAuthenticatedSessionCurrent: vi.fn(() => current),
    recordLatestCheckedTweetId: vi.fn((_profileId: string, id: bigint) => {
      if (lastCheckedTweetId === null || id > lastCheckedTweetId) {
        lastCheckedTweetId = id;
      }
    }),
    setIdentityCache: vi.fn(
      async (identity: typeof profile, suffix: string, value: unknown) => {
        if (failNextSettlementWrite && suffix.startsWith("mention_settled/")) {
          failNextSettlementWrite = false;
          throw new Error("settlement store unavailable");
        }
        runtime.cache.set(`twitter/account-a/${identity.id}/${suffix}`, value);
      },
    ),
    withAuthenticatedSession: vi.fn(
      async <T>(operation: (active: TwitterAccountSession) => Promise<T>) =>
        operation(session),
    ),
  };

  return {
    client: client as unknown as ClientBase,
    failNextSettlementWrite() {
      failNextSettlementWrite = true;
    },
    rotate() {
      current = false;
    },
    session,
    twitterClientA,
    twitterClientB,
  };
}

function mention(id = "100"): Tweet {
  return {
    id,
    userId: "person-1",
    username: "alice",
    name: "Alice",
    conversationId: "conversation-1",
    text: "@bot_a hello",
    timestamp: Date.now(),
    thread: [],
    photos: [],
  } as Tweet;
}

function response(): Content {
  return { text: "hello back" };
}

function responseReceipts(runtime: TestRuntime): Memory[] {
  return [...runtime.memories.values()].filter(
    (memory) => memory.metadata?.fromBot === true,
  );
}

function interactionClient(client: ClientBase, runtime: TestRuntime) {
  return new TwitterInteractionClient(
    client,
    runtime,
    {} as TwitterClientState,
  );
}

describe("Twitter mention reply settlement", () => {
  beforeEach(() => {
    logger.log = vi.fn();
    logger.info = vi.fn();
    logger.warn = vi.fn();
    logger.error = vi.fn();
  });

  it.each([
    {
      name: "sequentially",
      invoke: async (callback: HandlerCallback) => [
        ...(await callback(response())),
        ...(await callback(response())),
      ],
    },
    {
      name: "concurrently",
      invoke: async (callback: HandlerCallback) => {
        const attempts = await Promise.all([
          callback(response()),
          callback(response()),
        ]);
        return attempts.flat();
      },
    },
  ])(
    "admits exactly one provider reply and response receipt when the callback re-enters $name",
    async ({ invoke }) => {
      const runtime = createRuntime();
      const { client, twitterClientA } = createClient(runtime);
      runtime.messageService.handleMessage.mockImplementation(
        async (
          _runtime: IAgentRuntime,
          _message: Memory,
          callback: HandlerCallback,
        ) => ({ responseMessages: await invoke(callback) }),
      );

      await interactionClient(client, runtime).processMentionTweets([
        mention(),
      ]);

      expect(twitterClientA.sendTweet).toHaveBeenCalledTimes(1);
      expect(twitterClientA.sendTweet).toHaveBeenCalledWith(
        "hello back",
        "100",
        [],
        false,
        undefined,
      );
      expect(responseReceipts(runtime)).toHaveLength(1);
      expect(
        runtime.cache.get("twitter/account-a/bot-a/mention_settled/100"),
      ).toBe("delivered:900");
    },
  );

  it("surfaces a swallowed pre-egress settlement failure and retries without advancing the source cursor", async () => {
    const runtime = createRuntime();
    const { client, failNextSettlementWrite, twitterClientA } =
      createClient(runtime);
    failNextSettlementWrite();
    runtime.messageService.handleMessage.mockImplementation(
      async (
        _runtime: IAgentRuntime,
        _message: Memory,
        callback: HandlerCallback,
      ) => {
        try {
          return { responseMessages: await callback(response()) };
        } catch {
          return { responseMessages: [] };
        }
      },
    );
    const interactions = interactionClient(client, runtime);

    await expect(
      interactions.processMentionTweets([mention()]),
    ).rejects.toThrow("settlement store unavailable");

    expect(twitterClientA.sendTweet).not.toHaveBeenCalled();
    expect(client.getLatestCheckedTweetId("bot-a")).toBeNull();
    expect(
      runtime.cache.has("twitter/account-a/bot-a/mention_settled/100"),
    ).toBe(false);
    expect(runtime.deleteCache).toHaveBeenCalledWith(
      "twitter/account-a/bot-a/mention_settled/100",
    );

    await expect(
      interactions.processMentionTweets([mention()]),
    ).resolves.toBeUndefined();

    expect(twitterClientA.sendTweet).toHaveBeenCalledTimes(1);
    expect(responseReceipts(runtime)).toHaveLength(1);
    expect(client.getLatestCheckedTweetId("bot-a")).toBe(900n);
  });

  it("does not resend an accepted reply when response-memory persistence fails", async () => {
    const runtime = createRuntime();
    const { client, twitterClientA } = createClient(runtime);
    runtime.createMemory.mockImplementation(async (memory: Memory) => {
      if (memory.metadata?.fromBot === true) {
        throw new Error("response receipt unavailable");
      }
      runtime.memories.set(memory.id as UUID, memory);
    });
    runtime.messageService.handleMessage.mockImplementation(
      async (
        _runtime: IAgentRuntime,
        _message: Memory,
        callback: HandlerCallback,
      ) => ({ responseMessages: await callback(response()) }),
    );
    const interactions = interactionClient(client, runtime);

    await interactions.processMentionTweets([mention()]);
    client.lastCheckedTweetId = null;
    await interactions.processMentionTweets([mention()]);

    expect(twitterClientA.sendTweet).toHaveBeenCalledTimes(1);
    expect(runtime.reportError).toHaveBeenCalledWith(
      "XInteractions.replyCallback",
      expect.objectContaining({ message: "response receipt unavailable" }),
    );
    expect(
      runtime.cache.get("twitter/account-a/bot-a/mention_settled/100"),
    ).toBe("delivered:900");
  }, 15_000);

  it("aborts a callback after credential rotation without egress through either identity or cursor advance", async () => {
    const runtime = createRuntime();
    const { client, rotate, twitterClientA, twitterClientB } =
      createClient(runtime);
    runtime.messageService.handleMessage.mockImplementation(
      async (
        _runtime: IAgentRuntime,
        _message: Memory,
        callback: HandlerCallback,
      ) => {
        rotate();
        try {
          return { responseMessages: await callback(response()) };
        } catch {
          return { responseMessages: [] };
        }
      },
    );

    await expect(
      interactionClient(client, runtime).processMentionTweets([mention()]),
    ).rejects.toMatchObject<Partial<ElizaError>>({
      code: "X_AUTH_SESSION_ROTATED",
    });

    expect(twitterClientA.sendTweet).not.toHaveBeenCalled();
    expect(twitterClientB.sendTweet).not.toHaveBeenCalled();
    expect(client.getLatestCheckedTweetId("bot-a")).toBeNull();
    expect(
      runtime.cache.has("twitter/account-a/bot-a/mention_settled/100"),
    ).toBe(false);
  });
});
