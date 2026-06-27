// Auth resolution with a fixed precedence:
//
//   --api-key flag  (discouraged; visible in `ps`)
//     > AGREELY_API_KEY env   (THE agent path: one var, no prompt, no keychain)
//       > OS keychain (keytar)
//         > ~/.config/agreely/config.json (0600)
//
// Base URL: --base-url > AGREELY_BASE_URL > config file > the SDK default.
//
// Resolution NEVER prompts. A missing key throws a UsageError (exit 2) — an agent
// in a non-TTY must get a clear error, never a hang.

import { Agreely } from "@agreely/sdk";
import type { Context } from "./context.js";
import type { CredentialSource } from "./config.js";
import { UsageError } from "./errors.js";

export type ApiKeySource = "flag" | "env" | CredentialSource;

export interface ResolvedAuth {
  apiKey: string;
  baseUrl: string | undefined;
  apiKeySource: ApiKeySource;
}

export async function resolveAuth(ctx: Context): Promise<ResolvedAuth> {
  const flagKey = ctx.globals.apiKey?.trim();
  const envKey = ctx.io.env.AGREELY_API_KEY?.trim();

  let apiKey: string | undefined;
  let apiKeySource: ApiKeySource | undefined;

  if (flagKey) {
    apiKey = flagKey;
    apiKeySource = "flag";
  } else if (envKey) {
    apiKey = envKey;
    apiKeySource = "env";
  } else {
    const stored = await ctx.store.getApiKey();
    if (stored) {
      apiKey = stored.value;
      apiKeySource = stored.source;
    }
  }

  if (!apiKey || apiKeySource === undefined) {
    throw new UsageError(
      "No API key. Set AGREELY_API_KEY, run `agreely login`, or pass --api-key.",
    );
  }

  const flagBase = ctx.globals.baseUrl?.trim();
  const envBase = ctx.io.env.AGREELY_BASE_URL?.trim();
  const baseUrl = flagBase || envBase || (await ctx.store.getBaseUrl()) || undefined;

  return { apiKey, baseUrl, apiKeySource };
}

/** Build a configured SDK client from the resolved auth. */
export async function buildClient(ctx: Context): Promise<{ client: Agreely; auth: ResolvedAuth }> {
  const auth = await resolveAuth(ctx);
  const client = new Agreely({
    apiKey: auth.apiKey,
    ...(auth.baseUrl !== undefined ? { baseUrl: auth.baseUrl } : {}),
  });
  return { client, auth };
}

/** Mask a key for display: keep the readable prefix and last 4, hide the secret middle. */
export function maskApiKey(key: string): string {
  if (key.length <= 12) return "****";
  const head = key.slice(0, 8);
  const tail = key.slice(-4);
  return `${head}…${tail}`;
}
