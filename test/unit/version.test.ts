// The CLI reports its version from a hand-kept constant in src/cli.ts rather than
// from package.json, because a bundled bin must not do a runtime filesystem read
// to answer `--version`. That constant CAN drift from package.json, and it did:
// 0.3.0 published with `VERSION = "0.2.0"`, so `agreely --version` misreported
// itself, which is exactly the string someone quotes in a bug report.
//
// This test is the gate. `npm test` is already a required publish step, so the
// two cannot silently disagree again.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/cli.js";

const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("VERSION", () => {
  it("matches the version in package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });
});
