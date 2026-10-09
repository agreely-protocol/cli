// Small flag helpers shared by the commands: a required non-blank value, a
// repeatable-flag collector, and the file write used by the commands that save a PDF.

import { access, writeFile } from "node:fs/promises";
import { UsageError } from "./errors.js";

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

/**
 * Refuse BEFORE any network call when the output file already exists (unless --force),
 * because a sheet's printed reference and claim are returned once and a wasted call
 * cannot be replayed.
 */
export async function assertWritable(path: string, force: boolean): Promise<void> {
  if (force) return;
  try {
    await access(path);
  } catch {
    return;
  }
  throw new UsageError(`${path} already exists: pass --force to overwrite it.`);
}

export async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  try {
    await writeFile(path, bytes);
  } catch (err) {
    throw new UsageError(`Could not write ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
