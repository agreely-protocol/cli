// Credential storage. The agent path never touches this (it uses AGREELY_API_KEY).
// For humans, `agreely login` / `config set` persist a key in the OS keychain via
// keytar, gracefully falling back to ~/.config/agreely/config.json at 0600 when
// keytar is unavailable (not installed, or a headless box with no keychain).

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CredentialSource = "keychain" | "config";

export interface StoredApiKey {
  value: string;
  source: CredentialSource;
}

export interface CredentialStore {
  /** Resolve a stored key, keychain first (higher precedence) then the config file. */
  getApiKey(): Promise<StoredApiKey | undefined>;
  getBaseUrl(): Promise<string | undefined>;
  /** Persist a key; returns which backend actually held it. */
  setApiKey(value: string): Promise<{ backend: CredentialSource }>;
  setBaseUrl(value: string): Promise<void>;
}

const KEYCHAIN_SERVICE = "agreely";
const KEYCHAIN_ACCOUNT = "api-key";

interface ConfigFile {
  apiKey?: string;
  baseUrl?: string;
}

function configPath(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ""
    ? env.XDG_CONFIG_HOME
    : join(homedir(), ".config");
  return join(base, "agreely", "config.json");
}

function readConfigFile(path: string): ConfigFile {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ConfigFile;
  } catch {
    return {};
  }
}

function writeConfigFile(path: string, patch: ConfigFile): void {
  const current = readConfigFile(path);
  const next = { ...current, ...patch };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  // writeFileSync only applies mode on create; force 0600 on an existing file.
  chmodSync(path, 0o600);
}

/** The slice of keytar's surface the store uses. */
interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
}

/** Lazily load the optional native keytar; absent/broken -> null (we fall back). */
async function loadKeytar(): Promise<KeytarLike | null> {
  try {
    const mod = (await import("keytar")) as unknown as { default?: KeytarLike } & KeytarLike;
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

/** The real keychain-then-file store. */
export function fileBackedStore(env: NodeJS.ProcessEnv): CredentialStore {
  const path = configPath(env);
  return {
    async getApiKey() {
      const keytar = await loadKeytar();
      if (keytar) {
        try {
          const fromKeychain = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
          if (fromKeychain) return { value: fromKeychain, source: "keychain" };
        } catch {
          // keychain unreadable -> fall through to the config file
        }
      }
      const cfg = readConfigFile(path);
      if (cfg.apiKey) return { value: cfg.apiKey, source: "config" };
      return undefined;
    },
    async getBaseUrl() {
      return readConfigFile(path).baseUrl;
    },
    async setApiKey(value) {
      const keytar = await loadKeytar();
      if (keytar) {
        try {
          await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, value);
          return { backend: "keychain" };
        } catch {
          // fall through to the file
        }
      }
      writeConfigFile(path, { apiKey: value });
      return { backend: "config" };
    },
    async setBaseUrl(value) {
      writeConfigFile(path, { baseUrl: value });
    },
  };
}
