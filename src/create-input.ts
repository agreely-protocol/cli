// Pure mapping from CLI flags to the SDK's CreateConsentRequestInput. Kept apart
// from the command so it is trivially unit-testable. Every consent request is
// issued under a PUBLISHED consent document (the Law 25 s. 8 disclosure):
// exactly one of --document (a version id) / --document-code is required, and
// the requested (category, purpose) items derive from the document server-side.
//
// parseItem stays for the manual-consent path, which still resolves items
// against its signed document's grid: a "category:purpose" value is split on
// the FIRST colon and passed through raw; the server resolves it.

import type { CreateConsentRequestInput, IssueItem } from "@agreely/sdk";
import { UsageError } from "./errors.js";

export interface CreateFlags {
  customer?: string;
  to?: string;
  document?: string;
  documentCode?: string;
  validUntil?: string;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse one --item value (manual-consent path). With a colon -> a raw
 * {category, purpose} pair (split on the first colon only). Without -> a
 * catalog entry id (an opaque string).
 */
export function parseItem(raw: string): IssueItem {
  const idx = raw.indexOf(":");
  if (idx === -1) {
    const id = raw.trim();
    if (id === "") throw new UsageError("An --item value cannot be empty.");
    return id;
  }
  const category = raw.slice(0, idx);
  const purpose = raw.slice(idx + 1);
  if (category.trim() === "" || purpose.trim() === "") {
    throw new UsageError(`Invalid --item "${raw}". Use a catalog id or "category:purpose".`);
  }
  return { category, purpose };
}

/** Build (and validate) the SDK input from the scriptable flags. Throws UsageError. */
export function buildCreateInput(flags: CreateFlags): CreateConsentRequestInput {
  const customerId = flags.customer?.trim();
  if (!customerId) throw new UsageError("--customer <id> is required.");

  const recipientEmail = flags.to?.trim();
  if (!recipientEmail) throw new UsageError("--to <email> is required.");
  if (!EMAIL_RE.test(recipientEmail)) throw new UsageError(`--to "${recipientEmail}" is not a valid email.`);

  const validUntil = flags.validUntil?.trim();
  if (!validUntil) throw new UsageError("--valid-until <YYYY-MM-DD> is required.");
  if (!DATE_RE.test(validUntil)) throw new UsageError(`--valid-until "${validUntil}" must be YYYY-MM-DD.`);

  const documentId = flags.document?.trim() ?? "";
  const documentCode = flags.documentCode?.trim() ?? "";
  if (documentId === "" && documentCode === "") {
    throw new UsageError(
      "--document <versionId> or --document-code <code> is required: every consent request is issued under a published consent document.",
    );
  }
  if (documentId !== "" && documentCode !== "") {
    throw new UsageError("Pass either --document or --document-code, not both.");
  }

  return {
    customerId,
    recipientEmail,
    validUntil,
    ...(documentId !== "" ? { consentDocumentId: documentId } : { documentCode }),
  };
}
