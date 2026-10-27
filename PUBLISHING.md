# Publishing `@agreely/cli` (npm)

Publish the SDK first, then the CLI against it:

1. Publish the SDK first: `cd ~/www/agreely-sdk && npm publish --access public`
2. Then here: `npm install @agreely/sdk@^0.6.0 && npm test && npm publish --access public`, and commit the lockfile.
