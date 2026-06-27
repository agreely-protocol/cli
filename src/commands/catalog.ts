// agreely catalog [--json] — read-only discovery of the company's declared
// active (category, purpose) entries, for composing issuance.

import type { CatalogEntry } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { emitJson, emitLine, note, pc } from "../output.js";

export async function catalogCommand(ctx: Context): Promise<void> {
  const { client } = await buildClient(ctx);
  const entries: CatalogEntry[] = await client.catalog.list();

  if (ctx.agent) {
    emitJson(ctx, { catalog: entries });
    return;
  }

  if (entries.length === 0) {
    note(ctx, pc.dim("No declared catalog entries."));
    return;
  }
  emitLine(ctx, pc.bold(`Catalog (${entries.length})`));
  for (const e of entries) {
    const desc = e.description ? pc.dim(` — ${e.description}`) : "";
    emitLine(ctx, `  ${pc.cyan(e.category)} / ${e.purpose}${desc}`);
    emitLine(ctx, `    ${pc.dim(e.id)}`);
  }
}
