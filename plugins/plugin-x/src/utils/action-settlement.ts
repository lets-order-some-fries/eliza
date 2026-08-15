/**
 * Durable, account-scoped admission for autonomous X effects. Callers use one
 * marker per source object and action so accepted or indeterminate provider
 * writes are never replayed when a later local receipt fails.
 */
import { ElizaError } from "@elizaos/core";
import type { ClientBase, TwitterAccountSession } from "../base";
import { isExplicitTwitterRejection } from "./error-handler";

export type XActionSettlement<T> =
  | { executed: false }
  | { executed: true; value: T };

interface XActionSettlementOptions<T> {
  client: ClientBase;
  session: TwitterAccountSession;
  suffix: string;
  operation: () => Promise<T>;
  scope: string;
  context: Record<string, unknown>;
}

const activeActionClaims = new Map<
  string,
  Promise<XActionSettlement<unknown>>
>();

function isPreProviderSessionFailure(error: unknown): error is ElizaError {
  return (
    error instanceof ElizaError &&
    ["X_AUTH_NOT_INITIALIZED", "X_AUTH_SESSION_ROTATED"].includes(
      String((error as { code?: unknown }).code),
    )
  );
}

async function executeClaimedXAction<T>({
  client,
  session,
  suffix,
  operation,
  scope,
  context,
}: XActionSettlementOptions<T>): Promise<XActionSettlement<T>> {
  const existing = await client.getIdentityCache<string>(
    session.profile,
    suffix,
  );
  if (existing) return { executed: false };

  const key = client.identityCacheKey(session.profile, suffix);
  try {
    await client.setIdentityCache(
      session.profile,
      suffix,
      "egress_started",
      session,
    );
  } catch (error) {
    // error-policy:J2 Clear the pre-egress claim before preserving the
    // admission failure for the owning autonomous-loop boundary.
    try {
      await client.runtime.deleteCache(key);
    } catch (cleanupError) {
      // error-policy:J7 No provider egress occurred, but a leaked marker would
      // suppress the next safe retry.
      client.runtime.reportError(`${scope}.cleanup`, cleanupError, context);
    }
    throw error;
  }

  if (!client.isAuthenticatedSessionCurrent(session)) {
    await client.runtime.deleteCache(key);
    throw new ElizaError("X credentials rotated before provider egress", {
      code: "X_AUTH_SESSION_ROTATED",
    });
  }

  let value: T;
  try {
    value = await operation();
  } catch (error) {
    // error-policy:J2 Persist the provider disposition before preserving the
    // original effect failure for the owning autonomous-loop boundary.
    try {
      if (
        isExplicitTwitterRejection(error) ||
        isPreProviderSessionFailure(error)
      ) {
        await client.runtime.deleteCache(key);
      } else {
        await client.runtime.setCache(key, "indeterminate");
      }
    } catch (settlementError) {
      // error-policy:J7 The provider result remains the primary failure; loss
      // of the no-replay update is separately visible to the agent.
      client.runtime.reportError(scope, settlementError, context);
    }
    throw error;
  }

  try {
    await client.setIdentityCache(
      session.profile,
      suffix,
      "delivered",
      session,
    );
  } catch (error) {
    // error-policy:J7 X accepted the effect and the pre-egress marker remains,
    // so a richer receipt can fail without converting the effect into a retry.
    client.runtime.reportError(scope, error, context);
  }

  return { executed: true, value };
}

export async function executeSettledXAction<T>(
  options: XActionSettlementOptions<T>,
): Promise<XActionSettlement<T>> {
  const key = options.client.identityCacheKey(
    options.session.profile,
    options.suffix,
  );
  const active = activeActionClaims.get(key);
  if (active) {
    await active;
    return { executed: false };
  }

  const pending = executeClaimedXAction(options);
  activeActionClaims.set(key, pending as Promise<XActionSettlement<unknown>>);
  try {
    return await pending;
  } finally {
    activeActionClaims.delete(key);
  }
}
