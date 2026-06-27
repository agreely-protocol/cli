import { defineConfig } from "tsup";

// Build a single runnable ESM bin with a shebang. Dependencies (@agreely/sdk,
// commander, @clack/prompts, picocolors) and the optional native keytar stay
// external — tsup marks package.json deps external automatically, so they
// resolve from node_modules at runtime (keytar is a native module and MUST NOT
// be bundled). The CLI is a thin shell; there is nothing heavy to inline.
export default defineConfig({
  entry: { bin: "src/bin.ts" },
  format: ["esm"],
  target: "node18",
  clean: true,
  sourcemap: true,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
  // keytar is an OPTIONAL native module — never bundle it; it resolves from
  // node_modules at runtime, and its absence is handled gracefully.
  external: ["keytar"],
});
