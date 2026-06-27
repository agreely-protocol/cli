# @agreely/cli

The Agreely consent gate as a command line tool. One binary, two modes:

- **Humans** get colored output and an interactive wizard (a TTY).
- **Agents** get pure JSON on stdout and stable exit codes (a pipe or `--json`).

It is a thin shell over [`@agreely/sdk`](../sdk): the CLI never reimplements the
HTTP, decision, or normalization logic — it resolves auth, picks a mode, calls
the SDK, and maps the result to an exit code.

## Install / build

```sh
make cli-build          # from the repo root: installs deps + builds dist/bin.js
# or, in cli/:
npm install && npm run build
node dist/bin.js --help
```

The build emits a single runnable `dist/bin.js` (ESM, shebang). The `agreely`
bin is declared in `package.json`.

## Modes (auto-detected)

| condition | mode | behavior |
| --- | --- | --- |
| stdout is a TTY and no `--json` | human | colors, the wizard, confirmations |
| stdout is **not** a TTY, **or** `--json` | agent | no prompts ever, pure JSON to stdout, logs/errors to stderr |

A missing required argument in agent mode is a clear error + a usage exit — it
**never** hangs waiting on a prompt.

## Agents: one env var + `--json`

```sh
export AGREELY_API_KEY=agr_live_xxx          # the only setup an agent needs
agreely check cust-42 "Email Address" "Marketing Outreach" --json
# -> {"decision":"allow","status":"active","consentRef":"0x…"}   exit 0
```

- Set the key **once** via `AGREELY_API_KEY` (no prompt, no keychain).
- Pass `--json` (or just pipe) for machine output.
- Branch on the **exit code** — it is the contract.
- `category` / `purpose` are sent **raw**; the server normalizes them.

## Exit codes (the agent contract)

| code | meaning |
| --- | --- |
| `0` | success / check **ALLOW** |
| `2` | usage or validation error (bad/missing args, invalid input, no credentials) |
| `3` | auth — the key is missing, invalid, revoked, or lacks the scope |
| `4` | **unavailable** — an Agreely outage (distinct from a deny) |
| `5` | rate-limited — the per-company window was exceeded |
| `10` | check **DENY** — a clean, expected negative, **not** an error |
| `1` | an unexpected/uncategorized failure |

`check` resolves ALLOW→`0` and DENY→`10`. The CLI is **fail-closed**: on an
outage the SDK throws and the CLI exits `4`, so a caller can tell "outage" from
"denied". A DENY's JSON still goes to stdout; a real error keeps stdout clean and
writes a `{"error":{"code","message"}}` envelope to stderr.

## Commands

```sh
agreely check <customerId> <category> <purpose> [--json]
agreely catalog [--json]
agreely requests [--status pending|approved|refused|expired|revoked_before_action] [--cursor <id>] [--json]
agreely request create [--customer <id> --to <email> --item <catalogId|category:purpose> ... --valid-until <YYYY-MM-DD>] [--idempotency-key <k>] [--json]
agreely request show <requestId> [--json]      # requestId is 0x + 64 hex
agreely whoami [--json]
agreely login                                  # interactive: store a key in the OS keychain
agreely config set --api-key <k> [--base-url <url>]   # non-interactive store (for scripts)
```

### `check`

```sh
agreely check cust-42 "Email Address" "Marketing Outreach" --json
# {"decision":"allow","status":"active","consentRef":"0x…"}      exit 0
# {"decision":"deny","status":"revoked","consentRef":"0x…"}      exit 10
```

### `request create`

Scriptable (agent) — every required flag present, no prompts:

```sh
agreely request create \
  --customer cust-42 --to ops@acme.example \
  --item "Email Address:Marketing Outreach" --item 4b082452-… \
  --valid-until 2030-01-01 --idempotency-key issue-2026-001 --json
# -> the IssuedRequest: {"requestId":"0x…","status":"pending","deepLink":"…",…}
```

An `--item` is either a catalog entry id, or `category:purpose` (split on the
first colon, passed raw). Reuse `--idempotency-key` to make a retry safe — a
replay returns the original request, with no double-issue and no double-email.

Interactive (human) — run it with no flags at a TTY and a wizard picks cells
from `catalog`, then collects the customer, recipient email, and valid-until,
validates each, and confirms before issuing.

## Auth precedence

```
--api-key flag  (discouraged — visible in `ps`)
  > AGREELY_API_KEY env      (the agent path: one var, no prompt, no keychain)
    > OS keychain (keytar)
      > ~/.config/agreely/config.json   (0600)
```

Base URL: `--base-url` > `AGREELY_BASE_URL` > the stored config > the SDK default
(`https://api.agreely.org`). `keytar` is an optional native module; if it is
absent or unavailable, `login` / `config set` fall back to the `0600` config file.

## Degrade / outage

The CLI is **fail-closed** by default. On an outage the SDK throws
`AgreelyUnavailableError`, which the CLI maps to exit `4` — distinct from a deny
(`10`) — so a caller never mistakes an outage for a refusal.

The fail-open / two-gate / break-glass degrade policy is intentionally **omitted**
from the CLI v1. That policy is a long-lived application/SDK-integration concern
(it carries an `onDegrade` audit sink and a bounded outage window), not something
a one-shot CLI invocation can persist or audit sensibly. Configure it where the
SDK is embedded.

## Tests

```sh
make cli-test       # fast offline unit suite (mock SDK + mock prompts)
make cli-check      # build + lint + unit + the live contract suite
make cli-contract   # seed a fixture from the live :8081 API, then the E2E suite
```

The unit suite covers the exit-code map for every outcome, pure-JSON stdout,
agent-mode-never-prompts, the auth precedence, and the raw flag→SDK input
mapping. The contract suite drives the built bin as a real process against the
live API (allow→0, revoke→deny→10, bad key→3, issuance + idempotency replay).
