// agreely check [customerId] [category] [purpose] [--batch <file.json>] [--json]
//
// Single mode (no --batch): check one (customerId, category, purpose) cell.
//   ALLOW -> exit 0, DENY -> exit 10 (a clean negative, NOT an error).
// An outage throws AgreelyUnavailableError from the SDK -> the top-level mapper
// resolves it to exit 4 (distinct from deny), honouring the fail-closed default.
// A lapsed company subscription throws AgreelyBillingInactiveError (HTTP 402) ->
// exit 7 (distinct from both deny and outage): fail-closed, but actionable.
//
// Batch mode (--batch <file>): read a JSON array of {customerRef, category, purpose},
//   call checkBatch() once, and print a decisions table (human) or JSON array (agent).
//   Exit 0 when ALL allow; exit 10 when ANY deny.
//
// category/purpose are sent RAW (the server normalizes). They may be given in French OR
// English, with or without accents, matched case- and whitespace-insensitively; English
// resolves only when the company disclosed an English label, and ambiguous/undeclared
// labels fail closed.

import { readFile } from "node:fs/promises";
import type { BatchCheckItem, BatchDecision, CheckResult } from "@agreely/sdk";
import { AgreelyValidationError } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { EXIT } from "../errors.js";
import { emitJson, emitLine, pc } from "../output.js";

export async function checkCommand(
  ctx: Context,
  customerId: string | undefined,
  category: string | undefined,
  purpose: string | undefined,
  batchFile?: string,
): Promise<void> {
  if (batchFile !== undefined) {
    await batchMode(ctx, batchFile);
  } else {
    await singleMode(ctx, customerId, category, purpose);
  }
}

async function singleMode(
  ctx: Context,
  customerId: string | undefined,
  category: string | undefined,
  purpose: string | undefined,
): Promise<void> {
  if (!customerId || !category || !purpose) {
    throw new AgreelyValidationError(
      "Provide <customerId> <category> <purpose> or use --batch <file.json>.",
      { code: "invalid_request", status: 422 },
    );
  }
  const { client } = await buildClient(ctx);
  const result: CheckResult = await client.checkDetailed(customerId, category, purpose);
  const allowed = result.decision === "allow";

  if (ctx.agent) {
    emitJson(ctx, {
      decision: result.decision,
      status: result.status,
      ...(result.consentRef !== undefined ? { consentRef: result.consentRef } : {}),
    });
  } else if (allowed) {
    const ref = result.consentRef ? pc.dim(` ref ${result.consentRef}`) : "";
    emitLine(
      ctx,
      `${pc.green("✓ ALLOW")}  ${pc.bold(customerId)} · ${category} / ${purpose}  ` +
        `${pc.dim(`(${result.status})`)}${ref}`,
    );
  } else {
    emitLine(
      ctx,
      `${pc.red("✗ DENY")}   ${pc.bold(customerId)} · ${category} / ${purpose}  ` +
        `${pc.dim(`(${result.status})`)}`,
    );
  }

  ctx.exit = allowed ? EXIT.OK : EXIT.DENY;
}

async function batchMode(ctx: Context, filePath: string): Promise<void> {
  let items: BatchCheckItem[];
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new AgreelyValidationError(
        `${filePath}: expected a JSON array of {customerRef, category, purpose} objects.`,
        { code: "invalid_request", status: 422 },
      );
    }
    items = parsed.map((entry: unknown, idx: number) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as Record<string, unknown>)["customerRef"] !== "string" ||
        typeof (entry as Record<string, unknown>)["category"] !== "string" ||
        typeof (entry as Record<string, unknown>)["purpose"] !== "string"
      ) {
        throw new AgreelyValidationError(
          `${filePath}[${idx}]: each item must be {customerRef: string, category: string, purpose: string}.`,
          { code: "invalid_request", status: 422 },
        );
      }
      const e = entry as { customerRef: string; category: string; purpose: string };
      return { customerRef: e.customerRef, category: e.category, purpose: e.purpose };
    });
  } catch (err) {
    if (err instanceof AgreelyValidationError) throw err;
    throw new AgreelyValidationError(
      `Could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { code: "invalid_request", status: 422 },
    );
  }

  const { client } = await buildClient(ctx);
  const decisions: BatchDecision[] = await client.checkBatch(items);

  const anyDeny = decisions.some((d) => d.decision === "deny");

  if (ctx.agent) {
    emitJson(ctx, decisions.map((d) => ({
      customerRef: d.customerRef,
      category: d.category,
      purpose: d.purpose,
      decision: d.decision,
      status: d.status,
      ...(d.consentRef !== undefined ? { consentRef: d.consentRef } : {}),
    })));
  } else {
    for (const d of decisions) {
      if (d.decision === "allow") {
        const ref = d.consentRef ? pc.dim(` ref ${d.consentRef}`) : "";
        emitLine(
          ctx,
          `${pc.green("✓ ALLOW")}  ${pc.bold(d.customerRef)} · ${d.category} / ${d.purpose}  ` +
            `${pc.dim(`(${d.status})`)}${ref}`,
        );
      } else {
        emitLine(
          ctx,
          `${pc.red("✗ DENY")}   ${pc.bold(d.customerRef)} · ${d.category} / ${d.purpose}  ` +
            `${pc.dim(`(${d.status})`)}`,
        );
      }
    }
  }

  ctx.exit = anyDeny ? EXIT.DENY : EXIT.OK;
}
