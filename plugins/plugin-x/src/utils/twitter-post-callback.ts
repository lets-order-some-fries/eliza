/**
 * `createTwitterPostCallback` — the `HandlerCallback` the post loop hands the agent
 * for publishing a generated tweet: it normalizes text to the X length limit,
 * suppresses duplicate generations, honors `TWITTER_DRY_RUN`, publishes via the
 * client, and records the resulting memory (returning it even when the post-publish
 * persistence step fails).
 */
import {
  ChannelType,
  type Content,
  createUniqueUuid,
  ElizaError,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  parseBooleanFromText,
  type UUID,
} from "@elizaos/core";
import type { ClientBase } from "../base";
import { TWEET_MAX_LENGTH } from "../constants";
import type { TwitterClientState } from "../types";
import { sendTweet } from "../utils";
import { isExplicitTwitterRejection } from "./error-handler";
import {
  addToRecentTweets,
  createMemorySafe,
  ensureTwitterContext,
  isDuplicateTweet,
} from "./memory";
import { getSetting } from "./settings";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePostText(text: string): string {
  if (text.length <= TWEET_MAX_LENGTH) {
    return text;
  }

  const sentenceMatches = text.match(/[^.!?]+[.!?]+/g) || [];
  let sentenceText = "";
  for (const sentence of sentenceMatches) {
    if ((sentenceText + sentence).trim().length <= TWEET_MAX_LENGTH) {
      sentenceText += sentence;
    } else {
      break;
    }
  }
  if (sentenceText.trim()) {
    return sentenceText.trim();
  }

  const spaceIndex = text.lastIndexOf(" ", TWEET_MAX_LENGTH - 4);
  if (spaceIndex > 0) {
    return `${text.slice(0, spaceIndex).trim()}...`;
  }

  return `${text.slice(0, TWEET_MAX_LENGTH - 3).trim()}...`;
}

function isPreProviderAuthFailure(error: unknown): boolean {
  return (
    error instanceof ElizaError &&
    ["X_AUTH_NOT_INITIALIZED", "X_AUTH_SESSION_ROTATED"].includes(error.code)
  );
}

const claimedPostSettlements = new Set<string>();

export function createTwitterPostCallback({
  client,
  runtime,
  state,
  roomId,
  userId,
  username: _username,
  onPosted,
}: {
  client: ClientBase;
  runtime: IAgentRuntime;
  state: TwitterClientState;
  roomId: UUID;
  userId: string;
  username: string;
  onPosted?: () => void;
}): HandlerCallback {
  const isDryRun = parseBooleanFromText(
    state?.TWITTER_DRY_RUN ?? getSetting(runtime, "TWITTER_DRY_RUN"),
  );
  let egressAttempted = false;

  const callback: HandlerCallback = async (
    content: Content,
  ): Promise<Memory[]> => {
    try {
      const generatedText =
        typeof content.text === "string" ? content.text.trim() : "";
      if (!generatedText) {
        runtime.logger.warn("[Twitter] No generated tweet text to post");
        return [];
      }

      const postText = normalizePostText(generatedText);
      if (postText !== generatedText) {
        runtime.logger.warn(
          `[Twitter] Generated tweet exceeded ${TWEET_MAX_LENGTH} characters; posting truncated text`,
        );
      }

      if (isDryRun) {
        runtime.logger.info(
          `[Twitter] [DRY RUN] Would post tweet: ${postText}`,
        );
        return [];
      }

      if (egressAttempted) {
        runtime.logger.warn(
          "[Twitter] Suppressed duplicate generated-post callback egress",
        );
        return [];
      }
      egressAttempted = true;

      return client.withAuthenticatedSession(async (session) => {
        if (session.profile.id !== userId) {
          throw new ElizaError(
            "X profile changed before the generated post was admitted",
            { code: "X_AUTH_SESSION_ROTATED" },
          );
        }

        const cacheIdentity = {
          accountId: client.accountId,
          profileId: session.profile.id,
        };
        const settlementKey = `twitter/${encodeURIComponent(client.accountId)}/${userId}/post_settled/${createUniqueUuid(runtime, `${roomId}:${postText}`)}`;
        if (claimedPostSettlements.has(settlementKey)) {
          runtime.logger.info(
            "[Twitter] Skipping generated post already claimed by this process",
          );
          return [];
        }
        claimedPostSettlements.add(settlementKey);

        try {
          const isDuplicate = await isDuplicateTweet(
            runtime,
            cacheIdentity,
            postText,
          );
          if (isDuplicate) {
            runtime.logger.info("[Twitter] Skipping duplicate generated tweet");
            return [];
          }

          const existingSettlement =
            await runtime.getCache<string>(settlementKey);
          if (existingSettlement) {
            runtime.logger.info(
              "[Twitter] Skipping generated post with an existing delivery settlement",
            );
            return [];
          }

          await runtime.setCache(settlementKey, "egress_started");
          let result: Awaited<ReturnType<typeof sendTweet>>;
          try {
            result = await sendTweet(client, postText, [], undefined, []);
          } catch (error) {
            if (
              isExplicitTwitterRejection(error) ||
              isPreProviderAuthFailure(error)
            ) {
              try {
                await runtime.deleteCache(settlementKey);
              } catch (settlementError) {
                // error-policy:J7 No provider acceptance occurred, but cleanup
                // failure must be visible because it can delay a safe retry.
                runtime.reportError(
                  "XPostCallback.rejectedSettlementCleanup",
                  settlementError,
                  { accountId: client.accountId },
                );
              }
            } else {
              try {
                await runtime.setCache(settlementKey, "indeterminate");
              } catch (settlementError) {
                // error-policy:J7 The pre-egress barrier remains after an
                // ambiguous provider failure, so diagnostics cannot risk replay.
                runtime.reportError(
                  "XPostCallback.indeterminateSettlement",
                  settlementError,
                  { accountId: client.accountId },
                );
              }
            }
            throw error;
          }
          try {
            await runtime.setCache(settlementKey, `delivered:${result.id}`);
          } catch (error) {
            // error-policy:J7 X already accepted the post and the pre-egress marker
            // remains, so receipt loss is reported without replaying the post.
            runtime.reportError("XPostCallback.settlement", error, {
              accountId: client.accountId,
              tweetId: result.id,
            });
          }
          const postedText = result.text?.trim() || postText;
          runtime.logger.info(
            `[Twitter] Tweet posted successfully! ID: ${result.id}`,
          );
          try {
            onPosted?.();
          } catch (error) {
            // error-policy:J7 X already accepted the post; the scheduler's
            // notification callback must not convert delivery into a retry.
            runtime.reportError("XPostCallback.notificationReceipt", error, {
              accountId: client.accountId,
              tweetId: result.id,
            });
          }

          let recentHistoryPersisted = false;
          try {
            await addToRecentTweets(runtime, cacheIdentity, postedText);
            recentHistoryPersisted = true;
          } catch (error) {
            // error-policy:J7 X already accepted the post. If recent history
            // failed, the delivery marker remains as the no-replay authority.
            runtime.reportError("XPostCallback.localReceipt", error, {
              accountId: client.accountId,
              tweetId: result.id,
            });
          }
          if (recentHistoryPersisted) {
            try {
              // Recent-history owns bounded duplicate suppression after it is
              // durable. Releasing the crash barrier prevents a short post such
              // as "gm" from being reserved forever once that history ages out.
              await runtime.deleteCache(settlementKey);
            } catch (error) {
              // error-policy:J7 Both the accepted-post marker and recent
              // history remain safe; report cleanup so the marker can be freed.
              runtime.reportError("XPostCallback.settlementRelease", error, {
                accountId: client.accountId,
                tweetId: result.id,
              });
            }
          }

          try {
            const context = await ensureTwitterContext(runtime, {
              accountId: client.accountId,
              userId: session.profile.id,
              username: session.profile.username,
              conversationId: `${session.profile.id}-home`,
            });

            const postedMemory: Memory = {
              id: createUniqueUuid(runtime, result.id),
              entityId: runtime.agentId,
              agentId: runtime.agentId,
              roomId: context.roomId || roomId,
              content: {
                ...content,
                text: postedText,
                source: "twitter",
                channelType: ChannelType.FEED,
                type: "post",
                metadata: {
                  accountId: client.accountId,
                  tweetId: result.id,
                  postedAt: Date.now(),
                },
              },
              metadata: {
                type: "message",
                source: "twitter",
                accountId: client.accountId,
                provider: "twitter",
                messageIdFull: result.id,
                chatType: ChannelType.FEED,
                fromBot: true,
              } satisfies Memory["metadata"],
              createdAt: Date.now(),
            };

            await createMemorySafe(runtime, postedMemory, "messages");

            return [postedMemory];
          } catch (error) {
            // error-policy:J7 X already accepted the post; surface local memory
            // loss without returning an error that could cause duplicate egress.
            runtime.reportError("XPostCallback.memoryReceipt", error, {
              accountId: client.accountId,
              tweetId: result.id,
            });
            return [];
          }
        } finally {
          claimedPostSettlements.delete(settlementKey);
        }
      });
    } catch (error) {
      runtime.logger.error(
        "[Twitter] Error in post generated callback:",
        errorMessage(error),
      );
      throw error;
    }
  };

  return callback;
}
