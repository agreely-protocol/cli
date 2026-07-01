// agreely whoami — a SERVER-VERIFIED auth check. Calls GET /v1/whoami (any scope)
// so it reports the REAL scopes the key carries, not a locally inferred guess.
// Success -> the masked key, its source, the base URL, and the server scopes.
// A bad/missing key surfaces AgreelyAuthError -> exit 3. Secrets never printed.

import { buildClient, maskApiKey } from "../auth.js";
import type { Context } from "../context.js";
import { emitJson, emitLine, pc } from "../output.js";

export async function whoamiCommand(ctx: Context): Promise<void> {
  const { client, auth } = await buildClient(ctx);
  // Server-verified: GET /v1/whoami. Throws AgreelyAuthError on a bad/missing key.
  const identity = await client.identity();

  const masked = maskApiKey(auth.apiKey);
  const baseUrl = auth.baseUrl ?? "https://api.agreely.ca";

  if (ctx.agent) {
    emitJson(ctx, {
      authenticated: true,
      apiKeyMasked: masked,
      apiKeySource: auth.apiKeySource,
      baseUrl,
      // The server's own answer — the key's real scopes (least disclosure).
      scopes: identity.scopes,
    });
    return;
  }

  emitLine(ctx, `${pc.green("✓")} Authenticated`);
  emitLine(ctx, `  key     ${masked} ${pc.dim(`(${auth.apiKeySource})`)}`);
  emitLine(ctx, `  api     ${baseUrl}`);
  emitLine(ctx, `  scopes  ${identity.scopes.join(", ")}`);
}
