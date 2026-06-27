// The per-invocation context every command receives: the IO seam, the resolved
// mode (human vs agent), the global auth flags, the credential store, and a
// mutable exit code (so a check DENY can resolve to 10 on an otherwise clean run).

import { fileBackedStore, type CredentialStore } from "./config.js";
import { EXIT } from "./errors.js";
import type { Io } from "./io.js";

export interface GlobalFlags {
  json?: boolean;
  apiKey?: string;
  baseUrl?: string;
}

export interface Context {
  io: Io;
  /** Agent mode: --json was passed OR stdout is not a TTY. No prompts, JSON out. */
  agent: boolean;
  globals: GlobalFlags;
  store: CredentialStore;
  /** The exit code to return on a clean run. Commands may bump it (e.g. DENY). */
  exit: number;
}

export function createContext(io: Io, globals: GlobalFlags, store?: CredentialStore): Context {
  return {
    io,
    agent: globals.json === true || io.isTTY === false,
    globals,
    store: store ?? fileBackedStore(io.env),
    exit: EXIT.OK,
  };
}
