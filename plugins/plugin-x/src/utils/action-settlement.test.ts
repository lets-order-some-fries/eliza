/** Deterministic contract tests for account-scoped X effect admission and replay settlement. */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type {
  ClientBase,
  TwitterAccountSession,
  TwitterProfile,
} from "../base";
import { executeSettledXAction } from "./action-settlement";

const profile: TwitterProfile = {
  id: "profile-a",
  username: "agent-a",
  screenName: "Agent A",
  bio: "",
  nicknames: [],
};

function harness({ afterMarker }: { afterMarker?: () => void } = {}) {
  const cache = new Map<string, unknown>();
  let current = true;
  const runtime = {
    getCache: vi.fn(async (key: string) => cache.get(key)),
    setCache: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
      if (value === "egress_started") afterMarker?.();
      return true;
    }),
    deleteCache: vi.fn(async (key: string) => cache.delete(key)),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  const session = {
    client: {},
    profile,
    revision: 1,
  } as TwitterAccountSession;
  const client = {
    accountId: "default",
    runtime,
    identityCacheKey: (_profile: TwitterProfile, suffix: string) =>
      `twitter/default/profile-a/${suffix}`,
    getIdentityCache: (_profile: TwitterProfile, suffix: string) =>
      runtime.getCache(`twitter/default/profile-a/${suffix}`),
    setIdentityCache: (
      _profile: TwitterProfile,
      suffix: string,
      value: unknown,
    ) => runtime.setCache(`twitter/default/profile-a/${suffix}`, value),
    isAuthenticatedSessionCurrent: () => current,
  } as unknown as ClientBase;

  return {
    cache,
    client,
    runtime,
    session,
    setCurrent(value: boolean) {
      current = value;
    },
  };
}

function execute(
  state: ReturnType<typeof harness>,
  operation: () => Promise<string>,
) {
  return executeSettledXAction({
    client: state.client,
    session: state.session,
    suffix: "interaction_action/tweet-1/like",
    operation,
    scope: "XInteraction.actionSettlement",
    context: { accountId: "default", tweetId: "tweet-1", action: "like" },
  });
}

describe("executeSettledXAction", () => {
  it("executes once and treats the durable receipt as authoritative", async () => {
    const state = harness();
    const operation = vi.fn(async () => "accepted");

    await expect(execute(state, operation)).resolves.toEqual({
      executed: true,
      value: "accepted",
    });
    await expect(execute(state, operation)).resolves.toEqual({
      executed: false,
    });

    expect(operation).toHaveBeenCalledOnce();
    expect(
      state.cache.get(
        "twitter/default/profile-a/interaction_action/tweet-1/like",
      ),
    ).toBe("delivered");
  });

  it("reopens an explicitly rejected provider write", async () => {
    const state = harness();
    const rejection = Object.assign(new Error("forbidden"), { code: 403 });

    await expect(
      execute(
        state,
        vi.fn(async () => Promise.reject(rejection)),
      ),
    ).rejects.toBe(rejection);
    expect(state.cache.size).toBe(0);
  });

  it("admits only one concurrent effect for the same account and action", async () => {
    const state = harness();
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const operation = vi.fn(() => pending);

    const first = execute(state, operation);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    const second = execute(state, operation);
    await expect(
      Promise.race([
        second.then(
          () => "settled",
          () => "settled",
        ),
        Promise.resolve("pending"),
      ]),
    ).resolves.toBe("pending");
    release("accepted");
    await expect(first).resolves.toEqual({
      executed: true,
      value: "accepted",
    });
    await expect(second).resolves.toEqual({ executed: false });

    expect(operation).toHaveBeenCalledOnce();
  });

  it("makes concurrent callers observe the first rejected disposition", async () => {
    const state = harness();
    let reject!: (error: Error) => void;
    const pending = new Promise<string>((_resolve, onReject) => {
      reject = onReject;
    });
    const operation = vi.fn(() => pending);
    const rejection = Object.assign(new Error("forbidden"), { code: 403 });

    const first = execute(state, operation);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    const second = execute(state, operation);
    await expect(
      Promise.race([
        second.then(
          () => "settled",
          () => "settled",
        ),
        Promise.resolve("pending"),
      ]),
    ).resolves.toBe("pending");

    reject(rejection);
    await expect(first).rejects.toBe(rejection);
    await expect(second).rejects.toBe(rejection);
    expect(operation).toHaveBeenCalledOnce();
    expect(state.cache.size).toBe(0);
  });

  it("propagates a concurrent pre-provider rotation instead of reporting success", async () => {
    const state = harness();
    let reject!: (error: Error) => void;
    const pending = new Promise<string>((_resolve, onReject) => {
      reject = onReject;
    });
    const operation = vi.fn(() => pending);
    const rotation = new ElizaError("credentials rotated", {
      code: "X_AUTH_SESSION_ROTATED",
    });

    const first = execute(state, operation);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    const second = execute(state, operation);
    reject(rotation);

    await expect(first).rejects.toBe(rotation);
    await expect(second).rejects.toBe(rotation);
    expect(operation).toHaveBeenCalledOnce();
    expect(state.cache.size).toBe(0);
  });

  it("retains an indeterminate marker for a transport failure", async () => {
    const state = harness();
    const failure = new Error("connection reset after write");

    await expect(
      execute(
        state,
        vi.fn(async () => Promise.reject(failure)),
      ),
    ).rejects.toBe(failure);
    expect(
      state.cache.get(
        "twitter/default/profile-a/interaction_action/tweet-1/like",
      ),
    ).toBe("indeterminate");
  });

  it("clears the marker when credentials rotate before provider egress", async () => {
    let state: ReturnType<typeof harness>;
    state = harness({ afterMarker: () => state.setCurrent(false) });
    const operation = vi.fn(async () => "must not run");

    await expect(execute(state, operation)).rejects.toMatchObject({
      code: "X_AUTH_SESSION_ROTATED",
    });
    expect(operation).not.toHaveBeenCalled();
    expect(state.cache.size).toBe(0);
  });
});
