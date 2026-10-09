// agreely documents list
// agreely documents show <code>
// agreely documents pdf <documentVersionId> --out <file.pdf> [--locale <fr|en>] [--force]
//
// Read-only discovery of the organisation's PUBLISHED consent documents, so a script
// resolves the documentVersionId that the manual, verbal and consent-sheet commands take.
// Pin the stable `code`, not the version id: the id goes stale on the next publication.
// `pdf` writes the information document of one version to a file (never to stdout) to
// hand to the person; fetching it records nothing and is not evidence anyone was informed.

import type { ConsentDocumentDetail, ConsentDocumentSummary } from "@agreely/sdk";
import { buildClient } from "../auth.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { assertWritable, need, oneOf, opt, writeBytes } from "../flags.js";
import { emitJson, emitLine, pc } from "../output.js";

export async function documentsListCommand(ctx: Context): Promise<void> {
  const { client } = await buildClient(ctx);
  const docs: ConsentDocumentSummary[] = await client.consentDocuments.list();
  if (ctx.agent) {
    emitJson(ctx, docs);
    return;
  }
  if (docs.length === 0) {
    emitLine(ctx, "No published consent document.");
    return;
  }
  for (const d of docs) {
    emitLine(ctx, `${pc.bold(d.code)}  ${d.name}  ${pc.dim(`v${d.version}, effective ${d.effectiveDate}`)}`);
    emitLine(ctx, `  documentVersionId ${d.documentVersionId}  ${pc.dim(`${d.items.length} item(s)`)}`);
  }
}

export async function documentsShowCommand(ctx: Context, code: string): Promise<void> {
  const c = need(code, "<code>");
  const { client } = await buildClient(ctx);
  const d: ConsentDocumentDetail = await client.consentDocuments.get(c);
  if (ctx.agent) {
    emitJson(ctx, d);
    return;
  }
  emitLine(ctx, `${pc.bold(d.code)}  ${d.name}  ${pc.dim(`v${d.version}, effective ${d.effectiveDate}`)}`);
  emitLine(ctx, `  documentVersionId  ${d.documentVersionId}`);
  emitLine(ctx, `  responsable        ${d.responsable.name} (${d.responsable.contact})`);
  emitLine(ctx, `  integrity          ${d.integrity.anchorStatus}${d.integrity.ipfsCid ? `, ipfs ${d.integrity.ipfsCid}` : ""}`);
  for (const i of d.items) {
    emitLine(ctx, `    · ${i.category} / ${i.purpose}${i.sensitive ? pc.yellow("  sensitive") : ""}  ${pc.dim(i.id)}`);
  }
  emitLine(ctx, pc.dim("  Use --json for the full disclosure text."));
}

export interface DocumentsPdfFlags {
  out?: string;
  locale?: string;
  force?: boolean;
}

export async function documentsPdfCommand(
  ctx: Context,
  documentVersionId: string,
  flags: DocumentsPdfFlags,
): Promise<void> {
  const id = need(documentVersionId, "<documentVersionId>");
  const out = need(flags.out, "--out <file.pdf>");
  const locale = oneOf(opt(flags.locale) ?? "fr", ["fr", "en"] as const, "--locale");
  if (out === "-") throw new UsageError("--out must be a file path: the PDF is never written to stdout.");
  await assertWritable(out, flags.force === true);

  const { client } = await buildClient(ctx);
  const doc = await client.consentDocuments.getInformationPdf(id, { locale });
  await writeBytes(out, doc.pdf);

  if (ctx.agent) {
    emitJson(ctx, { documentVersionId: id, locale, file: out, bytes: doc.pdf.length, filename: doc.filename, contentType: doc.contentType });
    return;
  }
  emitLine(ctx, `${pc.green("✓")} Information document written to ${pc.bold(out)} ${pc.dim(`(${doc.pdf.length} bytes, ${locale})`)}`);
}
