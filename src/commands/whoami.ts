// agreely whoami — a friendly auth check. There is no dedicated identity
// endpoint, so we verify the key by listing the catalog (allowed for either
// scope). Success -> the masked key, its source, the base URL, and the catalog
// size. A bad key surfaces AgreelyAuthError -> exit 3. Secrets never printed.

import { buildClient, maskApiKey } from "../auth.js";
import type { Context } from "../context.js";
import { emitJson, emitLine, pc } from "../output.js";

export async function whoamiCommand(ctx: Context): Promise<void> {
  const { client, auth } = await buildClient(ctx);
  // Verifies the key against the live API; throws AgreelyAuthError on a bad key.
  const catalog = await client.catalog.list();

  const masked = maskApiKey(auth.apiKey);
  const baseUrl = auth.baseUrl ?? "https://api.agreely.org";

  if (ctx.agent) {
    emitJson(ctx, {
      authenticated: true,
      apiKeyMasked: masked,
      apiKeySource: auth.apiKeySource,
      baseUrl,
      catalogEntries: catalog.length,
    });
    return;
  }

  emitLine(ctx, `${pc.green("✓")} Authenticated`);
  emitLine(ctx, `  key     ${masked} ${pc.dim(`(${auth.apiKeySource})`)}`);
  emitLine(ctx, `  api     ${baseUrl}`);
  emitLine(ctx, `  catalog ${catalog.length} ${pc.dim("declared cell(s)")}`);
}
