// Output helpers. The hard rule: in agent mode, stdout carries PURE JSON and
// nothing else — every log, hint, and error goes to stderr. picocolors disables
// itself on a non-TTY, so human formatting degrades cleanly when redirected.

import pc from "picocolors";
import type { Context } from "./context.js";
import { detailFor, errorCodeFor, EXIT, exitCodeForError, messageFor } from "./errors.js";

/** Emit a single JSON document to stdout (the agent payload). */
export function emitJson(ctx: Context, data: unknown): void {
  ctx.io.stdout.write(JSON.stringify(data) + "\n");
}

/** A human line to stdout (data the user asked to see). */
export function emitLine(ctx: Context, line: string): void {
  ctx.io.stdout.write(line + "\n");
}

/** A diagnostic/hint to stderr — never pollutes the JSON on stdout. */
export function note(ctx: Context, line: string): void {
  ctx.io.stderr.write(line + "\n");
}

/**
 * Report a failure. stdout stays clean either way. In agent mode the error is a
 * JSON envelope on stderr ({error:{code,message}}); in human mode a red line.
 */
export function reportError(ctx: Context, err: unknown): void {
  const code = errorCodeFor(err);
  const message = messageFor(err);
  const { reason, field } = detailFor(err);
  if (ctx.agent) {
    ctx.io.stderr.write(
      JSON.stringify({
        error: { code, message, ...(reason !== undefined ? { reason } : {}), ...(field !== undefined ? { field } : {}) },
      }) + "\n",
    );
  } else {
    ctx.io.stderr.write(`${pc.red("✗")} ${pc.red(message)}\n`);
    const parts = [`code ${code}`, ...(reason !== undefined ? [`reason ${reason}`] : []), ...(field !== undefined ? [`field ${field}`] : [])];
    ctx.io.stderr.write(pc.dim(`  ${parts.join(", ")}`) + "\n");
    if (exitCodeForError(err) === EXIT.DAILY_CAP) {
      ctx.io.stderr.write(pc.dim("  A daily cap: retrying today cannot succeed. Do not loop on it.") + "\n");
    }
  }
}

export { pc };
