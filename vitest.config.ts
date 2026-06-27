import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The contract suite drives the built bin against the live local API on
    // :8081; it runs only when a fixture is present (the seed writes it) and
    // skips cleanly otherwise.
    testTimeout: 20000,
  },
});
