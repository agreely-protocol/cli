// agreely request wait <requestId> [--interval <ms>] [--timeout <ms>] [--json]
// Polls the request until it settles (any status other than "pending": approved,
// asks_declined, refused, expired or revoked_before_action) or throws
// AgreelyTimeoutError (exit 4). requestId is the protocol 0x+64hex handle.
//
// WHY NOT consentRequests.waitForSettlement(). In @agreely/sdk 0.3.0 its terminal set
// predates "asks_declined" (the person declined every consent ask), so a request that
// settled that way polled on until the budget ran out and exited 4 as if nothing had
// happened. The loop here settles on anything that is no longer pending, which also
// stays correct if the server ever adds another terminal status.

import type { ConsentRequestRecord } from "@agreely/sdk";
import { AgreelyRateLimitError, AgreelyTimeoutError } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { emitJson, emitLine, pc } from "../output.js";

const REQUEST_ID_RE = /^0x[0-9a-f]{64}$/;
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface RequestWaitFlags {
  interval?: string;
  timeout?: string;
}

export async function requestWaitCommand(
  ctx: Context,
  requestId: string,
  flags: RequestWaitFlags,
): Promise<void> {
  if (!REQUEST_ID_RE.test(requestId)) {
    throw new UsageError(`"${requestId}" is not a valid requestId (expected 0x + 64 hex).`);
  }
  const intervalMs = parsePositiveInt(flags.interval, "--interval") ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = parsePositiveInt(flags.timeout, "--timeout") ?? DEFAULT_TIMEOUT_MS;

  const { client } = await buildClient(ctx);
  const deadline = Date.now() + timeoutMs;
  let settled: ConsentRequestRecord | undefined;
  let lastStatus: string | undefined;
  while (settled === undefined) {
    let waitMs = intervalMs;
    try {
      const record = await client.consentRequests.get(requestId);
      lastStatus = record.status;
      if ((record.status as string) !== "pending") {
        settled = record;
        break;
      }
    } catch (err) {
      // A 429 waits out Retry-After within the budget; every other error surfaces.
      if (!(err instanceof AgreelyRateLimitError)) throw err;
      waitMs = (err.retryAfterSeconds ?? Math.ceil(intervalMs / 1000)) * 1000;
    }
    if (Date.now() + waitMs >= deadline) {
      throw new AgreelyTimeoutError(
        `request wait timed out after ${String(timeoutMs)}ms` +
          (lastStatus !== undefined ? `; last status "${lastStatus}".` : "."),
        { ...(lastStatus !== undefined ? { lastStatus } : {}) },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  if (ctx.agent) {
    emitJson(ctx, settled);
    return;
  }

  emitLine(ctx, `${pc.green("✓")} Settled ${pc.bold(settled.requestId)}`);
  emitLine(ctx, `  status      ${settled.status}`);
  emitLine(ctx, `  settledAt   ${settled.settledAt ?? pc.dim("none")}`);
}

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} must be a positive integer (ms).`);
  return n;
}
