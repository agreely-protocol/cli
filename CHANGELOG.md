# Changelog

All notable changes to `@agreely/cli` are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## 0.4.0 - 2026-10-09

Covers the /v1 API through `@agreely/sdk` `^0.5.0` (a new minimum: `^0.3.0` does not
have these resources). Everything from the former Unreleased section ships here.

### Added

- **`verbal-consent record | show | paper`**: a consent given by telephone and the
  signed paper that raises it to a manual consent.
- **`withdraw <customerRef> <consentRef>`**: a withdrawal recorded on the person's
  behalf (`--channel`, `--operator`, optional `--requested-at`, `--reason`).
- **`customer get | set`**: the customer registry (a merge; an empty value clears).
- **`retention show | dispose`**: a customer's retention clock and the disposition
  declaration, with `agreelyIdentity` and the `hold_active` warning.
- **`holds place | release | list | sync`**: retention holds and the holds feed.
  `sync` walks every page and prints the cursor to keep.
- **`consent-sheet create`**: the signature sheet to a file, the printed reference and
  the claim link printed once, with the two rules (never the claim link in the same
  envelope as the sheet; never the blank sheet's hash as evidence).
- **`documents list | show | pdf`** and **`catalog --document <code>`**.
- `check` shows `validUntil` and `revokedAt` when present (human and `--json`).
- `manual-consent create --sensitive-express-attested --version-attested`.
- Every error envelope carries `reason` and `field` when the server sent them, and
  the human output prints `code`, `reason` and `field`.
- **Exit code `8`** for a per-company daily cap (429 `withdrawal_daily_cap`,
  `verbal_daily_cap`, `hold_budget_exhausted`, `hold_release_cap_reached`). It used
  to fall in `5` with the per-minute window; a daily cap cannot succeed on retry.

### Changed

- A `409` now reports its specific envelope code (`identity_held`,
  `already_released`, `already_minted`, ...) and `conflict` only as a fallback. The
  exit code is unchanged (`2`).
- Requires `@agreely/sdk` `^0.5.0`.
- `requests list --status` accepts `asks_declined`. `approved` no longer includes
  a request whose every ask was declined.
- README: removed `sensitive_requires_consent` (no longer emitted since
  2026-09-28: a sensitive cell answers by its declared basis), documented `tier`,
  `assurance`, informed lines, the full deny status list, the meaning of
  `--valid-until`, the manual-consent and claim-link `404`/`409` cases, and every
  new command.

### Fixed

- **`request wait` timed out on a request whose every consent ask was declined.**
  SDK 0.3.0's `waitForSettlement` does not know the `asks_declined` status, so such a
  request polled until the budget ran out and exited `4`. The CLI now polls
  `consentRequests.get` itself and settles on any status other than `pending`.
- **A `409` exited `4` as if Agreely were down.** SDK 0.3.0 surfaces a 409 as a
  non-retryable `AgreelyUnavailableError`. A 409 is a state conflict (a purpose
  held by a stronger active consent, a verbal consent still awaiting its paper, an
  ended relationship), so it now exits `2` with envelope code `conflict`.
- **`check` dropped `assurance`, and never showed the new `tier`.** Both are now
  passed through in `--json` (single and batch) and shown in human mode, including
  `company_documented` / `verbal` for a consent given by telephone.
- **`manual-consent create` required at least one `--item`.** A sheet that answered
  "no" to every ask is valid: `--item` may now be omitted. The human output lists
  the `acknowledged` informed lines and says when `asksDeclined`. An empty file is
  refused locally, and so is an `--upload` that is not a PDF, because the server
  refuses both.
- `manual-consent revoke` shows the new `gate` (`denied`, `superseded` or
  `unchanged`) in human mode; `--json` already passed it through.

## 0.3.1 - 2026-08-22

### Fixed

- **`agreely --version` printed `0.2.0` on 0.3.0.** The version is a hand-kept
  constant in `src/cli.ts`, deliberately separate from `package.json` so that a
  bundled bin never does a runtime filesystem read to answer `--version`, and
  0.3.0 shipped with that constant un-bumped. ONLY the self-reported string was
  wrong. 0.3.0 already depends on `@agreely/sdk` `^0.3.0`, so it carried the
  corrected verifier (the live Base mainnet registry and the fixed DID
  resolution hosts) exactly as intended: no consent decision, receipt
  verification or exit code behaved differently.
- A unit test now asserts that constant equals the `package.json` version. The
  two can no longer drift apart without failing `npm test`, which the publish
  steps already require.

## 0.3.0 - 2026-08-22

### Fixed

- **`check` was dropping `basis` from its output.** A decision can come back as
  `status: "necessity"`, meaning there is NO consent record and the allow rests on
  a non-consent lawful basis the company DECLARED on the catalog cell. Such a
  decision carries no `consentRef` and no `assurance`, so without `basis` the
  `--json` output was `{"decision":"allow","status":"necessity"}`: indistinguishable
  from a consented allow to anything reading it. `basis` is now emitted in `--json`
  (single and `--batch`) and shown in human mode as
  `(necessity) declared basis necessary_for_service, no consent record`.

### Changed

- **Requires `@agreely/sdk` `^0.3.0`: the SDK floor moved a full minor.** This is
  why the CLI goes to 0.3.0 and not the 0.2.1 the fix above would suggest on its
  own. `@agreely/sdk` 0.2.0 pinned a DEAD Base mainnet registry address, and
  `agreely verify --onchain` passes only an RPC URL: it never sets
  `registryAddress`, so it inherited that constant wholesale and reported
  `documentAnchor: "fail"` on valid mainnet evidence, which reads as tampering.
  Anyone installing the CLI must get the fixed verifier. The same SDK release
  moves the default DID resolution hosts (`app.agreely.ca` for company DIDs,
  `my.agreely.ca` for citizen DIDs), which `agreely verify` also inherits, so
  citizen receipts stop reporting `unavailable` out of the box.
- Documented the batch cap (500 cells, refused client-side before the request, exit
  2) and the rate limit (120 requests per minute per COMPANY, not per key), and the
  full deny vocabulary including `sensitive_requires_consent`.

### Note

- `basis` is still read structurally rather than off the SDK type, so the command
  keeps working against an older installed `@agreely/sdk`. Now that the floor is
  0.3.0 the field is typed upstream and that read could be simplified, which is
  deliberately left for a later release to keep this one to the verifier fix.

## 0.2.0

### Added

- `agreely requests list [--customer <ref>] [--status <s>] [--limit <n>]
  [--cursor <id>] [--json]`: list consent requests with the new `--customer`
  (the company's own subject ref) and `--limit` (page size, server max 100)
  filters, on top of the existing `--status` and `--cursor`. Human mode prints a
  table with the customerId + documentCode columns; `--json` emits one raw page
  `{items, nextCursor}` for agents. Metadata only, tenant-scoped by the API key.
- The bare `agreely requests ...` is kept as an alias of `requests list` (no
  breaking change to existing scripts).

### Changed

- Requires `@agreely/sdk` `^0.2.0` (for the `customerId`/`limit` list filters and
  the `customerId`/`documentCode` record fields).

## 0.1.2

- Surface HTTP 402 (billing inactive) as exit code 7.
