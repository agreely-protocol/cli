// The agent contract lives here: ONE central map from every outcome to a stable
// exit code. Agents branch on these numbers, so they must never drift.

import {
  AgreelyAuthError,
  AgreelyBillingInactiveError,
  AgreelyConfigError,
  AgreelyConflictError,
  AgreelyDailyCapError,
  AgreelyError,
  AgreelyNotFoundError,
  AgreelyRateLimitError,
  AgreelyTimeoutError,
  AgreelyUnavailableError,
  AgreelyValidationError,
} from "@agreely/sdk";

export const EXIT = {
  /** Success, or a check ALLOW. */
  OK: 0,
  /** An unexpected/uncategorised failure. */
  ERROR: 1,
  /** Bad CLI usage, missing/invalid args, a server validation error (including a 413), or a 409 state conflict. */
  USAGE: 2,
  /** The key was missing, invalid, revoked, or lacks the scope. */
  AUTH: 3,
  /** Agreely was unreachable (outage). DISTINCT from a deny. */
  UNAVAILABLE: 4,
  /** The per-company rate window was exceeded. */
  RATE_LIMITED: 5,
  /** A receipt was checked and did NOT verify (`agreely verify`). Not an error: a verdict. */
  VERIFY_FAILED: 6,
  /**
   * The company's Agreely subscription is inactive/lapsed (HTTP 402). DISTINCT
   * from an outage (4): actionable (the company must pay to restore service)
   * and fail-closed for gating (a lapsed biller never gets an allow).
   */
  BILLING_INACTIVE: 7,
  /**
   * A per-company DAILY cap (HTTP 429 withdrawal_daily_cap, verbal_daily_cap,
   * hold_budget_exhausted, hold_release_cap_reached). DISTINCT from the per-minute
   * window (5): retrying today cannot succeed, so an agent must not loop on it.
   */
  DAILY_CAP: 8,
  /**
   * The write SUCCEEDED but its output could not be saved (a PDF that could not be written
   * after the sheet was minted). The result was still printed: do NOT retry the call.
   */
  PARTIAL: 9,
  /** A clean check DENY: an expected negative, NOT an error. */
  DENY: 10,
} as const;

/** A CLI-side usage error (missing arg, bad flag, no credentials). Maps to exit 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * The single error -> exit-code mapper. Every command funnels its failures
 * through here. A check DENY is NOT routed here (it is a successful result the
 * check command resolves to EXIT.DENY itself).
 */
export function exitCodeForError(err: unknown): number {
  if (err instanceof UsageError) return EXIT.USAGE;
  if (err instanceof AgreelyConflictError) return EXIT.USAGE;
  if (err instanceof AgreelyAuthError) return EXIT.AUTH;
  if (err instanceof AgreelyBillingInactiveError) return EXIT.BILLING_INACTIVE;
  if (err instanceof AgreelyDailyCapError) return EXIT.DAILY_CAP;
  if (err instanceof AgreelyRateLimitError) return EXIT.RATE_LIMITED;
  if (err instanceof AgreelyTimeoutError) return EXIT.UNAVAILABLE;
  if (err instanceof AgreelyUnavailableError) return EXIT.UNAVAILABLE;
  if (err instanceof AgreelyValidationError) return EXIT.USAGE;
  if (err instanceof AgreelyConfigError) return EXIT.USAGE;
  if (err instanceof AgreelyNotFoundError) return EXIT.USAGE;
  return EXIT.ERROR;
}

/** A stable string code for the stderr error envelope, derived from the error. */
export function errorCodeFor(err: unknown): string {
  if (err instanceof UsageError) return "usage";
  // A 409 keeps its specific code (identity_held, already_released, retry, ...).
  if (err instanceof AgreelyConflictError) return err.code || "conflict";
  if (
    err instanceof AgreelyAuthError ||
    err instanceof AgreelyValidationError ||
    err instanceof AgreelyNotFoundError ||
    err instanceof AgreelyBillingInactiveError ||
    err instanceof AgreelyRateLimitError ||
    err instanceof AgreelyTimeoutError ||
    err instanceof AgreelyUnavailableError ||
    err instanceof AgreelyConfigError
  ) {
    return err.code;
  }
  return "error";
}

export function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The stable machine reason and offending field of an SDK error, when the server sent them. */
export function detailFor(err: unknown): { reason?: string; field?: string } {
  if (!(err instanceof AgreelyError)) return {};
  const e = err as { reason?: unknown; field?: unknown };
  return {
    ...(typeof e.reason === "string" && e.reason !== "" ? { reason: e.reason } : {}),
    ...(typeof e.field === "string" && e.field !== "" ? { field: e.field } : {}),
  };
}
