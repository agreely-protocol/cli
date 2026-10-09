// agreely holds place   <customerRef> --ground <rights_request|other_law> [--provision <t>]
//                       [--rule <key> ...] [--cell <id> ...] [--started-on <date>] [--review-on <date>]
//                       [--idempotency-key <k>]
// agreely holds release <customerRef> <holdId> --reason <text> [--idempotency-key <k>]
// agreely holds list    [--changed-since <cursor>] [--page-token <t>]      (ONE page, scope 'holds')
// agreely holds sync    [--changed-since <cursor>] [--max-pages <n>]       (EVERY page, scope 'holds')
//
// place/release use scope 'registry'. A hold with no --rule and no --cell covers everything.
// An other_law hold REQUIRES --provision (the law that requires keeping the information);
// a rights_request hold refuses one. The feed pages with pageToken/nextPageToken and only
// the LAST page carries `cursor`: keep it, it is the next sync's --changed-since. `sync`
// walks every page (default bound 1000, raise it with --max-pages) and throws rather than
// print a partial feed. Delivery is at least once:
// upsert by id. Without --changed-since the feed is a snapshot of every active hold; with
// it, a delta. The daily caps (429 hold_budget_exhausted, hold_release_cap_reached) exit 8.

import type { PlaceHoldInput, PlacedHold, ReleasedHold, RetentionHoldPage, HoldsSync } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { assertDate, keyOrNew, need, rawRef, oneOf, opt } from "../flags.js";
import { emitJson, emitLine, pc } from "../output.js";

const GROUNDS = ["rights_request", "other_law"] as const;

export interface HoldsPlaceFlags {
  ground?: string;
  provision?: string;
  rule?: string[];
  cell?: string[];
  startedOn?: string;
  reviewOn?: string;
  idempotencyKey?: string;
}

function checkDate(value: string | undefined, name: string): string | undefined {
  const v = opt(value);
  return v !== undefined ? assertDate(v, name) : undefined;
}

export async function holdsPlaceCommand(ctx: Context, customerRef: string, flags: HoldsPlaceFlags): Promise<void> {
  const ref = rawRef(customerRef, "<customerRef>");
  const ground = oneOf(need(flags.ground, "--ground"), GROUNDS, "--ground");
  const provision = opt(flags.provision);
  if (ground === "other_law" && provision === undefined) {
    throw new UsageError('--provision "<text>" is required for an other_law hold: name the law that requires keeping the information.');
  }
  if (ground === "rights_request" && provision !== undefined) {
    throw new UsageError("--provision applies to an other_law hold only.");
  }
  const rules = (flags.rule ?? []).map((r) => r.trim()).filter((r) => r !== "");
  const cells = (flags.cell ?? []).map((c) => c.trim()).filter((c) => c !== "");
  const startedOn = checkDate(flags.startedOn, "--started-on");
  const reviewOn = checkDate(flags.reviewOn, "--review-on");
  const key = keyOrNew(flags.idempotencyKey);
  ctx.retryKey = key;

  const common = {
    scope: rules.length === 0 && cells.length === 0 ? ("all" as const) : { rules, cells },
    ...(startedOn !== undefined ? { startedOn } : {}),
    ...(reviewOn !== undefined ? { reviewOn } : {}),
  };
  const input: PlaceHoldInput =
    ground === "other_law"
      ? { ...common, ground, provision: provision as string }
      : { ...common, ground };

  const { client } = await buildClient(ctx, { write: true });
  const hold: PlacedHold = await client.retention.placeHold(ref, input, { idempotencyKey: key });

  if (ctx.agent) {
    emitJson(ctx, hold);
    return;
  }
  emitLine(ctx, `${pc.green("✓")} Hold placed ${pc.bold(hold.id)}${hold.replayed ? pc.dim(" (replayed)") : ""}`);
  emitLine(ctx, `  ${pc.bold("customer")}   ${hold.customerRef}`);
  emitLine(ctx, `  ${pc.bold("status")}     ${hold.status}`);
  emitLine(ctx, `  ${pc.bold("scope")}      ${scopeLabel(hold.scope)}`);
  emitLine(ctx, `  ${pc.bold("startedOn")}  ${hold.startedOn}`);
}

export interface HoldsReleaseFlags {
  reason?: string;
  idempotencyKey?: string;
}

export async function holdsReleaseCommand(
  ctx: Context,
  customerRef: string,
  holdId: string,
  flags: HoldsReleaseFlags,
): Promise<void> {
  const ref = rawRef(customerRef, "<customerRef>");
  const id = need(holdId, "<holdId>");
  const reason = need(flags.reason, '--reason "<text>"');
  const key = keyOrNew(flags.idempotencyKey);
  ctx.retryKey = key;

  const { client } = await buildClient(ctx, { write: true });
  const released: ReleasedHold = await client.retention.releaseHold(
    ref,
    id,
    { reason },
    { idempotencyKey: key },
  );

  if (ctx.agent) {
    emitJson(ctx, released);
    return;
  }
  emitLine(ctx, `${pc.green("✓")} Hold released ${pc.bold(released.id)}`);
  emitLine(ctx, `  ${pc.bold("placedBy")}         ${released.placedBy}`);
  emitLine(ctx, `  ${pc.bold("agreelyIdentity")}  ${released.agreelyIdentity ?? "n/a"}`);
}

export interface HoldsListFlags {
  changedSince?: string;
  pageToken?: string;
}

export async function holdsListCommand(ctx: Context, flags: HoldsListFlags): Promise<void> {
  const changedSince = opt(flags.changedSince);
  const pageToken = opt(flags.pageToken);
  const { client } = await buildClient(ctx);
  const page: RetentionHoldPage = await client.retention.listHolds({
    ...(changedSince !== undefined ? { changedSince } : {}),
    ...(pageToken !== undefined ? { pageToken } : {}),
  });

  if (ctx.agent) {
    emitJson(ctx, page);
    return;
  }
  for (const h of page.holds) {
    emitLine(ctx, `${h.id}  ${h.customerRef}  ${h.status}  ${scopeLabel(h.scope)}  ${pc.dim(h.changedAt)}`);
  }
  emitLine(ctx, pc.dim(`${page.holds.length} hold(s) on this page`));
  if (page.nextPageToken !== null) {
    emitLine(ctx, `${pc.bold("nextPageToken")} ${page.nextPageToken}  ${pc.dim("(pass it as --page-token)")}`);
  }
  if (page.cursor !== null) {
    emitLine(ctx, `${pc.bold("cursor")} ${page.cursor}  ${pc.dim("(last page: keep it as the next --changed-since)")}`);
  }
}

export interface HoldsSyncFlags {
  changedSince?: string;
  maxPages?: string;
}

export async function holdsSyncCommand(ctx: Context, flags: HoldsSyncFlags): Promise<void> {
  const changedSince = opt(flags.changedSince);
  const maxPagesFlag = opt(flags.maxPages);
  let maxPages: number | undefined;
  if (maxPagesFlag !== undefined) {
    maxPages = Number(maxPagesFlag);
    if (!Number.isInteger(maxPages) || maxPages < 1) {
      throw new UsageError(`--max-pages "${maxPagesFlag}" must be a positive integer.`);
    }
  }
  const { client } = await buildClient(ctx);
  const sync: HoldsSync = await client.retention.syncHolds({
    ...(changedSince !== undefined ? { changedSince } : {}),
    ...(maxPages !== undefined ? { maxPages } : {}),
  });

  if (ctx.agent) {
    emitJson(ctx, sync);
    return;
  }
  const meaning = sync.mode === "snapshot" ? "every active hold: replace your whole set" : "holds placed or released since: upsert by id";
  emitLine(ctx, `${pc.green("✓")} ${sync.mode} of ${sync.holds.length} hold(s) ${pc.dim(`(${meaning})`)}`);
  for (const h of sync.holds) {
    emitLine(ctx, `${h.id}  ${h.customerRef}  ${h.status}  ${scopeLabel(h.scope)}  ${pc.dim(h.changedAt)}`);
  }
  emitLine(ctx, `${pc.bold("cursor to keep")} ${sync.cursor}  ${pc.dim("(the next sync's --changed-since)")}`);
}

function scopeLabel(scope: PlacedHold["scope"]): string {
  return scope === "all" ? "all" : `rules [${scope.rules.join(", ")}] cells [${scope.cells.join(", ")}]`;
}
