// Pure mapping from CLI flags to the SDK's CreateConsentRequestInput. Kept apart
// from the command so it is trivially unit-testable. category/purpose are NEVER
// normalized here — a "category:purpose" item is split on the FIRST colon and
// passed through raw; the server resolves it against the declared catalog.

import type { CreateConsentRequestInput, IssueItem } from "@agreely/sdk";
import { UsageError } from "./errors.js";

export interface CreateFlags {
  customer?: string;
  to?: string;
  item?: string[];
  validUntil?: string;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse one --item value. With a colon -> a raw {category, purpose} pair (split
 * on the first colon only). Without -> a catalog entry id (an opaque string).
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

  const rawItems = flags.item ?? [];
  if (rawItems.length === 0) {
    throw new UsageError("At least one --item <catalogId|category:purpose> is required.");
  }
  const items = rawItems.map(parseItem);

  return { customerId, recipientEmail, items, validUntil };
}
