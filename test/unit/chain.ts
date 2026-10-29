// Local stubs for `agreely verify` run end to end: a JSON-RPC endpoint answering each eth_call by its selector and
// eth_getLogs from a vector case's answers (the SDK's vectorChainFetch, over HTTP because the CLI takes an --rpc-url
// and no fetch), and IPFS gateways mirrored on one local server. Every server listens on 127.0.0.1: no live network.

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** The AgreelyRegistry the CLI reads (Base mainnet, the SDK default), and the Base Sepolia one the vectors name. */
export const MAINNET_REGISTRY = "0x6f2cf94045cf0cbdd94338882c34d183575023e9";
export const SEPOLIA_REGISTRY = "0xf25d3f8e73648c797be2cccd428061f357567b9a";

/** The `answers` of a vector case (citizen-key-chain.json, recorded-v4.json). An answer absent is a JSON-RPC error. */
export interface VectorAnswers {
  registry?: Record<string, string>;
  keyOf?: string;
  companyKeyOf?: string;
  getCompanyDid?: string;
  anchorBatchLogs?: Array<Record<string, unknown>>;
}

const SELECTORS: Readonly<Record<string, "registry" | "keyOf" | "companyKeyOf" | "getCompanyDid">> = {
  "0x7ef50298": "registry",
  "0xdf78bce2": "keyOf",
  "0x25597a89": "companyKeyOf",
  "0x8181c629": "getCompanyDid",
};

/** What the stub chain was asked: the refs read with registry(bytes32), in order, and every call. */
export interface Chain {
  url: string;
  refs: string[];
  calls: number;
}

async function serve(
  handler: (req: IncomingMessage, body: string, res: ServerResponse) => void,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => handler(req, body, res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A JSON-RPC endpoint answering from `answers`, for the time of `fn`. */
export async function withChain(answers: VectorAnswers, fn: (chain: Chain) => Promise<void>): Promise<void> {
  const chain: Chain = { url: "", refs: [], calls: 0 };
  await serve(
    (_req, body, res) => {
      let call: { id?: unknown; method: string; params: unknown[] };
      try {
        call = JSON.parse(body) as typeof call;
      } catch {
        // A request the client gave up on can arrive without its body: answer it, never throw in the server.
        res.statusCode = 400;
        res.end();
        return;
      }
      chain.calls++;
      let out: unknown;
      if (call.method === "eth_getLogs") {
        out = answers.anchorBatchLogs;
      } else if (call.method === "eth_call") {
        const data = String((call.params[0] as { data?: string }).data ?? "").toLowerCase();
        const read = SELECTORS[data.slice(0, 10)];
        const arg = "0x" + data.slice(10, 74);
        if (read === "registry") {
          chain.refs.push(arg);
          out = answers.registry?.[arg];
        } else if (read !== undefined) {
          out = answers[read];
        }
      }
      const reply =
        out === undefined
          ? { jsonrpc: "2.0", id: call.id ?? 1, error: { code: -32000, message: "no answer" } }
          : { jsonrpc: "2.0", id: call.id ?? 1, result: out };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(reply));
    },
    async (base) => {
      chain.url = `${base}/`;
      await fn(chain);
    },
  );
}

/** The answers with every AnchorBatch log the Sepolia registry emitted moved to the mainnet registry. */
export function onMainnetAnswers(answers: VectorAnswers): VectorAnswers {
  if (answers.anchorBatchLogs === undefined) return answers;
  return {
    ...answers,
    anchorBatchLogs: answers.anchorBatchLogs.map((log) =>
      String(log["address"]).toLowerCase() === SEPOLIA_REGISTRY ? { ...log, address: MAINNET_REGISTRY } : log,
    ),
  };
}

/**
 * The bundle with its issuer delegation naming the mainnet registry. The SDK does not verify that delegation, so no
 * signature it checks moves (the SDK's own tests re-point a bundle the same way).
 */
export function onMainnetBundle<T>(bundle: T): T {
  const copy = structuredClone(bundle) as { didDocuments?: { issuer?: { delegation?: { body?: Record<string, unknown> } } } };
  const body = copy.didDocuments?.issuer?.delegation?.body;
  if (body !== undefined) {
    body["registry"] = MAINNET_REGISTRY;
    body["chainId"] = "8453";
  }
  return copy as T;
}

/** A gateway's answer in vectors/ipfs-gateways.json: an HTTP status and a body kind, or a network error. */
export interface GatewayAnswer {
  status?: number;
  body?: "pinned" | "html" | "other-json" | "oversize";
  network?: string;
}

/**
 * Every https gateway of `answers` mirrored at `${base}/<host>/<path>`. A URL with no answer, or a network answer,
 * closes the socket. `mirror` maps a vector's https gateway (a prefix or a {cid} template) to its local twin.
 */
export async function withGateways(
  answers: Record<string, GatewayAnswer>,
  pinnedFile: string,
  fn: (mirror: (https: string) => string) => Promise<void>,
): Promise<void> {
  const pinned = await readFile(pinnedFile);
  await serve(
    (req, _body, res) => {
      const answer = answers[`https:/${req.url ?? ""}`];
      if (answer === undefined || answer.network !== undefined) {
        req.socket.destroy();
        return;
      }
      res.statusCode = answer.status ?? 200;
      const body =
        answer.body === "pinned"
          ? pinned
          : answer.body === "html"
            ? "<!doctype html><html><body>gateway page</body></html>"
            : answer.body === "other-json"
              ? '{"disclosure":{}}'
              : answer.body === "oversize"
                ? " ".repeat(262145)
                : "";
      res.end(body);
    },
    (base) => fn((https) => https.replace(/^https:\//, base)),
  );
}
