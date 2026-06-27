// agreely request show <requestId> [--json]
// requestId is the protocol handle: 0x + 64 hex.

import type { ConsentRequestRecord } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { emitJson, emitLine, pc } from "../output.js";

const REQUEST_ID_RE = /^0x[0-9a-f]{64}$/;

export async function requestShowCommand(ctx: Context, requestId: string): Promise<void> {
  if (!REQUEST_ID_RE.test(requestId)) {
    throw new UsageError(`"${requestId}" is not a valid requestId (expected 0x + 64 hex).`);
  }

  const { client } = await buildClient(ctx);
  const record: ConsentRequestRecord = await client.consentRequests.get(requestId);

  if (ctx.agent) {
    emitJson(ctx, record);
    return;
  }

  emitLine(ctx, pc.bold(record.requestId));
  emitLine(ctx, `  status      ${record.status}`);
  emitLine(ctx, `  validUntil  ${record.validUntil}`);
  emitLine(ctx, `  expiresAt   ${record.expiresAt}`);
  emitLine(ctx, `  createdAt   ${record.createdAt}`);
  emitLine(ctx, `  settledAt   ${record.settledAt ?? pc.dim("—")}`);
  for (const it of record.items) {
    emitLine(ctx, `    · ${pc.cyan(it.category)} / ${it.purpose}`);
  }
}
