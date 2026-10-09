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

The CLI depends on the published `@agreely/sdk` (`^0.5.0`):

```sh
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
| `1` | an unexpected/uncategorized failure |
| `2` | usage or validation error (bad/missing args, invalid input including a `413`, no credentials), a `404`, or a `409` state conflict (envelope code is the specific code, else `conflict`; `retry` means a concurrent retry could not be settled: retry with the same key) |
| `3` | auth - the key is missing, invalid, revoked, or lacks the scope |
| `4` | **unavailable** - an Agreely outage or a timeout (distinct from a deny). On a write that takes a key (see Writes) the envelope carries `idempotencyKey`: retry with that SAME key |
| `5` | rate-limited - the per-company per-minute window was exceeded (retry after the delay) |
| `6` | `verify`: a receipt was checked and did **not** verify (a verdict, not an error) |
| `7` | **billing inactive** (HTTP 402) - the company's Agreely subscription lapsed. Fail-closed like a deny, but actionable and distinct from an outage |
| `8` | **daily cap** (HTTP 429 `withdrawal_daily_cap`, `verbal_daily_cap`, `hold_budget_exhausted`, `hold_release_cap_reached`). Not a rate window: retrying today cannot succeed, so do not loop on it |
| `9` | the write **succeeded** but its output could not be saved (`consent-sheet create`: the sheet was minted, the file could not be written). The reference and claim were still printed. Do **not** retry |
| `10` | check **DENY** - a clean, expected negative, **not** an error |

`check` resolves ALLOW→`0` and DENY→`10`. The CLI is **fail-closed**: on an
outage the SDK throws and the CLI exits `4`, so a caller can tell "outage" from
"denied". A lapsed **company** subscription is a `402` that exits `7` (its
envelope code is `billing_inactive`) - also fail-closed, but distinct from an
outage and actionable: the company must pay to restore service. A DENY's JSON
still goes to stdout; a real error keeps stdout clean and writes a
`{"error":{"code","message","reason"?,"field"?}}` envelope to stderr. Branch on
`code` and `reason`, never on `message`. A `409` keeps its specific code
(`identity_held`, `already_released`, `already_minted`, ...) and falls back to
`conflict`.

## Commands

```sh
agreely check <customerId> <category> <purpose> [--json]
agreely catalog [--document <code>] [--json]   # --document: one published document's active cells and its documentVersionId
agreely requests list [--customer <ref>] [--status pending|approved|asks_declined|refused|expired|revoked_before_action] [--limit <n>] [--cursor <id>] [--json]  # metadata only; bare `agreely requests ...` is a kept alias
agreely request create [--customer <id> --to <email> (--document <versionId> | --document-code <code>) --valid-until <YYYY-MM-DD>] [--idempotency-key <k>] [--json]
agreely request show <requestId> [--json]      # requestId is 0x + 64 hex
agreely request cancel <requestId> [--json]    # cancel a pending request (idempotent)
agreely manual-consent create --customer <id> --document-version <id> --effective-date <YYYY-MM-DD> --valid-until <YYYY-MM-DD> [--item <catalogId|category:purpose> ...] --pdf <path> [--upload] [--idempotency-key <k>] [--json]
agreely manual-consent claim-link --customer <id> [--reference <ref>] [--json]
agreely manual-consent revoke <consentRef> [--reason <text>] [--json]
agreely manual-consent erase <consentRef> [--reason <text>] [--json]      # Law 25 art. 28.1
agreely request wait <requestId> [--interval <ms>] [--timeout <ms>] [--json]   # poll until no longer pending; exit 4 on timeout
agreely relationship end <customerRef> --reason <text> [--json]      # end a customer relationship (art. 23; idempotent)
agreely relationship revert <customerRef> --reason <text> [--json]   # undo a mistaken end (art. 11 / art. 28 correction)
agreely verbal-consent record|show|paper ...    # a consent given by telephone (see below)
agreely withdraw <customerRef> <consentRef> --channel <c> --operator <id> [--requested-at <t>] [--reason <text>] [--json]
agreely customer get|set <customerRef> ...      # the customer registry
agreely retention show|dispose <customerRef> ...
agreely holds place|release|list|sync ...
agreely consent-sheet create <customerRef> --document-version <id> --out <file.pdf> [--locale fr|en] [--json]
agreely documents list|show <code>|pdf <documentVersionId> --out <file.pdf> [--json]
agreely whoami [--json]                         # server-verified: reports the key's real scopes
agreely login                                  # interactive: store a key in the OS keychain
agreely config set --api-key <k> [--base-url <url>]   # non-interactive store (for scripts)
```

### `check`

```sh
agreely check cust-42 "Email Address" "Marketing Outreach" --json
# {"decision":"allow","status":"active","consentRef":"0x…","assurance":"citizen_signed","tier":"full"}   exit 0
# {"decision":"deny","status":"revoked","consentRef":"0x…","assurance":"company_attested","tier":"manual","validUntil":"…","revokedAt":"…"}  exit 10
# {"decision":"allow","status":"necessity","basis":"necessary_for_service"}    exit 0
```

**Labels are bilingual and accent-tolerant.** The `category` and `purpose` may be
given in French OR English, with or without accents, and are matched case- and
whitespace-insensitively. English resolves only when the company disclosed an English
label for that cell. An ambiguous or undeclared label fails closed (deny / `none`), so
pass the label as declared in the catalog when you can.

**An allow is not always a consent.** `status: "necessity"` means there is **no
consent record**: the allow rests on a non-consent lawful basis the company
*declared* on the catalog cell, and the `basis` field names it (`contract`,
`necessary_for_service`, `security_fraud`, `legal_obligation`,
`professional_contact`). Such a decision has no `consentRef` and no `assurance`,
so if you are piping this into a report, **read `basis`**: without it a necessity
allow is indistinguishable from a consented one. Agreely records the declared
basis; it does not certify its legal validity.

**A cell declared sensitive answers by its basis like any other.** On `consent` it
denies `none` until a real consent is on record (and that consent must be express);
on a non-consent basis the company's act carries, it allows `necessity` with
`basis`. There is no longer a separate `sensitive_requires_consent` status: the
server stopped emitting it on 2026-09-28.

**Read the proof tier, not just the decision.** A record-backed decision carries
`assurance` and `tier`, the same proof under two names: `citizen_signed` / `full`
(the person signed with a passkey), `company_attested` / `manual` (a hand-signed
paper) and `company_documented` / `verbal` (a consent given by telephone and
documented by your organisation, with no document). A telephone consent allows
exactly like the others; **your system decides what each tier may unlock**, so
treat an `assurance` or `tier` you do not recognise as not acceptable.

**An informed line is not a consent.** A line the document gives for information,
acknowledged on a paper sheet or a call, answers like no record at all
(`necessity` with its `basis`, or the usual deny), with no `consentRef` and no
`assurance`. Once withdrawn it denies `revoked` with a `consentRef` and still no
`assurance` or `tier`.

The other deny statuses you will see are `none`, `revoked`, `expired`, `erased`,
`relationship_ended` (art. 23: the company attested the purposes are accomplished;
the per-cell consent stays truthfully active), `requires_depersonalization` and
`basis_not_in_regime`. Treat any status you do not recognise as a deny and read
`decision`, which is only ever `allow` or `deny`.

### `check --batch`

```sh
agreely check --batch cells.json --json    # cells.json: [{customerRef, category, purpose}, …]
```

One request for the whole file, exit 0 when every cell allows and exit 10 when any
denies. The server caps a batch at **500 cells**: an over-cap file is refused
before the request is sent (exit 2, with the count in the message), so split large
files yourself. The API also allows **120 requests per minute per company** (per
company, not per key), and one `--batch` run is one request, which is the point of
batch mode.

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

`--valid-until` is a calendar date and means **through the end of that day in
your company's timezone**. It must be within 10 years (an Agreely product ceiling,
not a statutory one), and relative phrases such as "+1 year" are refused.

A request's status is `pending`, `approved`, `asks_declined`, `refused`, `expired`
or `revoked_before_action`. `asks_declined` means the person confirmed receiving
the information but declined **every** consent ask, so no consent was obtained; it
is never listed under `--status approved`, and `approved` means at least one ask was
accepted. `request wait` returns as soon as a request is no longer `pending`.

Interactive (human) - run it with no flags at a TTY and a wizard collects the
document reference, customer, recipient email, and valid-until, validates each,
and confirms before issuing.

### Writes: timeouts and retries

Write commands get a 15 second budget (the SDK default of 800 ms is sized for the
consent check) and reads get 5 seconds (except `check`, which keeps the SDK's 800 ms). These commands send an `Idempotency-Key`,
yours (`--idempotency-key`) or one the CLI generates: `request create` (which emails a
person), `manual-consent create`, `verbal-consent record` and `paper`, `withdraw`,
`holds place` and `holds release`. If one of them ends in a timeout or an outage (exit
`4`), or in a `409` with code `retry`, the error envelope carries `idempotencyKey`: retry with that **same** key and the server
replays the first answer instead of writing twice (one hold, not two). A new key is a
new write. `consent-sheet create` is the exception: its key is a latch, so a repeated
key is a `409 already_minted`. The other writes (`customer set`, `retention dispose`,
`relationship end|revert`, `manual-consent claim-link|revoke|erase`, `request cancel`)
send no key of their own and print none.

### Dates, instants and `category:purpose`

`--valid-until` is `YYYY-MM-DD`, or for verbal consents also an RFC 3339 instant with
an offset. Instants (`--obtained-at`, `--signed-at`, `--requested-at`) must carry an
offset or `Z`. `--item` and `--answer` write `category:purpose`, split on the **first**
colon with both sides trimmed, so a category that itself contains a colon cannot be
expressed that way: use the catalog id with `--item`. `--out` must be a regular file
path: the PDF is never written to stdout (`/dev/stdout` is refused).

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
# -> {"consentId":"…","merkleRoot":"0x…","consentRefs":["0x…"],"assurance":"company_attested","anchored":false,"acknowledged":[…],"asksDeclined":false}
```

`--item` names the consent asks **ticked** on the sheet. Omit it entirely for a
sheet that answered "no" to every ask. The server adds every line the document
gives for information as an acknowledgement (never a consent) and ignores one you
name; the response lists those lines in `acknowledged` and sets `asksDeclined`
when no ask was consented. A document that asks no consent (a collection notice)
is refused (exit `2`).

`--valid-until` means through the end of that day in your company's timezone, at
most 10 years after `--effective-date`.

The PDF is hashed **locally** (`0x` + SHA-256); only that commitment is sent. The
file bytes leave the machine **only** when you pass `--upload`, and the server then
checks them against the hash. An empty file is refused, and so is an upload that is
not a PDF.

A `409` (exit `2`, envelope code `conflict`) means the request contradicts the
record: a purpose already held by an active passkey-signed consent, a verbal
consent for the same customer and document still awaiting its signed paper, or a
relationship that has ended.

Hand the subject a self-claim link with `manual-consent claim-link --customer <id>`
(an unknown customer is a `404`, an ended relationship a `409`, both exit `2`), and
withdraw a consent with `manual-consent revoke <consentRef> [--reason <text>]`. The
result's `gate` says what `check` answers now for that purpose: `denied` (this
consent backed it), `superseded` (a later consent had already taken over and is
untouched) or `unchanged` (an idempotent repeat).

`manual-consent create` also takes `--sensitive-express-attested` and
`--version-attested`, sent only when given.

### `verbal-consent`

A consent the person gave **by telephone**, documented by your organisation: the
weakest tier (`tier: "verbal"`, `assurance: "company_documented"`). Recording needs
the `attest_verbal` scope, the paper needs `attest`, `show` accepts either.

```sh
agreely verbal-consent record --customer cust-42 --document-version 4b08… \
  --answer "Email Address:Marketing Outreach=yes" --answer "Phone:Surveys=no" \
  --obtained-at 2026-10-09T10:15:00-04:00 --obtained-by agent-7 --script-version v3 \
  --consented-by self --valid-until 2027-10-09 --paper-expected --json
# -> {"consentId":"…","tier":"verbal","assurance":"company_documented","consentRefs":["0x…"],"acknowledged":[…],"asksDeclined":false,…}

agreely verbal-consent show <consentId> --json     # what was said, what the paper said, what is in force
agreely verbal-consent paper <consentId> --signed-at 2026-10-12T09:00:00-04:00 \
  --answer "Email Address:Marketing Outreach=yes" --pdf ./signed.pdf --json
```

Every `--answer` is the person's own explicit `yes` or `no`, as
`category:purpose=yes|no`. Withdraw a verbal consent with `manual-consent revoke`
or `withdraw`. `--obtained-at` is at most 7 days old and never in the future.
`--consented-by representative` takes `--capacity`, and a minor under 14 takes
`--minor` with `--respondent-name`. The paper's PDF is hashed locally exactly as for
`manual-consent create`.

### `withdraw`

Record a withdrawal the person asked for, on her behalf (scope `withdraw`, never on
a key by default). `--channel` is `phone`, `email`, `mail`, `in_person` or `other`;
`--operator` is your opaque id of the staff member, never an email.

```sh
agreely withdraw cust-42 0x… --channel phone --operator agent-7 --reason "asked by phone" --json
# -> {"consentRef":"0x…","withdrawn":true,"alreadyWithdrawn":false,"recordedOnBehalf":true,"assurance":"company_attested","gate":"denied","alsoWithdrawn":[]}
```

Read `gate` before telling anyone the use stopped. The daily cap (50 per 24 hours by
default; an operator can raise it) exits `8`: record further withdrawals from the customer page in Agreely.

### `customer`

```sh
agreely customer get cust-42 --json     # metadata only: booleans, never the name or email
agreely customer set cust-42 --display-name "Ada Lovelace" --email ada@example.com --notice-locale fr
agreely customer set cust-42 --email ""  # a merge: an absent flag is untouched, an empty value clears it
```

`409 identity_held` or `identity_erased` means the identity cannot be changed now.

### `retention` and `holds`

```sh
agreely retention show cust-42 --json
agreely retention dispose cust-42 --disposition legal_hold --reason "Act X s. 12" --retention-until 2031-01-01
agreely holds place cust-42 --ground other_law --provision "Act X s. 12" --rule <ruleKey> --cell <catalogId>
agreely holds place cust-42 --ground rights_request          # no --rule/--cell: covers everything
agreely holds release cust-42 <holdId> --reason "request closed"
agreely holds list [--changed-since <cursor>] [--page-token <t>]   # ONE page
agreely holds sync [--changed-since <cursor>] [--max-pages <n>]    # EVERY page (default bound 1000)
```

`dispose` needs the relationship to have ended (`409 relationship_active`); the
result says what happened to Agreely's copy of the identity (`agreelyIdentity`) and
warns with `hold_active` when a hold stands. An `other_law` hold requires
`--provision`; a `rights_request` hold refuses one. `holds list` and `holds sync`
need the `holds` scope. The feed pages with `pageToken`/`nextPageToken`, and only the
last page carries `cursor`. `holds sync` walks every page and prints
`cursor to keep` (in `--json`: `{"mode","holds","cursor"}`): persist it and pass it
as the next `--changed-since`. Without `--changed-since` the result is a snapshot of
every active hold (replace your whole set); with it, a delta (upsert by `id`).
Delivery is at least once.

### `consent-sheet`

```sh
agreely consent-sheet create cust-42 --document-version 4b08… --out ./sheet-cust-42.pdf
```

Mints the signature sheet of one published version for one customer (scope `attest`)
with a **new** claim. The PDF is written to `--out` (never stdout; an existing file is
refused before minting unless `--force`). The printed reference and the claim link
are returned **once** and stored nowhere, so the command prints them and nothing
can recover them later. A replayed `--idempotency-key` is a `409 already_minted`.

- Never send the claim link in the same envelope as the sheet: the printed
  reference is its second factor.
- Never send the blank sheet's hash as `evidence.pdfSha256`: the evidence is the
  signed paper once it comes back.

### `documents`

```sh
agreely documents list --json
agreely documents show <code> --json                 # the full published disclosure
agreely documents pdf <documentVersionId> --out ./info.pdf --locale en
```

Read-only discovery of the published consent documents. Pin the stable `code`, not
the version id, which changes on every publication. `pdf` writes the information
document to a file; fetching it records nothing and is not evidence that anyone was
informed.

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
npm test            # the offline unit suite (mock SDK + mock prompts)
npm run typecheck && npm run lint && npm run build
npm run test:contract   # drives the built bin against a live API (needs a fixture)
```

The unit suite covers the exit-code map for every outcome, pure-JSON stdout,
agent-mode-never-prompts, the auth precedence, and the raw flag→SDK input
mapping.
