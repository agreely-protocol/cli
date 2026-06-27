// Shared unit-test helpers: an in-memory Io (captured stdout/stderr, pinned TTY,
// controlled env) and an in-memory CredentialStore. No process, no network.

import type { CredentialSource, CredentialStore } from "../../src/config.js";
import type { Io } from "../../src/io.js";

export interface FakeIo {
  io: Io;
  out(): string;
  err(): string;
}

export function makeIo(opts: { isTTY?: boolean; env?: Record<string, string> } = {}): FakeIo {
  let out = "";
  let err = "";
  const io: Io = {
    stdout: { write: (c) => { out += c; } },
    stderr: { write: (c) => { err += c; } },
    env: { ...(opts.env ?? {}) } as NodeJS.ProcessEnv,
    isTTY: opts.isTTY ?? false,
  };
  return { io, out: () => out, err: () => err };
}

export function makeStore(
  init: { apiKey?: { value: string; source: CredentialSource }; baseUrl?: string } = {},
): CredentialStore {
  let apiKey = init.apiKey;
  let baseUrl = init.baseUrl;
  return {
    async getApiKey() {
      return apiKey;
    },
    async getBaseUrl() {
      return baseUrl;
    },
    async setApiKey(value) {
      apiKey = { value, source: "keychain" };
      return { backend: "keychain" };
    },
    async setBaseUrl(value) {
      baseUrl = value;
    },
  };
}

/** Build an argv shaped like process.argv for run(). */
export function argv(...args: string[]): string[] {
  return ["node", "agreely", ...args];
}
