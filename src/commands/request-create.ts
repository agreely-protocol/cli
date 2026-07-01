// agreely request create
//
//   Agent / scriptable:
//     --customer <id> --to <email> (--document <versionId> | --document-code <code>)
//     --valid-until <YYYY-MM-DD> [--json] [--idempotency-key <k>]
//
//   Human (a TTY, no scriptable flags): an interactive wizard — the published
//   consent document reference (the Law 25 s. 8 disclosure the request is
//   issued under; find it under Consent documents in the company workspace),
//   then customer, recipient email, valid-until, with validation and a final
//   confirm. Agent mode NEVER prompts.
//
//   The requested (category, purpose) items derive from the bound document
//   server-side; there is no --item flag on this command.

import * as prompts from "@clack/prompts";
import type { CreateConsentRequestInput, IssuedRequest } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { buildCreateInput, type CreateFlags } from "../create-input.js";
import { UsageError } from "../errors.js";
import { emitJson, emitLine, pc } from "../output.js";

export interface CreateCommandFlags extends CreateFlags {
  idempotencyKey?: string;
}

function hasScriptableFlags(flags: CreateCommandFlags): boolean {
  return Boolean(flags.customer || flags.to || flags.validUntil || flags.document || flags.documentCode);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requestCreateCommand(ctx: Context, flags: CreateCommandFlags): Promise<void> {
  const { client } = await buildClient(ctx);

  let input: CreateConsentRequestInput;
  if (ctx.agent || hasScriptableFlags(flags)) {
    // Agent mode (or a human who passed flags): no prompts, validate and go.
    input = buildCreateInput(flags);
  } else {
    // A human at a TTY with no flags: the interactive wizard.
    const collected = await runWizard();
    if (collected === null) return; // cancelled
    input = collected;
  }

  const created: IssuedRequest = await client.consentRequests.create(
    input,
    flags.idempotencyKey ? { idempotencyKey: flags.idempotencyKey } : {},
  );

  if (ctx.agent) {
    emitJson(ctx, created);
    return;
  }

  emitLine(ctx, `${pc.green("✓")} Consent request issued`);
  emitLine(ctx, `  ${pc.bold("requestId")}  ${created.requestId}`);
  emitLine(ctx, `  ${pc.bold("status")}     ${created.status}`);
  emitLine(ctx, `  ${pc.bold("document")}   ${created.document.name} v${created.document.version} (${created.document.code})`);
  emitLine(ctx, `  ${pc.bold("email")}      ${created.emailDelivered ? "delivered" : "not delivered"}`);
  emitLine(ctx, `  ${pc.bold("deepLink")}   ${created.deepLink}`);
  for (const it of created.items) {
    emitLine(ctx, `    · ${pc.cyan(it.category)} / ${it.purpose}`);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function runWizard(): Promise<CreateConsentRequestInput | null> {
  prompts.intro(pc.bold("Issue a consent request"));

  const documentRef = await prompts.text({
    message: "Published consent document (version id or code — see Consent documents in the workspace)",
    validate: (v) => (v && v.trim() !== "" ? undefined : "Required: the request is issued under a published consent document."),
  });
  if (prompts.isCancel(documentRef)) return cancelled();

  const customer = await prompts.text({
    message: "Customer id (your reference for the subject)",
    validate: (v) => (v && v.trim() !== "" ? undefined : "Required."),
  });
  if (prompts.isCancel(customer)) return cancelled();

  const to = await prompts.text({
    message: "Recipient email",
    validate: (v) => (EMAIL_RE.test(v ?? "") ? undefined : "A valid email is required."),
  });
  if (prompts.isCancel(to)) return cancelled();

  const validUntil = await prompts.text({
    message: "Valid until (YYYY-MM-DD)",
    validate: (v) => (DATE_RE.test(v ?? "") ? undefined : "Use YYYY-MM-DD."),
  });
  if (prompts.isCancel(validUntil)) return cancelled();

  const ref = String(documentRef).trim();
  const confirm = await prompts.confirm({
    message: `Issue to ${pc.bold(String(to))} under document ${pc.bold(ref)}?`,
  });
  if (prompts.isCancel(confirm) || confirm === false) return cancelled();

  prompts.outro(pc.dim("Sending…"));

  return {
    customerId: String(customer).trim(),
    recipientEmail: String(to).trim(),
    validUntil: String(validUntil).trim(),
    // A uuid-shaped reference is the version id; anything else is a code.
    ...(UUID_RE.test(ref) ? { consentDocumentId: ref } : { documentCode: ref }),
  };
}

function cancelled(): null {
  prompts.cancel("Cancelled.");
  return null;
}

// Guard against an accidental import-time prompt in a non-TTY: this asserts the
// wizard is only reachable through the agent gate above.
export function assertInteractive(ctx: Context): void {
  if (ctx.agent) throw new UsageError("The create wizard cannot run in agent mode.");
}
