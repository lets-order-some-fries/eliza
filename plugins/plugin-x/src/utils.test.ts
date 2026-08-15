/** Verifies accepted X sends remain single-shot while account-bound cursor and cache receipts stay monotonic across rotation. */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { ClientBase, type TwitterProfile } from "./base";
import type { TwitterClientState } from "./types";
import { sendTweet } from "./utils";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function profile(id: string): TwitterProfile {
  return {
    id,
    username: id,
    screenName: id,
    bio: "",
    nicknames: [],
  };
}

describe("sendTweet", () => {
  it("returns the accepted tweet when local cache bookkeeping fails after publish", async () => {
    const authenticatedProfile = profile("account-a");
    const reportError = vi.fn();
    const client = {
      lastCheckedTweetId: null,
      accountId: "default",
      runtime: { reportError },
      withAuthenticatedSession: async (
        operation: (session: {
          client: unknown;
          profile: TwitterProfile;
          revision: number;
        }) => Promise<unknown>,
      ) =>
        operation({
          client: {},
          profile: authenticatedProfile,
          revision: 1,
        }),
      twitterClient: {
        sendTweet: vi.fn().mockResolvedValue({
          data: {
            data: {
              id: "123",
              text: "hello",
            },
          },
        }),
      },
      cacheLatestCheckedTweetId: vi
        .fn()
        .mockRejectedValue(new Error("cache unavailable")),
      recordLatestCheckedTweetId: vi.fn(),
      cacheTweet: vi.fn(),
    } as unknown as ClientBase;

    await expect(sendTweet(client, "hello")).resolves.toMatchObject({
      id: "123",
      text: "hello",
    });
    expect(client.twitterClient.sendTweet).toHaveBeenCalledTimes(1);
    expect(client.cacheLatestCheckedTweetId).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      "X.sendTweet.localReceipt",
      expect.any(Error),
      { accountId: "default", tweetId: "123" },
    );
    expect(client.cacheTweet).not.toHaveBeenCalled();
  });

  it("does not let a delayed account A receipt overwrite account B's cursor", async () => {
    const accepted = deferred<{
      data: { data: { id: string; text: string } };
    }>();
    const setCache = vi.fn(async () => undefined);
    const runtime = {
      agentId: "agent-1",
      character: { name: "Agent" },
      getSetting: () => undefined,
      setCache,
      getCache: vi.fn(async () => undefined),
      reportError: vi.fn(),
    } as unknown as IAgentRuntime;
    const client = new ClientBase(runtime, {} as TwitterClientState);
    const accountA = profile("account-a");
    const accountB = profile("account-b");
    client.profile = accountA;
    client.twitterClient = {
      sendTweet: vi.fn(() => accepted.promise),
    } as unknown as ClientBase["twitterClient"];
    client.withAuthenticatedSession = async (operation) =>
      operation({ client: {} as never, profile: accountA, revision: 1 });

    const pending = sendTweet(client, "sent by A");
    await vi.waitFor(() =>
      expect(client.twitterClient.sendTweet).toHaveBeenCalledOnce(),
    );

    client.profile = accountB;
    client.recordLatestCheckedTweetId(accountB.id, 50n);
    await client.cacheLatestCheckedTweetId(accountB);
    setCache.mockClear();
    accepted.resolve({ data: { data: { id: "100", text: "sent by A" } } });

    await expect(pending).resolves.toMatchObject({ id: "100" });
    expect(client.getLatestCheckedTweetId(accountB.id)).toBe(50n);
    expect(client.getLatestCheckedTweetId(accountA.id)).toBeNull();
    expect(
      setCache.mock.calls.some(([key]) =>
        String(key).endsWith("latest_checked_tweet_id"),
      ),
    ).toBe(false);
    expect(setCache).toHaveBeenCalledWith(
      "twitter/tweets/100",
      expect.objectContaining({
        id: "100",
        userId: "account-a",
        username: "account-a",
      }),
    );
  });

  it("never regresses a same-account cursor when sends settle out of order", () => {
    const runtime = {
      agentId: "agent-1",
      character: { name: "Agent" },
      getSetting: () => undefined,
    } as unknown as IAgentRuntime;
    const client = new ClientBase(runtime, {} as TwitterClientState);
    client.profile = profile("account-a");

    client.recordLatestCheckedTweetId("account-a", 102n);
    client.recordLatestCheckedTweetId("account-a", 101n);

    expect(client.getLatestCheckedTweetId("account-a")).toBe(102n);
  });
});
