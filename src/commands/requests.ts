// agreely requests [--status ...] [--cursor <id>] [--json]
//
// Cursor pagination. Agent mode returns ONE raw page ({items, nextCursor}) so a
// caller can drive the cursor itself. Human mode prints the page and hints how to
// fetch the next one.

import type { ConsentRequestPage, ConsentRequestStatus, ListConsentRequestsInput } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { emitJson, emitLine, note, pc } from "../output.js";

const STATUSES: ConsentRequestStatus[] = [
  "pending",
  "approved",
  "refused",
  "expired",
  "revoked_before_action",
];

export interface RequestsFlags {
  status?: string;
  cursor?: string;
}

export async function requestsCommand(ctx: Context, flags: RequestsFlags): Promise<void> {
  const { client } = await buildClient(ctx);

  const input: ListConsentRequestsInput = {};
  if (flags.status !== undefined) {
    if (!STATUSES.includes(flags.status as ConsentRequestStatus)) {
      throw new UsageError(`Invalid --status "${flags.status}". One of: ${STATUSES.join(", ")}.`);
    }
    input.status = flags.status as ConsentRequestStatus;
  }
  if (flags.cursor !== undefined) input.cursor = flags.cursor;

  const page: ConsentRequestPage = await client.consentRequests.list(input);

  if (ctx.agent) {
    emitJson(ctx, page);
    return;
  }

  if (page.items.length === 0) {
    note(ctx, pc.dim("No consent requests."));
    return;
  }
  emitLine(ctx, pc.bold(`Requests (${page.items.length})`));
  for (const r of page.items) {
    emitLine(ctx, `  ${statusColor(r.status)}  ${r.requestId}  ${pc.dim(r.createdAt)}`);
  }
  if (page.nextCursor) {
    note(ctx, pc.dim(`More: agreely requests --cursor ${page.nextCursor}`));
  }
}

function statusColor(status: ConsentRequestStatus): string {
  switch (status) {
    case "approved":
      return pc.green(status.padEnd(21));
    case "pending":
      return pc.yellow(status.padEnd(21));
    case "refused":
    case "revoked_before_action":
      return pc.red(status.padEnd(21));
    default:
      return pc.dim(status.padEnd(21));
  }
}
