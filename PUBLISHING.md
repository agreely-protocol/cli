# Publishing `@agreely/cli` (npm)

Two steps, in this order:

1. Publish the SDK first: `cd ~/www/agreely-sdk && npm publish --access public`
2. Then here: `npm install @agreely/sdk@^0.7.0 && npm test && npm publish --access public`, and commit the lockfile.
