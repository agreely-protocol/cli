// agreely catalog [--document <code>] [--json] — read-only discovery of the company's declared
// active (category, purpose) entries, for composing issuance. With --document, only
// the active cells of ONE published document, with the regime and the version id
// published today (an intake form and the version to record against, in one call).
// Never decide consent from the catalog: only `check` says what a person consented to.

import type { CatalogEntry, DocumentCatalog } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { emitJson, emitLine, note, pc } from "../output.js";

export async function catalogCommand(ctx: Context, flags: { document?: string } = {}): Promise<void> {
  const { client } = await buildClient(ctx);
  const documentCode = flags.document?.trim();
  let entries: CatalogEntry[];
  let scoped: Pick<DocumentCatalog, "regime" | "document"> | undefined;
  if (documentCode) {
    const doc = await client.catalog.forDocument(documentCode);
    entries = doc.catalog;
    scoped = { regime: doc.regime, document: doc.document };
  } else {
    entries = await client.catalog.list();
  }

  if (ctx.agent) {
    emitJson(ctx, scoped ? { ...scoped, catalog: entries } : { catalog: entries });
    return;
  }
  if (scoped) {
    emitLine(ctx, `${pc.bold(scoped.document.code)}  documentVersionId ${scoped.document.documentVersionId}  ${pc.dim(`regime ${JSON.stringify(scoped.regime)}`)}`);
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
