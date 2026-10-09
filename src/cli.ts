// The command router. Wires commander to the command handlers, resolves the
// human-vs-agent mode, and funnels EVERY failure through the one exit-code
// mapper. run() is pure with respect to its injected Io + store, so the whole
// surface is unit-testable without spawning a process.

import { Command, CommanderError } from "commander";
import { checkCommand } from "./commands/check.js";
import { catalogCommand } from "./commands/catalog.js";
import { requestCreateCommand } from "./commands/request-create.js";
import { requestsCommand } from "./commands/requests.js";
import { requestCancelCommand } from "./commands/request-cancel.js";
import { requestShowCommand } from "./commands/request-show.js";
import { requestWaitCommand } from "./commands/request-wait.js";
import { verifyCommand } from "./commands/verify.js";
import {
  manualConsentClaimLinkCommand,
  manualConsentCreateCommand,
  manualConsentEraseCommand,
  manualConsentRevokeCommand,
} from "./commands/manual-consent.js";
import { relationshipEndCommand } from "./commands/relationship-end.js";
import { relationshipRevertCommand } from "./commands/relationship-revert.js";
import {
  verbalConsentPaperCommand,
  verbalConsentRecordCommand,
  verbalConsentShowCommand,
  type VerbalPaperFlags,
  type VerbalRecordFlags,
} from "./commands/verbal-consent.js";
import { withdrawCommand, type WithdrawFlags } from "./commands/withdraw.js";
import { customerGetCommand, customerSetCommand, type CustomerSetFlags } from "./commands/customer.js";
import { retentionDisposeCommand, retentionShowCommand, type RetentionDisposeFlags } from "./commands/retention.js";
import {
  holdsListCommand,
  holdsPlaceCommand,
  holdsReleaseCommand,
  holdsSyncCommand,
  type HoldsListFlags,
  type HoldsPlaceFlags,
  type HoldsReleaseFlags,
  type HoldsSyncFlags,
} from "./commands/holds.js";
import { consentSheetCreateCommand, type ConsentSheetCreateFlags } from "./commands/consent-sheet.js";
import { documentsListCommand, documentsPdfCommand, documentsShowCommand, type DocumentsPdfFlags } from "./commands/documents.js";
import { collect } from "./flags.js";
import { whoamiCommand } from "./commands/whoami.js";
import { configSetCommand, loginCommand } from "./commands/login.js";
import type { CredentialStore } from "./config.js";
import { createContext, type Context, type GlobalFlags } from "./context.js";
import { EXIT, exitCodeForError } from "./errors.js";
import { defaultIo, type Io } from "./io.js";
import { reportError } from "./output.js";

export const VERSION = "0.4.0";

/** Attach the shared auth/output flags so they work before OR after a subcommand. */
function withGlobals(cmd: Command): Command {
  return cmd
    .option("--json", "force JSON output to stdout (agent mode; no prompts)")
    .option("--api-key <key>", "API key (discouraged: visible in `ps`; prefer AGREELY_API_KEY)")
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
    .description("The Agreely consent gate: interactive for humans, scriptable JSON for agents.")
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
      .description("Check a consent decision (exit 0 allow, 10 deny, 4 outage, 7 the company's billing lapsed). Use --batch <file.json> for bulk checks.")
      .argument("[customerId]", "your reference for the subject (omit with --batch)")
      .argument("[category]", "the data category (raw; the server normalizes; omit with --batch)")
      .argument("[purpose]", "the processing purpose (raw; omit with --batch)")
      .option("--batch <file>", "path to a JSON file: array of {customerRef, category, purpose}")
      .addHelpText(
        "after",
        "\nLabels are bilingual and accent-tolerant. The category and purpose may be given in" +
          "\nFrench OR English, with or without accents, matched case- and whitespace-insensitively." +
          "\nEnglish resolves only when the company disclosed an English label for that cell; an" +
          "\nambiguous or undeclared label fails closed. Pass the label as declared in the catalog.",
      ),
  ).action(
    async (
      customerId: string | undefined,
      category: string | undefined,
      purpose: string | undefined,
      opts: { batch?: string },
      cmd: Command,
    ) => {
      await checkCommand(ctxFor(cmd), customerId, category, purpose, opts.batch);
    },
  );

  withGlobals(
    program
      .command("catalog")
      .description("List the company's declared active catalog")
      .option("--document <code>", "only the active cells of one published document, with its documentVersionId"),
  ).action(async (opts: { document?: string }, cmd: Command) => {
    await catalogCommand(ctxFor(cmd), opts.document !== undefined ? { document: opts.document } : {});
  });

  withGlobals(
    program.command("whoami").description("Verify the key: which key, source, and base URL"),
  ).action(async (_o, cmd: Command) => {
    await whoamiCommand(ctxFor(cmd));
  });

  // `requests list` is the documented form; the bare `requests` is a kept alias.
  type RequestsOpts = { customer?: string; status?: string; limit?: string; cursor?: string };
  const runRequests = async (opts: RequestsOpts, cmd: Command): Promise<void> => {
    await requestsCommand(ctxFor(cmd), {
      ...(opts.customer !== undefined ? { customer: opts.customer } : {}),
      ...(opts.status !== undefined ? { status: opts.status } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
    });
  };
  const withRequestsListFlags = (cmd: Command): Command =>
    cmd
      .option("--customer <ref>", "filter to one subject ref (the company's own customerId)")
      .option("--status <status>", "filter: pending|approved|asks_declined|refused|expired|revoked_before_action")
      .option("--limit <n>", "page size (server default 50, max 100)")
      .option("--cursor <id>", "page after this requestId (from a prior nextCursor)");

  const requests = program
    .command("requests")
    .description("List consent requests (metadata only, cursor pagination)")
    .enablePositionalOptions();
  // Bare `agreely requests [--customer ...] ...` stays working (alias of `list`).
  withGlobals(withRequestsListFlags(requests)).action(async (opts: RequestsOpts, cmd: Command) => {
    await runRequests(opts, cmd);
  });
  withGlobals(
    withRequestsListFlags(
      requests
        .command("list")
        .description("List consent requests, newest first (metadata only)"),
    ),
  ).action(async (opts: RequestsOpts, cmd: Command) => {
    await runRequests(opts, cmd);
  });

  const request = program.command("request").description("Issue and inspect consent requests");

  withGlobals(
    request
      .command("create")
      .description("Issue a consent request under a published consent document (wizard for humans; flags for scripts)")
      .option("--customer <id>", "the subject reference")
      .option("--to <email>", "the recipient's email")
      .option("--document <versionId>", "the published consent document version id the request is issued under")
      .option("--document-code <code>", "a consent document code (resolves to its published version)")
      .option("--valid-until <date>", "consent end if approved (YYYY-MM-DD, through the end of that day in your company's timezone; at most 10 years)")
      .option("--idempotency-key <key>", "reuse to make a retry safe (no double-issue)"),
  ).action(
    async (
      opts: {
        customer?: string;
        to?: string;
        document?: string;
        documentCode?: string;
        validUntil?: string;
        idempotencyKey?: string;
      },
      cmd: Command,
    ) => {
      await requestCreateCommand(ctxFor(cmd), {
        ...(opts.customer !== undefined ? { customer: opts.customer } : {}),
        ...(opts.to !== undefined ? { to: opts.to } : {}),
        ...(opts.document !== undefined ? { document: opts.document } : {}),
        ...(opts.documentCode !== undefined ? { documentCode: opts.documentCode } : {}),
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
      .command("cancel")
      .description("Cancel a pending consent request by its 0x+64hex requestId (idempotent)")
      .argument("<requestId>", "the protocol requestId (0x + 64 hex)"),
  ).action(async (requestId: string, _o, cmd: Command) => {
    await requestCancelCommand(ctxFor(cmd), requestId);
  });

  withGlobals(
    request
      .command("wait")
      .description("Poll a request until it is no longer pending (approved|asks_declined|refused|expired|revoked_before_action); exit 4 on timeout")
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
        collect,
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
      .option("--valid-until <date>", "the consent end (YYYY-MM-DD, through the end of that day in your company's timezone; at most 10 years)")
      .option(
        "--item <item>",
        "a consent ask ticked on the sheet: a catalog id OR category:purpose, split on the first colon (a category containing a colon needs the catalog id; repeatable; omit when every ask was answered no)",
        collect,
        [] as string[],
      )
      .option("--pdf <path>", "path to the signed PDF (its SHA-256 is computed locally)")
      .option("--upload", "also upload the PDF bytes (off by default; only the hash is sent)")
      .option("--sensitive-express-attested", "attest the consent to a sensitive purpose was given expressly")
      .option("--version-attested", "attest the signed sheet is the version recorded")
      .option("--idempotency-key <key>", "reuse to make a retry safe (generated and printed on a timeout when omitted)"),
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
        sensitiveExpressAttested?: boolean;
        versionAttested?: boolean;
        idempotencyKey?: string;
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
        ...(opts.sensitiveExpressAttested !== undefined ? { sensitiveExpressAttested: opts.sensitiveExpressAttested } : {}),
        ...(opts.versionAttested !== undefined ? { versionAttested: opts.versionAttested } : {}),
        ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
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
      .argument("<consentRef>", "the consentRef (64 hex, 0x prefix optional)")
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
      .argument("<consentRef>", "the consentRef (64 hex, 0x prefix optional)")
      .option("--reason <text>", "an optional operator reason recorded with the erasure"),
  ).action(async (consentRef: string, opts: { reason?: string }, cmd: Command) => {
    await manualConsentEraseCommand(ctxFor(cmd), consentRef, {
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    });
  });

  // End a customer relationship (Law 25 art. 23) from the company's own tooling
  // (scope: 'relationship'). Keyed on the company's OWN customerRef, never a DID.
  const relationship = program
    .command("relationship")
    .description("Manage the customer-relationship lifecycle (art. 23)");

  withGlobals(
    relationship
      .command("end")
      .description("End a customer relationship: attest the purposes are accomplished (art. 23)")
      .argument("<customerRef>", "the company's own reference for the customer (never a DID)")
      .option("--reason <text>", "the required art. 23 justification for ending the relationship"),
  ).action(async (customerRef: string, opts: { reason?: string }, cmd: Command) => {
    await relationshipEndCommand(ctxFor(cmd), customerRef, {
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    });
  });

  withGlobals(
    relationship
      .command("revert")
      .description("Undo a mistaken end of relationship (an art. 11 / art. 28 correction)")
      .argument("<customerRef>", "the company's own reference for the customer (never a DID)")
      .option("--reason <text>", "the required art. 11 / art. 28 justification for undoing the end"),
  ).action(async (customerRef: string, opts: { reason?: string }, cmd: Command) => {
    await relationshipRevertCommand(ctxFor(cmd), customerRef, {
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    });
  });

  /**
   * Forward only the options the user actually passed, and never the global flags
   * (--api-key, --base-url, --json), so a secret can never travel into a request.
   */
  const GLOBAL_KEYS = new Set(["json", "apiKey", "baseUrl"]);
  const defined = <T extends object>(o: T): T =>
    Object.fromEntries(
      Object.entries(o).filter(
        ([k, v]) => !GLOBAL_KEYS.has(k) && v !== undefined && !(Array.isArray(v) && v.length === 0),
      ),
    ) as T;

  // Verbal (telephone) consents: scope attest_verbal to record, attest for the paper.
  const verbal = program.command("verbal-consent").description("Record a consent given by telephone, read its history, or confirm it with the signed paper");
  withGlobals(
    verbal
      .command("record")
      .description("Record a telephone consent (tier verbal, assurance company_documented)")
      .option("--customer <id>", "the subject reference")
      .option("--document-version <id>", "the published document version the call was held against")
      .option("--answer <answer>", 'one consent ask answered, "category:purpose=yes|no", split on the first colon (a category containing a colon cannot be written; repeatable)', collect, [] as string[])
      .option("--obtained-at <instant>", "the instant of the call (RFC 3339 with an offset; at most 7 days old)")
      .option("--obtained-by <staff>", "the staff member who took the call")
      .option("--script-version <label>", "the version label of the script read aloud")
      .option("--consented-by <who>", "self | self_with_assistant | representative")
      .option("--capacity <capacity>", "the representative's capacity (representative only)")
      .option("--respondent-name <name>", "who answered for a minor under 14")
      .option("--valid-until <date>", "the consent end (YYYY-MM-DD or an RFC 3339 instant; at most 10 years)")
      .option("--sensitive-express-attested", "attest the consent to a sensitive purpose was given expressly")
      .option("--minor", "the person is a minor under 14")
      .option("--paper-expected", "the signed paper is expected back")
      .option("--idempotency-key <key>", "reuse to make a retry safe"),
  ).action(async (opts: VerbalRecordFlags, cmd: Command) => {
    await verbalConsentRecordCommand(ctxFor(cmd), defined(opts));
  });
  withGlobals(
    verbal
      .command("show")
      .description("Show what was said on the call, what the paper said, and what is in force")
      .argument("<consentId>", "the verbal consentId (uuid)"),
  ).action(async (consentId: string, _o, cmd: Command) => {
    await verbalConsentShowCommand(ctxFor(cmd), consentId);
  });
  withGlobals(
    verbal
      .command("paper")
      .description("Record the signed paper of a verbal consent (raises it to a manual consent)")
      .argument("<consentId>", "the verbal consentId (uuid)")
      .option("--signed-at <instant>", "when the paper was signed (RFC 3339 with an offset)")
      .option("--answer <answer>", 'each purpose still consented, "category:purpose=yes|no" (repeatable)', collect, [] as string[])
      .option("--pdf <path>", "path to the signed PDF (its SHA-256 is computed locally)")
      .option("--upload", "also upload the PDF bytes (off by default; only the hash is sent)")
      .option("--idempotency-key <key>", "reuse to make a retry safe"),
  ).action(async (consentId: string, opts: VerbalPaperFlags, cmd: Command) => {
    await verbalConsentPaperCommand(ctxFor(cmd), consentId, defined(opts));
  });

  withGlobals(
    program
      .command("withdraw")
      .description("Record a withdrawal the person asked for, on her behalf (scope withdraw; exit 8 on the daily cap)")
      .argument("<customerRef>", "the company's own reference for the customer")
      .argument("<consentRef>", "the consentRef (64 hex, 0x prefix optional)")
      .option("--channel <channel>", "phone | email | mail | in_person | other")
      .option("--operator <id>", "your opaque id of the staff member who received the request (never an email)")
      .option("--requested-at <instant>", "when the person asked (RFC 3339 with an offset)")
      .option("--reason <text>", "an optional reason (at most 1000 characters)")
      .option("--idempotency-key <key>", "reuse to make a retry safe"),
  ).action(async (customerRef: string, consentRef: string, opts: WithdrawFlags, cmd: Command) => {
    await withdrawCommand(ctxFor(cmd), customerRef, consentRef, defined(opts));
  });

  const customer = program.command("customer").description("The customer registry (scope registry): metadata and identity");
  withGlobals(
    customer
      .command("get")
      .description("Show what Agreely holds for a customer, as metadata (never the personal fields)")
      .argument("<customerRef>", "the company's own reference for the customer"),
  ).action(async (customerRef: string, _o, cmd: Command) => {
    await customerGetCommand(ctxFor(cmd), customerRef);
  });
  withGlobals(
    customer
      .command("set")
      .description("Create or merge a customer identity (an absent flag is untouched, an empty value clears it)")
      .argument("<customerRef>", "the company's own reference for the customer")
      .option("--display-name <name>", "the display name (at most 200 characters)")
      .option("--email <email>", "the email address")
      .option("--basis-note <text>", "a note on the ground the customer is held on")
      .option("--legal-basis <basis>", "the non-consent ground the customer is held on")
      .option("--notice-locale <locale>", "fr | en"),
  ).action(async (customerRef: string, opts: CustomerSetFlags, cmd: Command) => {
    await customerSetCommand(ctxFor(cmd), customerRef, defined(opts));
  });

  const retention = program.command("retention").description("Per-customer retention (scope registry)");
  withGlobals(
    retention
      .command("show")
      .description("Show a customer's retention clock, standing disposition and holds")
      .argument("<customerRef>", "the company's own reference for the customer"),
  ).action(async (customerRef: string, _o, cmd: Command) => {
    await retentionShowCommand(ctxFor(cmd), customerRef);
  });
  withGlobals(
    retention
      .command("dispose")
      .description("Declare what you did with a customer's information once the relationship ended")
      .argument("<customerRef>", "the company's own reference for the customer")
      .option("--disposition <kind>", "destroyed | anonymized | legal_hold")
      .option("--reason <text>", "required for legal_hold: the law that imposes the delay")
      .option("--retention-until <date>", "legal_hold only: YYYY-MM-DD")
      .option("--schedule-ref <ref>", "the conservation rule this was made under"),
  ).action(async (customerRef: string, opts: RetentionDisposeFlags, cmd: Command) => {
    await retentionDisposeCommand(ctxFor(cmd), customerRef, defined(opts));
  });

  const holds = program.command("holds").description("Retention holds: place, release, and sync the feed");
  withGlobals(
    holds
      .command("place")
      .description("Place a retention hold on a customer (scope registry)")
      .argument("<customerRef>", "the company's own reference for the customer")
      .option("--ground <ground>", "rights_request | other_law")
      .option("--provision <text>", "other_law only: the law that requires keeping the information")
      .option("--rule <key>", "limit to a retention rule key (repeatable; omit for everything)", collect, [] as string[])
      .option("--cell <id>", "limit to a catalog cell id (repeatable; omit for everything)", collect, [] as string[])
      .option("--started-on <date>", "YYYY-MM-DD (default today)")
      .option("--review-on <date>", "YYYY-MM-DD, a reminder only")
      .option("--idempotency-key <key>", "reuse to make a retry safe"),
  ).action(async (customerRef: string, opts: HoldsPlaceFlags, cmd: Command) => {
    await holdsPlaceCommand(ctxFor(cmd), customerRef, defined(opts));
  });
  withGlobals(
    holds
      .command("release")
      .description("Release a retention hold (scope registry)")
      .argument("<customerRef>", "the company's own reference for the customer")
      .argument("<holdId>", "the hold id (uuid)")
      .option("--reason <text>", "required: why the hold is released")
      .option("--idempotency-key <key>", "reuse to make a retry safe"),
  ).action(async (customerRef: string, holdId: string, opts: HoldsReleaseFlags, cmd: Command) => {
    await holdsReleaseCommand(ctxFor(cmd), customerRef, holdId, defined(opts));
  });
  withGlobals(
    holds
      .command("list")
      .description("Read ONE page of the holds feed (scope holds)")
      .option("--changed-since <cursor>", "the cursor of a previous sync's last page (omit for the snapshot)")
      .option("--page-token <token>", "the nextPageToken of the previous page"),
  ).action(async (opts: HoldsListFlags, cmd: Command) => {
    await holdsListCommand(ctxFor(cmd), defined(opts));
  });
  withGlobals(
    holds
      .command("sync")
      .description("Walk EVERY page of the holds feed and print the cursor to keep (scope holds)")
      .option("--changed-since <cursor>", "the previous sync's cursor (omit for a snapshot)")
      .option("--max-pages <n>", "bound on pages read (default 1000; reaching it throws rather than print a partial feed)"),
  ).action(async (opts: HoldsSyncFlags, cmd: Command) => {
    await holdsSyncCommand(ctxFor(cmd), defined(opts));
  });

  const consentSheet = program.command("consent-sheet").description("Mint the signature sheet of a published document for a customer");
  withGlobals(
    consentSheet
      .command("create")
      .description("Mint a signature sheet with a new claim; the PDF goes to --out, the reference and claim print once")
      .argument("<customerRef>", "the company's own reference for the customer")
      .option("--document-version <id>", "a published document version that carries at least one consent ask")
      .option("--out <file>", "where to write the PDF (never stdout)")
      .option("--locale <locale>", "fr (default) | en")
      .option("--idempotency-key <key>", "a repeated key is a 409 already_minted")
      .option("--force", "overwrite --out if it exists"),
  ).action(async (customerRef: string, opts: ConsentSheetCreateFlags, cmd: Command) => {
    await consentSheetCreateCommand(ctxFor(cmd), customerRef, defined(opts));
  });

  const documents = program.command("documents").description("The published consent documents (read-only)");
  withGlobals(documents.command("list").description("List the published consent documents")).action(
    async (_o, cmd: Command) => {
      await documentsListCommand(ctxFor(cmd));
    },
  );
  withGlobals(
    documents
      .command("show")
      .description("Show one published document by its stable code (--json for the full disclosure)")
      .argument("<code>", "the document code"),
  ).action(async (code: string, _o, cmd: Command) => {
    await documentsShowCommand(ctxFor(cmd), code);
  });
  withGlobals(
    documents
      .command("pdf")
      .description("Write the information document of one version to a PDF file")
      .argument("<documentVersionId>", "the published document version id")
      .option("--out <file>", "where to write the PDF (never stdout)")
      .option("--locale <locale>", "fr (default) | en")
      .option("--force", "overwrite --out if it exists"),
  ).action(async (documentVersionId: string, opts: DocumentsPdfFlags, cmd: Command) => {
    await documentsPdfCommand(ctxFor(cmd), documentVersionId, defined(opts));
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
