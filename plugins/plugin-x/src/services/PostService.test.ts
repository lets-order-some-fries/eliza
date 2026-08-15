/** Verifies post actions and current-account attribution through deterministic X client fakes. */
import type { UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "../base";
import { TwitterPostService } from "./PostService";

describe("TwitterPostService inverse post actions", () => {
  const unlikeTweet = vi.fn();
  const unretweet = vi.fn();
  let service: TwitterPostService;

  beforeEach(() => {
    unlikeTweet.mockReset();
    unretweet.mockReset();
    service = new TwitterPostService({
      twitterClient: {
        unlikeTweet,
        unretweet,
      },
    } as unknown as ClientBase);
  });

  it("unlikes posts through the Twitter client", async () => {
    await service.unlikePost(
      "tweet-1",
      "00000000-0000-0000-0000-000000000001" as UUID,
    );

    expect(unlikeTweet).toHaveBeenCalledWith("tweet-1");
  });

  it("removes reposts through the Twitter client", async () => {
    await service.unrepost(
      "tweet-2",
      "00000000-0000-0000-0000-000000000001" as UUID,
    );

    expect(unretweet).toHaveBeenCalledWith("tweet-2");
  });

  it("surfaces a getPosts fetch failure via reportError instead of silently returning []", async () => {
    const reportError = vi.fn();
    const getUserTweets = vi
      .fn()
      .mockRejectedValue(new Error("twitter 429 rate limited"));
    const failing = new TwitterPostService({
      runtime: { reportError },
      twitterClient: { getUserTweets },
    } as unknown as ClientBase);

    const posts = await failing.getPosts({
      agentId: "00000000-0000-0000-0000-000000000001" as UUID,
      userId: "123",
      limit: 5,
    });

    expect(posts).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(
      "XPostService.getPosts",
      expect.any(Error),
    );
  });

  it("uses the refreshed profile for created-post attribution", async () => {
    const profile = {
      id: "account-b",
      username: "current-b",
      screenName: "Current B",
      bio: "",
      nicknames: [],
    };
    const withAuthenticatedSession = vi.fn(
      async (
        operation: (session: { profile: typeof profile }) => Promise<unknown>,
      ) => operation({ profile }),
    );
    const sendTweet = vi.fn(async () => ({ data: { id: "tweet-b" } }));
    const current = new TwitterPostService({
      profile: { id: "account-a", username: "stale-a" },
      withAuthenticatedSession,
      twitterClient: { sendTweet },
    } as unknown as ClientBase);

    const post = await current.createPost({
      agentId: "00000000-0000-0000-0000-000000000001" as UUID,
      roomId: "00000000-0000-0000-0000-000000000002" as UUID,
      text: "hello from b",
    });

    expect(withAuthenticatedSession).toHaveBeenCalledOnce();
    expect(post).toMatchObject({
      id: "tweet-b",
      userId: "account-b",
      username: "current-b",
    });
  });

  it("queries mentions with the refreshed username", async () => {
    const fetchSearchTweets = vi.fn(async () => ({ tweets: [] }));
    const profile = {
      id: "account-b",
      username: "current-b",
      screenName: "Current B",
      bio: "",
      nicknames: [],
    };
    const current = new TwitterPostService({
      profile: { id: "account-a", username: "stale-a" },
      runtime: { reportError: vi.fn() },
      withAuthenticatedSession: async (
        operation: (session: { profile: typeof profile }) => Promise<unknown>,
      ) => operation({ profile }),
      fetchSearchTweets,
    } as unknown as ClientBase);

    await current.getMentions("00000000-0000-0000-0000-000000000001" as UUID);

    expect(fetchSearchTweets).toHaveBeenCalledWith(
      "@current-b",
      20,
      expect.anything(),
      undefined,
    );
  });

  it("refuses a post when the caller profile and admitted session differ", async () => {
    const profile = {
      id: "account-b",
      username: "current-b",
      screenName: "Current B",
      bio: "",
      nicknames: [],
    };
    const sendTweet = vi.fn();
    const current = new TwitterPostService({
      withAuthenticatedSession: async (
        operation: (session: { profile: typeof profile }) => Promise<unknown>,
      ) => operation({ profile }),
      twitterClient: { sendTweet },
    } as unknown as ClientBase);

    await expect(
      current.createPost(
        {
          agentId: "00000000-0000-0000-0000-000000000001" as UUID,
          roomId: "00000000-0000-0000-0000-000000000002" as UUID,
          text: "must not cross accounts",
        },
        { ...profile, id: "account-a" },
      ),
    ).rejects.toMatchObject({ code: "X_AUTH_SESSION_ROTATED" });
    expect(sendTweet).not.toHaveBeenCalled();
  });
});
