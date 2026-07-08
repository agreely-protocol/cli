# Publishing `@agreely/cli` (npm)

First public release: `0.1.0`. The CLI is a thin shell over `@agreely/sdk` and
inherits its network defaults (Base mainnet, chainId 8453). The CLI itself
hardcodes no contract address.

## Blockers before publish (must be resolved, in order)

1. **Publish `@agreely/sdk` first.** Its mainnet registry address is already
   deployed, verified, and filled (Base mainnet chainId 8453,
   `0x1E3121CFB5dfE1ac0b0265790D2bdA709725cF8B` - see that package's
   `PUBLISHING.md`). The CLI's default on-chain behavior comes from the
   installed SDK.

2. **Swap the local path dependency for the published version.** Right now, for
   local build/test, `package.json` uses:

   ```json
   "@agreely/sdk": "file:../agreely-sdk/ts"
   ```

   A `file:` dependency is NOT publishable. After `@agreely/sdk@0.1.0` is on
   npm, change this to:

   ```json
   "@agreely/sdk": "^0.1.0"
   ```

   then `npm install` and rebuild before publishing.

## Publish steps

```sh
npm ci
npm run build          # regenerates dist/bin.js (ESM, shebang, chmod +x)
npm test               # unit suite must be green
npm publish --access public
```

Notes:
- The `@agreely` npm org must exist and be owned by the publisher. `@agreely`
  is a **scoped** package; `publishConfig.access` is set to `public`, and
  `--access public` is passed explicitly.
- `files` ships `dist`, `README.md`, and `LICENSE` only. The `bin` entry
  (`agreely` -> `dist/bin.js`) is a built artifact.
- Keep the version at `0.1.0`. Do not create a git tag here; the human tags at
  publish time.
