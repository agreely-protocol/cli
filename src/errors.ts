// The agent contract lives here: ONE central map from every outcome to a stable
// exit code. Agents branch on these numbers, so they must never drift.

import {
  AgreelyAuthError,
  AgreelyConfigError,
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
  /** Bad CLI usage, missing/invalid args, or a server validation error. */
  USAGE: 2,
  /** The key was missing, invalid, revoked, or lacks the scope. */
  AUTH: 3,
  /** Agreely was unreachable (outage). DISTINCT from a deny. */
  UNAVAILABLE: 4,
  /** The per-company rate window was exceeded. */
  RATE_LIMITED: 5,
  /** A receipt was checked and did NOT verify (`agreely verify`). Not an error — a verdict. */
  VERIFY_FAILED: 6,
  /** A clean check DENY — an expected negative, NOT an error. */
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
  if (err instanceof AgreelyAuthError) return EXIT.AUTH;
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
  if (
    err instanceof AgreelyAuthError ||
    err instanceof AgreelyValidationError ||
    err instanceof AgreelyNotFoundError ||
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
