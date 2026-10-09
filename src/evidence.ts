// The signed-paper evidence shared by `manual-consent create` and `verbal-consent
// paper`. The PDF is hashed LOCALLY (node crypto): only the "0x"+sha256 commitment is
// sent by default, and the bytes leave the machine ONLY on an explicit --upload.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { UsageError } from "./errors.js";

const PDF_MAGIC = Buffer.from("%PDF-");

export interface Evidence {
  pdfSha256: string;
  pdf?: string;
}

/** Read the signed PDF, validate it, and build the evidence object. Throws UsageError. */
export async function readEvidence(path: string | undefined, upload: boolean): Promise<Evidence> {
  const pdfPath = path?.trim();
  if (!pdfPath) throw new UsageError("--pdf <path> is required (its SHA-256 is computed locally).");

  let bytes: Buffer;
  try {
    bytes = await readFile(pdfPath);
  } catch {
    throw new UsageError(`Could not read --pdf "${pdfPath}".`);
  }
  if (bytes.length === 0) {
    throw new UsageError(`--pdf "${pdfPath}" is empty: hash the scanned signed sheet itself.`);
  }
  if (upload && !bytes.subarray(0, 5).equals(PDF_MAGIC)) {
    throw new UsageError(`--pdf "${pdfPath}" is not a PDF (no %PDF- header); the server refuses it on --upload.`);
  }
  return {
    pdfSha256: "0x" + createHash("sha256").update(bytes).digest("hex"),
    ...(upload ? { pdf: bytes.toString("base64") } : {}),
  };
}
