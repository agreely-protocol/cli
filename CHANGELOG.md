# Changelog

All notable changes to `@agreely/cli` are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

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
