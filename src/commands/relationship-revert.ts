// agreely relationship revert <customerRef> --reason "..." [--json]
// Undoes a mistaken company end of a customer relationship (Law 25 art. 11 / art. 28
// correction of an inaccurate record) — NOT a resurrection of dead consent. Scope:
// 'relationship'. The customerRef is the company's OWN reference (the same ref used
// by `check`), never a DID. --reason is REQUIRED and enforced BEFORE any network
// call: a missing reason is a usage error (exit 2), never a silent revert. Errors
// funnel through the central exit mapper (a bad/scope-less key -> 3; a
// non-undo-eligible or unknown/foreign ref -> a clean 404 -> 2).

import type { RelationshipReverted } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { emitJson, emitLine, pc } from "../output.js";

export interface RelationshipRevertFlags {
  reason?: string;
}

export async function relationshipRevertCommand(
  ctx: Context,
  customerRef: string,
  flags: RelationshipRevertFlags,
): Promise<void> {
  const ref = customerRef?.trim();
  if (!ref) {
    throw new UsageError("<customerRef> is required.");
  }
  const reason = flags.reason?.trim();
  if (!reason) {
    throw new UsageError(
      '--reason "<text>" is required: the correction of a mistaken end must carry its justification (art. 11 / art. 28).',
    );
  }

  const { client } = await buildClient(ctx);
  const result: RelationshipReverted = await client.relationships.revert({ customerRef: ref, reason });

  if (ctx.agent) {
    emitJson(ctx, result);
    return;
  }

  emitLine(ctx, `${pc.green("✓")} Relationship restored ${pc.bold(result.customerRef)}`);
  emitLine(ctx, `  status    ${result.status}`);
  emitLine(ctx, `  reverted  ${result.reverted}`);
}
