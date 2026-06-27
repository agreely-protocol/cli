// agreely login   — human, interactive: prompt for a key (+ optional base URL),
//                    store it (keychain, else ~/.config/agreely/config.json 0600),
//                    then verify it against the live API.
// agreely config set [--api-key <k>] [--base-url <url>]  — the non-interactive
//                    store path (for setup scripts). Never prompts.
//
// In agent mode, `login` errors clearly (it is inherently interactive) rather
// than hanging on a prompt — use `config set` or AGREELY_API_KEY instead.

import * as prompts from "@clack/prompts";
import { Agreely } from "@agreely/sdk";
import { maskApiKey } from "../auth.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { emitJson, note, pc } from "../output.js";

export async function loginCommand(ctx: Context): Promise<void> {
  if (ctx.agent) {
    throw new UsageError(
      "`login` is interactive. In a script use `agreely config set --api-key ...` or set AGREELY_API_KEY.",
    );
  }

  prompts.intro(pc.bold("Agreely login"));

  const apiKey = await prompts.password({
    message: "API key (agr_live_…)",
    validate: (v) => (v && v.trim() !== "" ? undefined : "Required."),
  });
  if (prompts.isCancel(apiKey)) {
    prompts.cancel("Cancelled.");
    return;
  }

  const baseUrl = await prompts.text({
    message: "API base URL",
    placeholder: "https://api.agreely.org",
    defaultValue: "",
  });
  if (prompts.isCancel(baseUrl)) {
    prompts.cancel("Cancelled.");
    return;
  }

  const key = String(apiKey).trim();
  const base = String(baseUrl).trim();

  // Verify before persisting — never store a key that does not work.
  const spinner = prompts.spinner();
  spinner.start("Verifying…");
  try {
    const client = new Agreely({ apiKey: key, ...(base !== "" ? { baseUrl: base } : {}) });
    await client.catalog.list();
    spinner.stop("Key verified.");
  } catch (err) {
    spinner.stop("Verification failed.");
    throw err;
  }

  const { backend } = await ctx.store.setApiKey(key);
  if (base !== "") await ctx.store.setBaseUrl(base);

  prompts.outro(
    `${pc.green("✓")} Stored ${maskApiKey(key)} in the ${backend === "keychain" ? "OS keychain" : "config file (0600)"}.`,
  );
}

export interface ConfigSetFlags {
  apiKey?: string;
  baseUrl?: string;
}

export async function configSetCommand(ctx: Context, flags: ConfigSetFlags): Promise<void> {
  if (!flags.apiKey && !flags.baseUrl) {
    throw new UsageError("Nothing to set. Pass --api-key <k> and/or --base-url <url>.");
  }

  let backend: "keychain" | "config" | undefined;
  if (flags.apiKey) {
    backend = (await ctx.store.setApiKey(flags.apiKey.trim())).backend;
  }
  if (flags.baseUrl) {
    await ctx.store.setBaseUrl(flags.baseUrl.trim());
  }

  if (ctx.agent) {
    emitJson(ctx, {
      stored: true,
      ...(flags.apiKey ? { apiKeyMasked: maskApiKey(flags.apiKey.trim()), backend } : {}),
      ...(flags.baseUrl ? { baseUrl: flags.baseUrl.trim() } : {}),
    });
    return;
  }
  note(ctx, `${pc.green("✓")} Saved.`);
}
