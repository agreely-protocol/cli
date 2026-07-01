// agreely request wait <requestId> [--interval <ms>] [--timeout <ms>] [--json]
// Polls the request until it settles (approved|refused|expired|revoked_before_action)
// or throws AgreelyTimeoutError (exit 4). requestId is the protocol 0x+64hex handle.

import type { ConsentRequestRecord } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { emitJson, emitLine, pc } from "../output.js";

const REQUEST_ID_RE = /^0x[0-9a-f]{64}$/;

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
  const intervalMs = parsePositiveInt(flags.interval, "--interval");
  const timeoutMs = parsePositiveInt(flags.timeout, "--timeout");

  const { client } = await buildClient(ctx);
  const settled: ConsentRequestRecord = await client.consentRequests.waitForSettlement(requestId, {
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });

  if (ctx.agent) {
    emitJson(ctx, settled);
    return;
  }

  emitLine(ctx, `${pc.green("✓")} Settled ${pc.bold(settled.requestId)}`);
  emitLine(ctx, `  status      ${settled.status}`);
  emitLine(ctx, `  settledAt   ${settled.settledAt ?? pc.dim("—")}`);
}

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} must be a positive integer (ms).`);
  return n;
}
