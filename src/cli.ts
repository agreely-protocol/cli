// The command router. Wires commander to the command handlers, resolves the
// human-vs-agent mode, and funnels EVERY failure through the one exit-code
// mapper. run() is pure with respect to its injected Io + store, so the whole
// surface is unit-testable without spawning a process.

import { Command, CommanderError } from "commander";
import { checkCommand } from "./commands/check.js";
import { catalogCommand } from "./commands/catalog.js";
import { requestCreateCommand } from "./commands/request-create.js";
import { requestsCommand } from "./commands/requests.js";
import { requestShowCommand } from "./commands/request-show.js";
import { requestWaitCommand } from "./commands/request-wait.js";
import { verifyCommand } from "./commands/verify.js";
import {
  manualConsentClaimLinkCommand,
  manualConsentCreateCommand,
  manualConsentEraseCommand,
  manualConsentRevokeCommand,
} from "./commands/manual-consent.js";
import { whoamiCommand } from "./commands/whoami.js";
import { configSetCommand, loginCommand } from "./commands/login.js";
import type { CredentialStore } from "./config.js";
import { createContext, type Context, type GlobalFlags } from "./context.js";
import { EXIT, exitCodeForError } from "./errors.js";
import { defaultIo, type Io } from "./io.js";
import { reportError } from "./output.js";

export const VERSION = "0.1.0";

/** Attach the shared auth/output flags so they work before OR after a subcommand. */
function withGlobals(cmd: Command): Command {
  return cmd
    .option("--json", "force JSON output to stdout (agent mode; no prompts)")
    .option("--api-key <key>", "API key (discouraged — visible in `ps`; prefer AGREELY_API_KEY)")
    .option("--base-url <url>", "API base URL (overrides AGREELY_BASE_URL / config)");
}

/**
 * Run the CLI. Returns the process exit code; never calls process.exit (the bin
 * does that). `io` and `store` are injectable for tests.
 */
export async function run(
  argv: string[],
  io: Io = defaultIo(),
  store?: CredentialStore,
): Promise<number> {
  const program = new Command();
  let ctx: Context | undefined;

  program
    .name("agreely")
    .description("The Agreely consent gate — interactive for humans, scriptable JSON for agents.")
    .version(VERSION, "-v, --version", "print the version")
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
    });
  withGlobals(program);

  // Build the context for a subcommand from the merged (program + command) flags.
  const ctxFor = (cmd: Command): Context => {
    const opts = cmd.optsWithGlobals() as GlobalFlags;
    ctx = createContext(
      io,
      {
        ...(opts.json !== undefined ? { json: opts.json } : {}),
        ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
        ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
      },
      store,
    );
    return ctx;
  };

  withGlobals(
    program
      .command("check")
      .description("Check a consent decision (exit 0 allow, 10 deny, 4 outage)")
      .argument("<customerId>", "your reference for the subject")
      .argument("<category>", "the data category (raw; the server normalizes)")
      .argument("<purpose>", "the processing purpose (raw)"),
  ).action(async (customerId: string, category: string, purpose: string, _o, cmd: Command) => {
    await checkCommand(ctxFor(cmd), customerId, category, purpose);
  });

  withGlobals(
    program.command("catalog").description("List the company's declared active catalog"),
  ).action(async (_o, cmd: Command) => {
    await catalogCommand(ctxFor(cmd));
  });

  withGlobals(
    program.command("whoami").description("Verify the key — which key, source, and base URL"),
  ).action(async (_o, cmd: Command) => {
    await whoamiCommand(ctxFor(cmd));
  });

  withGlobals(
    program
      .command("requests")
      .description("List consent requests (cursor pagination)")
      .option("--status <status>", "filter: pending|approved|refused|expired|revoked_before_action")
      .option("--cursor <id>", "page after this requestId (from a prior nextCursor)"),
  ).action(async (opts: { status?: string; cursor?: string }, cmd: Command) => {
    await requestsCommand(ctxFor(cmd), {
      ...(opts.status !== undefined ? { status: opts.status } : {}),
      ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
    });
  });

  const request = program.command("request").description("Issue and inspect consent requests");

  withGlobals(
    request
      .command("create")
      .description("Issue a consent request (wizard for humans; flags for scripts)")
      .option("--customer <id>", "the subject reference")
      .option("--to <email>", "the recipient's email")
      .option(
        "--item <item>",
        "a catalog id OR category:purpose (repeatable)",
        (val: string, prev: string[]) => [...prev, val],
        [] as string[],
      )
      .option("--valid-until <date>", "consent lifespan if approved (YYYY-MM-DD)")
      .option("--idempotency-key <key>", "reuse to make a retry safe (no double-issue)"),
  ).action(
    async (
      opts: {
        customer?: string;
        to?: string;
        item?: string[];
        validUntil?: string;
        idempotencyKey?: string;
      },
      cmd: Command,
    ) => {
      await requestCreateCommand(ctxFor(cmd), {
        ...(opts.customer !== undefined ? { customer: opts.customer } : {}),
        ...(opts.to !== undefined ? { to: opts.to } : {}),
        ...(opts.item !== undefined && opts.item.length > 0 ? { item: opts.item } : {}),
        ...(opts.validUntil !== undefined ? { validUntil: opts.validUntil } : {}),
        ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      });
    },
  );

  withGlobals(
    request
      .command("show")
      .description("Show one consent request by its 0x+64hex requestId")
      .argument("<requestId>", "the protocol requestId (0x + 64 hex)"),
  ).action(async (requestId: string, _o, cmd: Command) => {
    await requestShowCommand(ctxFor(cmd), requestId);
  });

  withGlobals(
    request
      .command("wait")
      .description("Poll a request until it settles (approved|refused|expired|revoked_before_action); exit 4 on timeout")
      .argument("<requestId>", "the protocol requestId (0x + 64 hex)")
      .option("--interval <ms>", "poll interval in ms (default 2000)")
      .option("--timeout <ms>", "total wait budget in ms (default 120000)"),
  ).action(async (requestId: string, opts: { interval?: string; timeout?: string }, cmd: Command) => {
    await requestWaitCommand(ctxFor(cmd), requestId, {
      ...(opts.interval !== undefined ? { interval: opts.interval } : {}),
      ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    });
  });

  // The headline: offline-first receipt verification with an honest pass/trust
  // matrix (exit 6 = a real tamper; exit 4 = a DID could not be resolved).
  withGlobals(
    program
      .command("verify")
      .description("Verify a consent receipt offline-first; prints the honesty matrix (exit 6 tamper, 4 unresolvable)")
      .argument("<receipt.json>", "path to the receipt VC JSON file")
      .option("--ipfs", "also fetch + compare the IPFS disclosure copy (opt-in network)")
      .option("--onchain", "also check the on-chain document anchor (needs --rpc-url / AGREELY_RPC_URL)")
      .option("--rpc-url <url>", "JSON-RPC URL for the --onchain check")
      .option(
        "--did-doc <file>",
        "resolve DIDs from a local DID document file (repeatable) for an air-gapped verify",
        (val: string, prev: string[]) => [...prev, val],
        [] as string[],
      ),
  ).action(
    async (
      path: string,
      opts: { ipfs?: boolean; onchain?: boolean; rpcUrl?: string; didDoc?: string[] },
      cmd: Command,
    ) => {
      await verifyCommand(ctxFor(cmd), path, {
        ...(opts.ipfs !== undefined ? { ipfs: opts.ipfs } : {}),
        ...(opts.onchain !== undefined ? { onchain: opts.onchain } : {}),
        ...(opts.rpcUrl !== undefined ? { rpcUrl: opts.rpcUrl } : {}),
        ...(opts.didDoc !== undefined && opts.didDoc.length > 0 ? { didDoc: opts.didDoc } : {}),
      });
    },
  );

  // The manual / offline (company-attested) consent surface (scope: 'attest').
  const manualConsent = program
    .command("manual-consent")
    .description("Record an offline (company-attested) consent, mint a claim link, or revoke one");

  withGlobals(
    manualConsent
      .command("create")
      .description("Record a manual consent (the PDF is hashed locally; bytes upload only with --upload)")
      .option("--customer <id>", "the subject reference")
      .option("--document-version <id>", "the signed document version the consent attests to")
      .option("--effective-date <date>", "when the consent took effect (YYYY-MM-DD)")
      .option("--valid-until <date>", "the consent lifespan (YYYY-MM-DD)")
      .option(
        "--item <item>",
        "a catalog id OR category:purpose (repeatable)",
        (val: string, prev: string[]) => [...prev, val],
        [] as string[],
      )
      .option("--pdf <path>", "path to the signed PDF (its SHA-256 is computed locally)")
      .option("--upload", "also upload the PDF bytes (off by default; only the hash is sent)"),
  ).action(
    async (
      opts: {
        customer?: string;
        documentVersion?: string;
        effectiveDate?: string;
        validUntil?: string;
        item?: string[];
        pdf?: string;
        upload?: boolean;
      },
      cmd: Command,
    ) => {
      await manualConsentCreateCommand(ctxFor(cmd), {
        ...(opts.customer !== undefined ? { customer: opts.customer } : {}),
        ...(opts.documentVersion !== undefined ? { documentVersion: opts.documentVersion } : {}),
        ...(opts.effectiveDate !== undefined ? { effectiveDate: opts.effectiveDate } : {}),
        ...(opts.validUntil !== undefined ? { validUntil: opts.validUntil } : {}),
        ...(opts.item !== undefined && opts.item.length > 0 ? { item: opts.item } : {}),
        ...(opts.pdf !== undefined ? { pdf: opts.pdf } : {}),
        ...(opts.upload !== undefined ? { upload: opts.upload } : {}),
      });
    },
  );

  withGlobals(
    manualConsent
      .command("claim-link")
      .description("Mint a claim link the subject can use to self-claim the attestation")
      .option("--customer <id>", "the subject reference")
      .option("--reference <ref>", "an optional company-side reference to stamp on the claim"),
  ).action(async (opts: { customer?: string; reference?: string }, cmd: Command) => {
    await manualConsentClaimLinkCommand(ctxFor(cmd), {
      ...(opts.customer !== undefined ? { customer: opts.customer } : {}),
      ...(opts.reference !== undefined ? { reference: opts.reference } : {}),
    });
  });

  withGlobals(
    manualConsent
      .command("revoke")
      .description("Revoke a manual consent by its 0x-hex consentRef")
      .argument("<consentRef>", "the protocol consentRef (0x + hex)")
      .option("--reason <text>", "an optional operator reason recorded with the revocation"),
  ).action(async (consentRef: string, opts: { reason?: string }, cmd: Command) => {
    await manualConsentRevokeCommand(ctxFor(cmd), consentRef, {
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    });
  });

  withGlobals(
    manualConsent
      .command("erase")
      .description("Erase a manual consent by its 0x-hex consentRef (Law 25 art. 28.1)")
      .argument("<consentRef>", "the protocol consentRef (0x + hex)")
      .option("--reason <text>", "an optional operator reason recorded with the erasure"),
  ).action(async (consentRef: string, opts: { reason?: string }, cmd: Command) => {
    await manualConsentEraseCommand(ctxFor(cmd), consentRef, {
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    });
  });

  withGlobals(
    program.command("login").description("Store an API key in the OS keychain (interactive)"),
  ).action(async (_o, cmd: Command) => {
    await loginCommand(ctxFor(cmd));
  });

  // `config set` owns --api-key / --base-url as the values to STORE (not auth
  // flags), so it does NOT get withGlobals; it adds --json directly.
  const config = program.command("config").description("Manage stored CLI configuration");
  config
    .command("set")
    .description("Store an API key / base URL non-interactively")
    .option("--api-key <key>", "the API key to store")
    .option("--base-url <url>", "the base URL to store")
    .option("--json", "force JSON output")
    .action(async (opts: { apiKey?: string; baseUrl?: string; json?: boolean }, cmd: Command) => {
      await configSetCommand(ctxFor(cmd), {
        ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
        ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
      });
    });

  try {
    await program.parseAsync(argv);
    return ctx?.exit ?? EXIT.OK;
  } catch (err) {
    if (err instanceof CommanderError) {
      // help/version already wrote their output; treat as a clean (0) or usage (2) exit.
      if (err.exitCode === 0) return EXIT.OK;
      return EXIT.USAGE;
    }
    // A real command failure: map to a stable exit code and report (stdout stays clean).
    const c = ctx ?? createContext(io, {}, store);
    reportError(c, err);
    return exitCodeForError(err);
  }
}
