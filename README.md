# @agreely/cli

The Agreely consent gate as a command line tool. One binary, two modes:

- **Humans** get colored output and an interactive wizard (a TTY).
- **Agents** get pure JSON on stdout and stable exit codes (a pipe or `--json`).

It is a thin shell over [`@agreely/sdk`](https://github.com/agreely-protocol): the CLI never reimplements the
HTTP, decision, or normalization logic - it resolves auth, picks a mode, calls
the SDK, and maps the result to an exit code. That means it inherits the SDK's
guarantees: no telemetry, no data collection, it only ever talks to the Agreely
API base URL you configure (see [Open and auditable](#open-and-auditable)).

## Install

Once published:

```sh
npm install -g @agreely/cli
agreely --help
```

### Build from source (for local development)

For now the CLI consumes the SDK via a local path (`file:../agreely-sdk/ts`).
Check out the `agreely-sdk` repo as a **sibling** of this one and build its TS
package first:

```sh
# siblings: ./agreely-cli and ./agreely-sdk
(cd ../agreely-sdk/ts && npm install && npm run build)

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

A missing required argument in agent mode is a clear error + a usage exit - it
**never** hangs waiting on a prompt.

## Agents: one env var + `--json`

```sh
export AGREELY_API_KEY=agr_live_xxx          # the only setup an agent needs
agreely check cust-42 "Email Address" "Marketing Outreach" --json
# -> {"decision":"allow","status":"active","consentRef":"0x…"}   exit 0
```

- Set the key **once** via `AGREELY_API_KEY` (no prompt, no keychain).
- Pass `--json` (or just pipe) for machine output.
- Branch on the **exit code** - it is the contract.
- `category` / `purpose` are sent **raw**; the server normalizes them.

## Exit codes (the agent contract)

| code | meaning |
| --- | --- |
| `0` | success / check **ALLOW** |
| `2` | usage or validation error (bad/missing args, invalid input, no credentials) |
| `3` | auth - the key is missing, invalid, revoked, or lacks the scope |
| `4` | **unavailable** - an Agreely outage (distinct from a deny) |
| `5` | rate-limited - the per-company window was exceeded |
| `7` | **billing inactive** (HTTP 402) - the company's Agreely subscription lapsed. Fail-closed like a deny, but actionable and distinct from an outage |
| `10` | check **DENY** - a clean, expected negative, **not** an error |
| `1` | an unexpected/uncategorized failure |

`check` resolves ALLOW→`0` and DENY→`10`. The CLI is **fail-closed**: on an
outage the SDK throws and the CLI exits `4`, so a caller can tell "outage" from
"denied". A lapsed **company** subscription is a `402` that exits `7` (its
envelope code is `billing_inactive`) - also fail-closed, but distinct from an
outage and actionable: the company must pay to restore service. A DENY's JSON
still goes to stdout; a real error keeps stdout clean and writes a
`{"error":{"code","message"}}` envelope to stderr.

## Commands

```sh
agreely check <customerId> <category> <purpose> [--json]
agreely catalog [--json]
agreely requests list [--customer <ref>] [--status pending|approved|refused|expired|revoked_before_action] [--limit <n>] [--cursor <id>] [--json]  # metadata only; bare `agreely requests ...` is a kept alias
agreely request create [--customer <id> --to <email> (--document <versionId> | --document-code <code>) --valid-until <YYYY-MM-DD>] [--idempotency-key <k>] [--json]
agreely request show <requestId> [--json]      # requestId is 0x + 64 hex
agreely request cancel <requestId> [--json]    # cancel a pending request (idempotent)
agreely manual-consent create --customer <id> --document-version <id> --effective-date <YYYY-MM-DD> --valid-until <YYYY-MM-DD> --item <catalogId|category:purpose> ... --pdf <path> [--upload] [--json]
agreely manual-consent claim-link --customer <id> [--reference <ref>] [--json]
agreely manual-consent revoke <consentRef> [--reason <text>] [--json]
agreely relationship end <customerRef> --reason <text> [--json]      # end a customer relationship (art. 23; idempotent)
agreely relationship revert <customerRef> --reason <text> [--json]   # undo a mistaken end (art. 11 / art. 28 correction)
agreely whoami [--json]                         # server-verified: reports the key's real scopes
agreely login                                  # interactive: store a key in the OS keychain
agreely config set --api-key <k> [--base-url <url>]   # non-interactive store (for scripts)
```

### `check`

```sh
agreely check cust-42 "Email Address" "Marketing Outreach" --json
# {"decision":"allow","status":"active","consentRef":"0x…"}      exit 0
# {"decision":"deny","status":"revoked","consentRef":"0x…"}      exit 10
```

**Labels are bilingual and accent-tolerant.** The `category` and `purpose` may be
given in French OR English, with or without accents, and are matched case- and
whitespace-insensitively. English resolves only when the company disclosed an English
label for that cell. An ambiguous or undeclared label fails closed (deny / `none`), so
pass the label as declared in the catalog when you can.

### `request create`

Scriptable (agent) - every required flag present, no prompts:

```sh
agreely request create \
  --customer cust-42 --to ops@acme.example \
  --document 4b082452-… \
  --valid-until 2030-01-01 --idempotency-key issue-2026-001 --json
# -> the IssuedRequest: {"requestId":"0x…","status":"pending","deepLink":"…","document":{…},…}
```

Every request is issued under a **published consent document** (the Law 25 s. 8
disclosure): pass `--document <versionId>` or `--document-code <code>` (one, not
both - find them under Consent documents in the company workspace). The
requested (category, purpose) items derive from the document server-side; there
is no `--item` flag on this command. Reuse `--idempotency-key` to make a retry
safe - a replay returns the original request, with no double-issue and no
double-email.

Interactive (human) - run it with no flags at a TTY and a wizard collects the
document reference, customer, recipient email, and valid-until, validates each,
and confirms before issuing.

### `manual-consent`

The offline (company-attested) path: record a consent you gathered out of band
(a signed PDF) under your company's attestation. The result carries
`assurance: "company_attested"` (the live citizen flow yields `citizen_signed`).

```sh
agreely manual-consent create \
  --customer cust-42 --document-version 4b08… \
  --effective-date 2026-06-01 --valid-until 2031-01-01 \
  --item "Email Address:Marketing Outreach" --item 4b082452-… \
  --pdf ./signed-consent.pdf --json
# -> {"consentId":"…","merkleRoot":"0x…","consentRefs":["0x…"],"assurance":"company_attested","anchored":false}
```

The PDF is hashed **locally** (`0x` + SHA-256); only that commitment is sent. The
file bytes leave the machine **only** when you pass `--upload`. Hand the subject a
self-claim link with `manual-consent claim-link --customer <id>`, and revoke an
attestation with `manual-consent revoke <consentRef> [--reason <text>]`.

### `relationship`

Attest that a customer relationship is over (Law 25 art. 23) from your own
tooling, and undo a mistaken end within the correction window (art. 11 / art. 28).
`--reason` is REQUIRED and enforced **before** any network call (a missing reason
is exit `2`, never a silent write). Scope: `relationship`.

```sh
agreely relationship end cust-42 --reason "account closed; purposes accomplished" --json
# -> {"customerRef":"cust-42","status":"ended","endedAt":"…","endedBy":"company"}   exit 0

agreely relationship revert cust-42 --reason "offboarded the wrong account" --json
# -> {"customerRef":"cust-42","status":"active","reverted":true}                     exit 0
```

Ending is a pure lifecycle overlay: it never revokes, erases, or hides any
per-cell consent. A non-undo-eligible revert is a clean 404 (exit `2`).

## Auth precedence

```
--api-key flag  (discouraged - visible in `ps`)
  > AGREELY_API_KEY env      (the agent path: one var, no prompt, no keychain)
    > OS keychain (keytar)
      > ~/.config/agreely/config.json   (0600)
```

Base URL: `--base-url` > `AGREELY_BASE_URL` > the stored config > the SDK default
(`https://api.agreely.ca`). `keytar` is an optional native module; if it is
absent or unavailable, `login` / `config set` fall back to the `0600` config file.

## Degrade / outage

The CLI is **fail-closed** by default. On an outage the SDK throws
`AgreelyUnavailableError`, which the CLI maps to exit `4` - distinct from a deny
(`10`) - so a caller never mistakes an outage for a refusal.

The fail-open / two-gate / break-glass degrade policy is intentionally **omitted**
from the CLI v1. That policy is a long-lived application/SDK-integration concern
(it carries an `onDegrade` audit sink and a bounded outage window), not something
a one-shot CLI invocation can persist or audit sensibly. Configure it where the
SDK is embedded.

## Open and auditable

MIT-licensed and built to be provable, not just trusted:

- **No telemetry, no analytics, no phone-home.** The CLI ships no trackers and
  collects nothing. It makes **no** network calls of its own - every request goes
  through `@agreely/sdk`, to the Agreely API base URL you configure (default
  `https://api.agreely.ca`).
- **Credentials stay local.** An API key comes from a flag, `AGREELY_API_KEY`,
  the OS keychain (optional `keytar`), or a `0600` config file, and is sent only
  as the `Authorization: Bearer` header to your configured API. It is never
  logged (it is masked for display) and never sent anywhere else.
- **Minimal deps, no install scripts.** `@agreely/sdk`, `commander`,
  `@clack/prompts`, `picocolors`, and an optional `keytar`.

Agreely records and structures consent; it does not certify that your
organization is compliant.

## Links

- Product and API: https://agreely.ca
- Organization: https://github.com/agreely-protocol

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
