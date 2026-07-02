// agreely relationship end <customerRef> --reason "..." [--json]
// Ends a customer relationship (Law 25 art. 23, "les fins sont accomplies") from
// the company's own tooling. Scope: 'relationship'. The customerRef is the
// company's OWN reference (the same ref used by `check`), never a DID. --reason is
// REQUIRED and enforced BEFORE any network call: a missing reason is a usage error
// (exit 2), never a silent end. Errors funnel through the central exit mapper (a
// bad/scope-less key -> 3, an unknown/foreign ref -> 2).

import type { RelationshipEnded } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { emitJson, emitLine, pc } from "../output.js";

export interface RelationshipEndFlags {
  reason?: string;
}

export async function relationshipEndCommand(
  ctx: Context,
  customerRef: string,
  flags: RelationshipEndFlags,
): Promise<void> {
  const ref = customerRef?.trim();
  if (!ref) {
    throw new UsageError("<customerRef> is required.");
  }
  const reason = flags.reason?.trim();
  if (!reason) {
    throw new UsageError(
      '--reason "<text>" is required: the end of the relationship must carry its justification (art. 23).',
    );
  }

  const { client } = await buildClient(ctx);
  const result: RelationshipEnded = await client.relationships.end({ customerRef: ref, reason });

  if (ctx.agent) {
    emitJson(ctx, result);
    return;
  }

  emitLine(ctx, `${pc.green("✓")} Relationship ended ${pc.bold(result.customerRef)}`);
  emitLine(ctx, `  status   ${result.status}`);
  emitLine(ctx, `  endedAt  ${result.endedAt}`);
  emitLine(ctx, `  endedBy  ${result.endedBy}`);
}
