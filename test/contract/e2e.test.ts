// Contract / E2E: drive the BUILT bin (dist/bin.js) as a real process against the
// live local API on :8081, asserting the agent contract end to end — the exit
// codes, the pure-JSON stdout, issuance + idempotency, and revoke -> instant deny.
//
// Gated on a seeded fixture (make cli-contract writes it) AND a built bin; without
// either it skips cleanly rather than failing (CI without the stack).

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const binPath = resolve(here, "../../dist/bin.js");
const fixturePath = resolve(here, "fixture.json");

interface Fixture {
  baseUrl: string;
  keys: { check: string; issue: string; both: string; otherTenantCheck: string };
  subject: string;
  absent: string;
  revocable: { category: string; purpose: string; consentRef: string };
  issue: { catalogId: string; category: string; purpose: string; documentId: string; documentCode: string; recipientEmail: string; validUntil: string };
}

const ready = existsSync(fixturePath) && existsSync(binPath);
const fixture: Fixture | null = ready ? (JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture) : null;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the built bin in a fresh process with an explicit env. Never inherits a key. */
function runBin(args: string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((res) => {
    execFile(
      process.execPath,
      [binPath, ...args],
      { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number"
          ? (err as { code: number }).code
          : err
            ? 1
            : 0;
        res({ code, stdout, stderr });
      },
    );
  });
}

function revokeOutOfBand(consentRef: string): void {
  // Reuse the SDK seed script's revoke subcommand, in-container (the M5 path).
  execFileSync(
    "docker",
    ["compose", "exec", "-T", "api", "php", "scripts/sdk-contract-seed.php", "revoke", consentRef],
    { cwd: repoRoot, stdio: "pipe" },
  );
}

const suite = ready ? describe : describe.skip;
const REQUEST_ID = /^0x[0-9a-f]{64}$/;

suite("e2e: the agreely bin vs the live /v1 API", () => {
  let checkEnv: Record<string, string>;
  let issueEnv: Record<string, string>;

  beforeAll(() => {
    checkEnv = { AGREELY_API_KEY: fixture!.keys.check, AGREELY_BASE_URL: fixture!.baseUrl };
    issueEnv = { AGREELY_API_KEY: fixture!.keys.issue, AGREELY_BASE_URL: fixture!.baseUrl };
  });

  it("whoami --json verifies the key server-side and reports its real scopes (exit 0, no secret leak)", async () => {
    const r = await runBin(["whoami", "--json"], checkEnv);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout.trim());
    expect(body.authenticated).toBe(true);
    // Server-verified scopes from /v1/whoami (a check key carries 'check').
    expect(Array.isArray(body.scopes)).toBe(true);
    expect(body.scopes).toContain("check");
    expect(body.apiKeyMasked).not.toContain(fixture!.keys.check.slice(10));
    expect(r.stdout).not.toContain(fixture!.keys.check);
  });

  it("check on an active grant -> ALLOW, exit 0, pure JSON", async () => {
    const r = await runBin(
      ["check", fixture!.subject, "Email Address", "Marketing Outreach", "--json"],
      checkEnv,
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ decision: "allow", status: "active" });
    expect(r.stderr).toBe("");
  });

  it("check on an absent grant -> DENY, exit 10", async () => {
    const r = await runBin(["check", fixture!.absent, "Email Address", "Marketing Outreach", "--json"], checkEnv);
    expect(r.code).toBe(10);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ decision: "deny", status: "none" });
  });

  it("a bad key -> exit 3, stdout stays clean", async () => {
    const r = await runBin(["check", fixture!.subject, "Email Address", "Marketing Outreach", "--json"], {
      AGREELY_API_KEY: "agr_live_" + "z".repeat(43),
      AGREELY_BASE_URL: fixture!.baseUrl,
    });
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("");
    expect(JSON.parse(r.stderr.trim())).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("a missing required arg in agent mode -> exit 2, never hangs", async () => {
    const r = await runBin(["check", fixture!.subject, "--json"], checkEnv);
    expect(r.code).toBe(2);
  });

  it("catalog --json lists the declared cells", async () => {
    const r = await runBin(["catalog", "--json"], checkEnv);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout.trim());
    expect(Array.isArray(body.catalog)).toBe(true);
    expect(body.catalog.length).toBeGreaterThan(0);
  });

  it("issuance -> a real 0x+64hex requestId; an idempotency replay returns the same id", async () => {
    const key = "cli-e2e-" + Math.random().toString(36).slice(2);
    const args = [
      "request", "create",
      "--customer", fixture!.subject,
      "--to", fixture!.issue.recipientEmail,
      "--document", fixture!.issue.documentId,
      "--valid-until", fixture!.issue.validUntil,
      "--idempotency-key", key,
      "--json",
    ];
    const first = await runBin(args, issueEnv);
    expect(first.code).toBe(0);
    const issued = JSON.parse(first.stdout.trim());
    expect(issued.requestId).toMatch(REQUEST_ID);
    expect(issued.status).toBe("pending");

    const replay = await runBin(args, issueEnv);
    expect(replay.code).toBe(0);
    expect(JSON.parse(replay.stdout.trim()).requestId).toBe(issued.requestId);

    // request show by the protocol requestId.
    const shown = await runBin(["request", "show", issued.requestId, "--json"], issueEnv);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.stdout.trim()).requestId).toBe(issued.requestId);

    // requests list --status pending surfaces it (bare `requests` alias too).
    const list = await runBin(["requests", "list", "--status", "pending", "--json"], issueEnv);
    expect(list.code).toBe(0);
    const page = JSON.parse(list.stdout.trim());
    expect(page.items.some((x: { requestId: string }) => x.requestId === issued.requestId)).toBe(true);

    // The --customer + --limit filters narrow it, and the record carries the new
    // customerId + documentCode metadata.
    const filtered = await runBin(
      ["requests", "list", "--customer", fixture!.subject, "--status", "pending", "--limit", "100", "--json"],
      issueEnv,
    );
    expect(filtered.code).toBe(0);
    const filteredPage = JSON.parse(filtered.stdout.trim());
    const mine = filteredPage.items.find(
      (x: { requestId: string }) => x.requestId === issued.requestId,
    );
    expect(mine).toBeDefined();
    expect(mine.customerId).toBe(fixture!.subject);
    expect(mine.documentCode).toBe(fixture!.issue.documentCode);
  });

  it("a --document-code is resolved to the published version server-side", async () => {
    const r = await runBin(
      [
        "request", "create",
        "--customer", fixture!.subject,
        "--to", fixture!.issue.recipientEmail,
        "--document-code", fixture!.issue.documentCode,
        "--valid-until", fixture!.issue.validUntil,
        "--json",
      ],
      issueEnv,
    );
    expect(r.code).toBe(0);
    const issued = JSON.parse(r.stdout.trim());
    expect(issued.requestId).toMatch(REQUEST_ID);
    expect(issued.document.code).toBe(fixture!.issue.documentCode);
    expect(issued.items[0]).toMatchObject({ category: fixture!.issue.category, purpose: fixture!.issue.purpose });
  });

  it("request cancel: pending -> cancelled (exit 0), then idempotent on the terminal state", async () => {
    const created = await runBin(
      [
        "request", "create",
        "--customer", fixture!.subject,
        "--to", fixture!.issue.recipientEmail,
        "--document", fixture!.issue.documentId,
        "--valid-until", fixture!.issue.validUntil,
        "--json",
      ],
      issueEnv,
    );
    expect(created.code).toBe(0);
    const requestId = JSON.parse(created.stdout.trim()).requestId;

    const cancelled = await runBin(["request", "cancel", requestId, "--json"], issueEnv);
    expect(cancelled.code).toBe(0);
    expect(JSON.parse(cancelled.stdout.trim())).toEqual({
      requestId,
      status: "revoked_before_action",
      cancelled: true,
    });

    // Idempotent: a second cancel is not an error and still exits 0.
    const again = await runBin(["request", "cancel", requestId, "--json"], issueEnv);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout.trim()).cancelled).toBe(false);
  });

  it("request cancel with a check-only key is a scope error (exit 3)", async () => {
    const r = await runBin(["request", "cancel", "0x" + "a".repeat(64), "--json"], checkEnv);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stderr.trim())).toMatchObject({ error: { code: "forbidden" } });
  });

  it("revoke-then-check: ALLOW becomes DENY (exit 10) on the next call", async () => {
    const { category, purpose, consentRef } = fixture!.revocable;
    const before = await runBin(["check", fixture!.subject, category, purpose, "--json"], checkEnv);
    expect(before.code).toBe(0);

    revokeOutOfBand(consentRef);

    const after = await runBin(["check", fixture!.subject, category, purpose, "--json"], checkEnv);
    expect(after.code).toBe(10);
    expect(JSON.parse(after.stdout.trim())).toMatchObject({ decision: "deny", status: "revoked" });
  });
});
