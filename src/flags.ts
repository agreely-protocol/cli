// Small helpers shared by the commands: required and optional flag values, closed
// lists, date and instant checks, the "category:purpose" splitter, the repeatable-flag
// collector, idempotency keys, and the output file opened BEFORE any irreversible call.

import { randomUUID } from "node:crypto";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { UsageError } from "./errors.js";

/** YYYY-MM-DD. Whether the date is real is the server's call. */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** An RFC 3339 instant WITH an offset (or Z), as the SDK requires. */
export const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

/** A required flag or argument: trimmed, and a UsageError (exit 2) when blank. */
export function need(value: string | undefined, name: string): string {
  const v = value?.trim();
  if (!v) throw new UsageError(`${name} is required.`);
  return v;
}

/** An optional flag: trimmed, undefined when absent or blank. */
export function opt(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

/** A value that must be one of a closed list. */
export function oneOf<T extends string>(value: string, allowed: readonly T[], name: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UsageError(`${name} "${value}" must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

export function assertDate(value: string, name: string): string {
  if (!DATE_RE.test(value)) throw new UsageError(`${name} "${value}" must be YYYY-MM-DD.`);
  return value;
}

/** An RFC 3339 instant with an offset, e.g. 2026-10-09T10:15:00-04:00 or ...Z. */
export function assertInstant(value: string, name: string): string {
  if (!INSTANT_RE.test(value)) {
    throw new UsageError(`${name} "${value}" must be an RFC 3339 instant with an offset (2026-10-09T10:15:00-04:00).`);
  }
  return value;
}

/** A plain date or an RFC 3339 instant with an offset. */
export function assertDateOrInstant(value: string, name: string): string {
  if (!DATE_RE.test(value) && !INSTANT_RE.test(value)) {
    throw new UsageError(`${name} "${value}" must be YYYY-MM-DD or an RFC 3339 instant with an offset.`);
  }
  return value;
}

/**
 * Split "category:purpose" on the FIRST colon, both sides trimmed and non-empty. A
 * category that itself contains ":" cannot be expressed this way: use the catalog id.
 * Returns undefined when there is no colon or a side is blank.
 */
export function splitPair(raw: string): { category: string; purpose: string } | undefined {
  const idx = raw.indexOf(":");
  if (idx === -1) return undefined;
  const category = raw.slice(0, idx).trim();
  const purpose = raw.slice(idx + 1).trim();
  return category === "" || purpose === "" ? undefined : { category, purpose };
}

/** commander collector for a repeatable flag. */
export function collect(val: string, prev: string[]): string[] {
  return [...prev, val];
}

/**
 * The Idempotency-Key to send: the user's, or a fresh one generated HERE so that it can
 * be printed when the call ends in a timeout or an outage, and the retry sent with the
 * SAME key (a replay, never a second write).
 */
export function keyOrNew(flag: string | undefined): string {
  return opt(flag) ?? randomUUID();
}

export interface OutputFile {
  handle: FileHandle;
  /** Whether this call created the file (so it can be removed if nothing was written). */
  created: boolean;
}

/**
 * Open the output file BEFORE the call that cannot be replayed, so a missing directory,
 * a directory path or a read-only location fails while nothing has been minted yet.
 * Without --force an existing file is refused (open "wx"). Only a regular file is
 * accepted: /dev/stdout and the like are refused.
 */
export async function openOutput(path: string, force: boolean): Promise<OutputFile> {
  let handle: FileHandle;
  try {
    handle = await open(path, force ? "w" : "wx");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new UsageError(`${path} already exists: pass --force to overwrite it.`);
    throw new UsageError(`Cannot write ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const stat = await handle.stat();
  if (!stat.isFile()) {
    await handle.close();
    throw new UsageError(`--out ${path} is not a regular file: the PDF is written to a file only.`);
  }
  return { handle, created: !force };
}

/** Write the bytes and close. Throws the raw error: the caller decides what the failure costs. */
export async function writeAndClose(out: OutputFile, bytes: Uint8Array): Promise<void> {
  try {
    await out.handle.writeFile(bytes);
  } finally {
    await out.handle.close();
  }
}

/** Close and, when this call created it, remove an output file the call never filled. */
export async function discardOutput(out: OutputFile, path: string): Promise<void> {
  await out.handle.close().catch(() => undefined);
  if (out.created) await unlink(path).catch(() => undefined);
}
