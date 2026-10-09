// The registry's accepted grounds are a hand-kept list (the SDK exports the union as a
// type only). This pins it against the installed SDK's declarations, so a ground added
// there fails here instead of being refused by the CLI.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEGAL_BASES } from "../../src/commands/customer.js";

function unionMembers(dts: string, name: string): string[] {
  const m = new RegExp(`type ${name} =([^;]+);`).exec(dts);
  if (!m?.[1]) throw new Error(`type ${name} not found in the SDK declarations`);
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1] as string);
}

describe("customer set --legal-basis", () => {
  it("lists every ground of the SDK's RegistryBasis (Basis plus depersonalized_research)", () => {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("@agreely/sdk");
    const dts = readFileSync(join(dirname(entry), "index.d.ts"), "utf8");
    const expected = [...new Set([...unionMembers(dts, "Basis"), "depersonalized_research"])].sort();
    expect([...LEGAL_BASES].sort()).toEqual(expected);
  });
});
