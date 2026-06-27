// The IO seam. Every command writes through an injected Io rather than touching
// process.* directly, so tests can capture stdout/stderr, pin the TTY state, and
// control the environment without spawning a process.

export interface Writable {
  write(chunk: string): void;
}

export interface Io {
  stdout: Writable;
  stderr: Writable;
  env: NodeJS.ProcessEnv;
  /** Whether stdout is a TTY. Drives human-vs-agent mode. */
  isTTY: boolean;
}

/** The real process-backed Io. */
export function defaultIo(): Io {
  return {
    stdout: { write: (c) => process.stdout.write(c) },
    stderr: { write: (c) => process.stderr.write(c) },
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY),
  };
}
