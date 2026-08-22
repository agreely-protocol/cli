# Changelog

All notable changes to `@agreely/cli` are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## Unreleased (recommend 0.2.1)

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

- Documented the batch cap (500 cells, refused client-side before the request, exit
  2) and the rate limit (120 requests per minute per COMPANY, not per key), and the
  full deny vocabulary including `sensitive_requires_consent`.

### Note

- `basis` is read structurally, so this works against the pinned `@agreely/sdk`
  0.2.0 as well as later versions. When the SDK republishes with `basis` typed,
  bump the dependency and this can be simplified (that release should be 0.3.0).

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
