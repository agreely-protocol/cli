// agreely request create
//
//   Agent / scriptable:
//     --customer <id> --to <email> --item <id|cat:purpose> [--item ...]
//     --valid-until <YYYY-MM-DD> [--json] [--idempotency-key <k>]
//
//   Human (a TTY, no scriptable flags): an interactive wizard — catalog.list()
//   to pick cells, then customer, recipient email, valid-until, with validation
//   and a final confirm. Agent mode NEVER prompts.

import * as prompts from "@clack/prompts";
import type {
  Agreely,
  CatalogEntry,
  CreateConsentRequestInput,
  IssuedRequest,
} from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { buildCreateInput, type CreateFlags } from "../create-input.js";
import { UsageError } from "../errors.js";
import { emitJson, emitLine, note, pc } from "../output.js";

export interface CreateCommandFlags extends CreateFlags {
  idempotencyKey?: string;
}

function hasScriptableFlags(flags: CreateCommandFlags): boolean {
  return Boolean(flags.customer || flags.to || flags.validUntil || (flags.item && flags.item.length > 0));
}

export async function requestCreateCommand(ctx: Context, flags: CreateCommandFlags): Promise<void> {
  const { client } = await buildClient(ctx);

  let input: CreateConsentRequestInput;
  if (ctx.agent || hasScriptableFlags(flags)) {
    // Agent mode (or a human who passed flags): no prompts, validate and go.
    input = buildCreateInput(flags);
  } else {
    // A human at a TTY with no flags: the interactive wizard.
    const collected = await runWizard(ctx, client);
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
  emitLine(ctx, `  ${pc.bold("email")}      ${created.emailDelivered ? "delivered" : "not delivered"}`);
  emitLine(ctx, `  ${pc.bold("deepLink")}   ${created.deepLink}`);
  for (const it of created.items) {
    emitLine(ctx, `    · ${pc.cyan(it.category)} / ${it.purpose}`);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function runWizard(
  ctx: Context,
  client: Agreely,
): Promise<CreateConsentRequestInput | null> {
  prompts.intro(pc.bold("Issue a consent request"));

  const catalog: CatalogEntry[] = await client.catalog.list();
  if (catalog.length === 0) {
    note(ctx, pc.yellow("No declared catalog entries — declare a catalog in the company UI first."));
    prompts.cancel("Nothing to request.");
    return null;
  }

  const picked = await prompts.multiselect({
    message: "Which cells do you want consent for?",
    options: catalog.map((e) => ({
      value: e.id,
      label: `${e.category} / ${e.purpose}`,
      ...(e.description ? { hint: e.description } : {}),
    })),
    required: true,
  });
  if (prompts.isCancel(picked)) return cancelled();

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

  const confirm = await prompts.confirm({
    message: `Issue to ${pc.bold(String(to))} for ${(picked as string[]).length} cell(s)?`,
  });
  if (prompts.isCancel(confirm) || confirm === false) return cancelled();

  prompts.outro(pc.dim("Sending…"));

  return {
    customerId: String(customer).trim(),
    recipientEmail: String(to).trim(),
    items: picked as string[],
    validUntil: String(validUntil).trim(),
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
