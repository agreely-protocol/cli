// agreely request cancel <requestId> [--json]
// requestId is the protocol handle: 0x + 64 hex. Scope: 'issue'. Cancels a still-
// PENDING request (the "revoke before action" path). IDEMPOTENT: cancelling an
// already-terminal request is NOT an error — it reports cancelled:false with the
// current status and still exits 0. Errors funnel through the central exit mapper
// (a bad/scope-less key -> 3, an unknown id -> 2).

import type { CancelledRequest } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { emitJson, emitLine, pc } from "../output.js";

const REQUEST_ID_RE = /^0x[0-9a-f]{64}$/;

export async function requestCancelCommand(ctx: Context, requestId: string): Promise<void> {
  if (!REQUEST_ID_RE.test(requestId)) {
    throw new UsageError(`"${requestId}" is not a valid requestId (expected 0x + 64 hex).`);
  }

  const { client } = await buildClient(ctx);
  const result: CancelledRequest = await client.consentRequests.cancel(requestId);

  if (ctx.agent) {
    emitJson(ctx, result);
    return;
  }

  if (result.cancelled) {
    emitLine(ctx, `${pc.green("✓")} Cancelled ${pc.bold(result.requestId)}`);
  } else {
    emitLine(ctx, `${pc.green("✓")} No change ${pc.bold(result.requestId)} ${pc.dim(`(already ${result.status})`)}`);
  }
  emitLine(ctx, `  status  ${result.status}`);
}
