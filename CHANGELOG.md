# Changelog

All notable changes to `@agreely/cli` are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## 0.6.0 - 2026-10-29

Requires `@agreely/sdk` `^0.7.0`.

### Added

- `verify --onchain` reads the company key on chain at the instant it signed and, on a
  passkey bundle, the person's key. The matrix prints a `companyKey` line (`authentic`,
  `key-not-authorised`, `signed-after-anchor`, `pending`, `voided`, `recorded-late`,
  `retired-issuer-dated`, `unknown`, `unreachable`, `no-domain`, and whether the company
  has since rotated its key) and a `citizenKey` line (`inForce`, `pending`, `notRecorded`,
  `voided`, `notInForce`, `recordedLate`, `notLinked`, `unreadable`, `unreachable`, with
  the reason the SDK gives).
- `verify` prints a `signedAnchor` line for a version 4 paper or telephone receipt in its
  bundle (`bound`, `contradicts` or `malformed`). With `--onchain`, the chain is read on
  the refs the receipt signs.
- `verify --ipfs-gateway <url>` (repeatable): the IPFS gateways asked in order for the
  disclosure copy, each a prefix or a `{cid}` template. Under `--ipfs`, the matrix prints
  `disclosureGateway` with the gateway that delivered, or each gateway tried when none did.
- `verify --now <ISO-8601>` pins the verifier's clock. An instant that does not parse
  exits `2`.
- `verify --json` carries the SDK's `companyKeyRegistry`, `companyKey`, `citizenKeyChain`,
  `citizenKey`, `signedAnchor`, `disclosureGateway` and
  `consentAnchorCounts.anchorBatchRefs` unchanged.
- `check` reads the `guardian_consent_missing` and `purpose_ended` denies: the human line
  prints their `consentRef` and one line of why, in single and `--batch` mode. Both exit
  `10`, and `--json` carries `consentRef`, `assurance`, `tier` and `validUntil`.

### Changed

- With `--onchain`, `verify` reads `verified` or `withdrawn` only once the company key is
  read on chain in force at the instant it signed and, on a passkey bundle, the person's
  key reading does not withhold the verdict. Otherwise it reads `unavailable` and exits
  `4`, and the matrix says which key and that it is not a refusal. A refusal read on
  chain reads `failed` and exits `6`. Without `--onchain`, no result changes.
- With `--onchain`, a version 4 paper or telephone receipt in its bundle reads its
  withdrawal on chain, and exits `0` once the chain reads it in force.
- With `--onchain`, a person's key that could not be read on chain exits `4`.
- `verify --ipfs` counts a gateway's copy only once its bytes re-encode to the CID, and
  asks the next gateway otherwise.

## 0.5.1 - 2026-10-27

Requires `@agreely/sdk` `^0.6.1`.

### Changed

- `verify --onchain` exits `0` only when the chain also reads the consent in force
  (`withdrawal: "active"`). A withdrawal it could not read exits `4`, and the matrix says
  `WITHDRAWAL NOT CHECKED`.
- `verify` prints a `withdrawal` line (`active`, `withdrawn` or `not checked`), and its
  JSON carries the SDK's `withdrawal` and, when the chain records it, `withdrawnAt`.
- `verify` exits `6` on a passkey receipt carrying a field the issuer never writes
  (`malformed`), and `4` under `--onchain` on a bundle whose consentRefs leave an accepted
  purpose unnamed.
- The README's `--onchain` example uses `https://base-rpc.publicnode.com`.

## 0.5.0 - 2026-10-27

Requires `@agreely/sdk` `^0.6.0`.

### Added

- **`verify` takes the consent's verification bundle** (receipt, signed offer, Merkle
  root) or a recorded (paper, telephone) receipt, with the checks of `@agreely/sdk`
  0.6.0. A passkey consent exits `0` once the company signature over the offer holds,
  the receipt matches that offer, the passkey assertion is bound to its content, the
  citizen's DID document lists that key under `authentication` with a window that
  covers the acceptance date (`grantedAt`), and that date lies inside the offer's
  window (`createdAt` to `expiresAt`).
- **`verify --onchain`** also reads the consent anchor in the registry.
- `verify` exits `12` (`WITHDRAWN`) when the consent is authentic and the chain records its
  withdrawal, for all of its purposes or some (`overall: "withdrawn"`, read with `--onchain`).
  The matrix prints `~ WITHDRAWN` and the `consentAnchor` check `withdrawn`.
- `verify --onchain` says "retry later" (not "retry with connectivity") when the chain answered and
  the consent's cells are not anchored yet: it exits `4` either way.
- The README documents `verify`, and that a `--did-doc` document is trusted as given:
  take it from the issuer and the citizen tier, never out of the file under test.
- **`withdraw --other-consents withdraw|keep` and `--also-withdraw <ref,...>`** declare
  the scope toward the other consents of the purpose: all withdrawn, all kept, or the
  ones named (comma-separated consentRefs, at most 50, repeatable). The two together,
  an unknown scope, a ref that is not a consentRef and more than 50 refs exit `2`
  before any call.
- `withdraw` prints `stillInForce`, the consents of the purpose still in force after
  the act, beside `alsoWithdrawn`.
- A withdrawal refused `422 other_consents_running` exits `2`, and its error envelope
  carries `otherConsentRefs`, the consents in force to ask the person about.
- **`manual-consent revoke` and `erase` take `--other-consents keep|withdraw`**, and
  print `stillInForce` when another consent keeps the purpose in force.

### Changed

- Every file gets a verdict. A file the verifier cannot read (nesting past 64 levels, a
  bundle of another version, a receipt or offer that is not an object) is `malformed`:
  exit `6`, and the matrix says `MALFORMED`.
- `withdraw` documents `assurance` as `company_documented`, the value the API sends.

### Breaking

- **`verify` exits `0` only when a bundle or a paper receipt reads `verified`, or a
  telephone receipt reads `partial`** (the organisation's signed word, sound). A bare
  passkey receipt exits `11` (incomplete): pass the bundle instead. A file that is not
  JSON exits `2` (usage).
- **The citizen half is checked for a `did:agreely:citizen:` subject only; any other
  subject exits `4`.**
- **A passkey bundle without its `signedOffer` or `merkleRoot` exits `6`** (malformed),
  not `11`.
- **A passkey bundle whose citizen DID document does not confirm the key at
  `grantedAt`, or whose `grantedAt` lies outside the offer's window, exits `6`.** A
  `--did-doc` citizen document without `authentication` or `validFrom` exits `6`.
- **`verify --onchain` or `--ipfs` exits `4`** when the check asked for cannot complete,
  an RPC failure included, never `0` or `6`.
- **`customer set` no longer takes `--basis-note` or `--legal-basis`.** The customer
  registry holds no per-customer ground: the API ignores it and the SDK does not send
  it. A script that passes either flag fails with the usage exit code `2` (unknown
  option). `customer get` and `customer set` do not print the basis note or the legal
  basis.

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
  `verbal_daily_cap`, `hold_budget_exhausted`, `hold_release_cap_reached`), distinct
  from the per-minute window (`5`): a daily cap cannot succeed on retry.
- **Exit code `9`**: the write succeeded but its output could not be saved
  (`consent-sheet create`). The reference and claim are still printed; do not retry.
- `request create`, `manual-consent create`, `verbal-consent record|paper`, `withdraw`
  and `holds place|release` send an Idempotency-Key (yours, or one generated and printed
  in the error envelope on a timeout, an outage or a `409 retry`, so the retry replays
  instead of writing twice, or emailing a second time). Writes get a 15 second time
  budget and reads 5 seconds (except `check`, which keeps the SDK's 800 ms). `manual-consent create` gained `--idempotency-key`;
  `holds sync` gained `--max-pages`.

### Changed

- A `409` now reports its specific envelope code (`identity_held`,
  `already_released`, `already_minted`, ...) and `conflict` only as a fallback. The
  exit code is unchanged (`2`).
- Requires `@agreely/sdk` `^0.5.0`.
- **HTTP 413 now exits `2`** (validation) instead of `4`: SDK 0.3.0 reported it as
  Unavailable. It is reachable through `manual-consent create --upload` with a PDF
  over the size limit.
- `consent-sheet create` and `documents pdf` open `--out` before calling the API (a
  missing directory or a directory path fails before anything is minted); a regular
  file is required.
- `--item` and `--answer` trim both sides of `category:purpose`.
- Instants and dates are validated before any call.
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
  ended relationship), so it now exits `2` (its envelope code is the specific code, else `conflict`).
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
