// The runnable entry. tsup prepends the shebang. Thin on purpose: resolve the
// exit code from run(), then exit with it — the agent contract is the code.

import { run } from "./cli.js";

run(process.argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    // A defensive last resort; run() already maps known failures.
    process.stderr.write(String(err instanceof Error ? err.stack ?? err.message : err) + "\n");
    process.exitCode = 1;
  });
