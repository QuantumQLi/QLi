/****
 * REVIEW ONLY. This is Lovable source snapshot 1293a24ca514bb49c0d86fcdcdfcf9a352316856 with the blockhash fix.
 * GitHub main is not synchronized. DO NOT merge/copy to production until dependency sources
 * have been synced and tests have run against complete Lovable application.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { DBC_PROGRAM_ID } from "./dbc";

/** Build/send stage where an error happened; shown in diagnostics. */
export type LaunchStage =
  | "metadata"
  | "rpc-preflight"
  | "sdk-build"
  | "simulation"
  | "wallet"
  | "send"
  | "confirm"
  | "verify";

export type LaunchErrorCategory =
  | "wallet-rejected"
  | "blockhash-expired"
  | "rpc-forbidden"
  | "rpc-rate-limited"
  | "rpc-timeout"
  | "rpc-unreachable"
  | "metadata-unreachable"
  | "metadata-invalid"
  | "genesis-mismatch"
  | "program-missing"
  | "insufficient-funds"
  | "simulation-failed"
  | "sdk-invalid-config"
  | "safety-refused"
  | "unexpected";

export type ClassifiedError = {
  category: LaunchErrorCategory;
  stage: LaunchStage;
  /** Safe, user-facing explanation with a next step. */
  message: string;
  /** Program error code (e.g. Custom 6013 / 0x177d) when present. */
  code: string | null;
  /** Sanitized detail (no URLs, no query strings, bounded length). */
  detail: string;
};

/** Removes URLs, query strings and long tokens that might carry credentials. */
export function sanitize(text: string, max = 600): string {
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, "[url]")
    .replace(/[?&](api[-_]?key|key|token|auth|secret)=[^\s&"']+/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{60,}\b/g, "[redacted]")
    .slice(0, max);
}

function codeOf(m: string): string | null {
  const custom = m.match(/"?Custom"?\s*[:(]\s*(\d+)/);
  if (custom) return `Custom ${custom[1]} (0x${Number(custom[1]).toString(16)})`;
  const hex = m.match(/custom program error: (0x[0-9a-f]+)/i);
  if (hex) return `Custom ${parseInt(hex[1]!, 16)} (${hex[1]})`;
  const named = m.match(
    /"(InsufficientFundsForRent|AccountNotFound|InsufficientFundsForFee|BlockhashNotFound|InvalidAccountData)"/,
  );
  return named ? named[1]! : null;
}

const MESSAGES: Record<LaunchErrorCategory, string> = {
  "wallet-rejected": "Wallet request rejected. Nothing was submitted.",
  "blockhash-expired":
    "The simulation RPC could not recognize the recent blockhash (possibly a lagging node or expiration). Rebuild against a consistent Devnet RPC. Nothing was submitted.",
  "rpc-forbidden":
    "The RPC refused the request (HTTP 403). Set a dedicated HTTPS RPC for this session in System, then build again. Nothing was submitted.",
  "rpc-rate-limited":
    "The RPC is rate-limiting this browser (HTTP 429). Wait a minute and build again once, or set a dedicated HTTPS RPC for this session in System. Nothing was submitted.",
  "rpc-timeout":
    "The RPC did not answer in time. Check RPC health in Network Lab, then build again.",
  "rpc-unreachable":
    "The browser could not reach the RPC (network error or blocked by the browser). Run the RPC check below or in Network Lab. Nothing was submitted.",
  "metadata-unreachable":
    "Your metadata URL could not be read from the browser. The host may block cross-site requests (CORS) or be offline. Host the JSON somewhere that allows public browser reads, then build again. The RPC was not contacted yet.",
  "metadata-invalid": "Metadata JSON is invalid for this launch.",
  "genesis-mismatch":
    "The RPC belongs to a different Solana network than the one selected in System. Choose a matching RPC; nothing switches networks automatically.",
  "program-missing": "The Meteora DBC program was not found as executable on the selected network.",
  "insufficient-funds": "Not enough SOL for this step.",
  "simulation-failed": "The transaction failed in simulation, so it was not offered for signing.",
  "sdk-invalid-config": "The Meteora toolkit refused these launch settings.",
  "safety-refused": "A safety check refused this transaction. Nothing was signed.",
  unexpected: "Unexpected error. Nothing was submitted unless a signature is shown.",
};

export function classifyLaunchError(error: unknown, stage: LaunchStage): ClassifiedError {
  const raw = error instanceof Error ? error.message : String(error);
  const m = sanitize(raw);
  const name = error instanceof Error ? error.name : "";
  const pick = (category: LaunchErrorCategory, keepDetail = false): ClassifiedError => ({
    category,
    stage,
    message: keepDetail ? `${MESSAGES[category]} ${m}` : MESSAGES[category],
    code: codeOf(raw),
    detail: m,
  });
  if (/user rejected|reject|declin|4001/i.test(raw)) return pick("wallet-rejected");
  if (/Insufficient (Devnet )?SOL|insufficient (funds|lamports)|InsufficientFunds/i.test(raw))
    return pick("insufficient-funds", true);
  if (/blockhash not found|BlockhashNotFound|minimum context slot|MinContextSlotNotReached/i.test(raw))
    return pick("blockhash-expired", true);
  if (/Simulation failed/i.test(raw)) return pick("simulation-failed", true);
  if (/RPC network differs|genesis/i.test(raw)) return pick("genesis-mismatch");
  if (/DBC program is not deployed|program .*not (found|executable)/i.test(raw))
    return pick("program-missing");
  if (/^Metadata/.test(raw) && /HTTP \d+|must|does not match/.test(raw))
    return pick("metadata-invalid", true);
  if (stage === "metadata" && error instanceof SyntaxError) return pick("metadata-invalid", true);
  if (stage === "metadata") return pick("metadata-unreachable");
  if (/\b403\b|forbidden/i.test(raw)) return pick("rpc-forbidden");
  if (/\b429\b|too many requests|rate.?limit/i.test(raw)) return pick("rpc-rate-limited");
  if (/timed? ?out|timeout|AbortError/i.test(raw) || name === "AbortError")
    return pick("rpc-timeout");
  if (/blockhash not found|block height exceeded|expired/i.test(raw))
    return pick("blockhash-expired");
  if (/failed to fetch|fetch failed|networkerror|load failed|ECONNREFUSED|ENOTFOUND/i.test(raw))
    return pick("rpc-unreachable");
  if (
    /refused|Unexpected (signer|program)|exceeds the 1232|Devnet-only|not owned|does not invoke/i.test(
      raw,
    )
  )
    return pick("safety-refused", true);
  if (/Sum of|must (be|equal)|Invalid|out of range|BN|overflow/i.test(raw))
    return pick("sdk-invalid-config", true);
  return pick("unexpected", true);
}

/** Sanitized, copyable diagnostics; never includes the RPC URL or any wallet secret. */
export function launchDiagnostics(
  c: ClassifiedError,
  ctx: { network: string; rpcIsPublicDefault: boolean; walletConnected: boolean; sdk: string },
) {
  return JSON.stringify(
    {
      kind: "qli-launch-diagnostics/v1",
      at: new Date().toISOString(),
      stage: c.stage,
      category: c.category,
      code: c.code,
      detail: c.detail,
      network: ctx.network,
      rpc: ctx.rpcIsPublicDefault ? "public default" : "custom (hidden)",
      walletConnected: ctx.walletConnected,
      sdk: ctx.sdk,
    },
    null,
    2,
  );
}

export type RpcCheck = { name: string; ok: boolean; ms: number; note: string };
/** Read-only RPC checks used by a DBC launch. Nothing is signed or sent. */
export async function rpcLaunchHealth(
  connection: Connection,
  expectedGenesis: string,
): Promise<RpcCheck[]> {
  const out: RpcCheck[] = [];
  const run = async (name: string, f: () => Promise<string>) => {
    const t = Date.now();
    try {
      const note = await f();
      out.push({ name, ok: true, ms: Date.now() - t, note });
    } catch (e) {
      const c = classifyLaunchError(e, "rpc-preflight");
      out.push({
        name,
        ok: false,
        ms: Date.now() - t,
        note: `${c.category}: ${c.detail.slice(0, 160)}`,
      });
    }
  };
  await run("getGenesisHash", async () => {
    const g = await connection.getGenesisHash();
    if (g !== expectedGenesis) throw new Error("RPC network differs from the selected network.");
    return "matches selected network";
  });
  await run("getAccountInfo(DBC program)", async () => {
    const a = await connection.getAccountInfo(new PublicKey(DBC_PROGRAM_ID));
    if (!a?.executable) throw new Error("Meteora DBC program is not deployed on this network.");
    return "executable";
  });
  let blockhash = "";
  await run("getLatestBlockhash", async () => {
    blockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    return "ok";
  });
  const probe = Keypair.generate().publicKey;
  const tx = new Transaction({
    feePayer: probe,
    recentBlockhash: blockhash || probe.toBase58(),
  }).add(SystemProgram.transfer({ fromPubkey: probe, toPubkey: probe, lamports: 0 }));
  await run("getFeeForMessage", async () => {
    const f = await connection.getFeeForMessage(tx.compileMessage(), "confirmed");
    return `${f.value ?? "unknown"} lamports`;
  });
  await run("simulateTransaction (unsigned probe)", async () => {
    const r = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    // An empty probe account is expected to fail with AccountNotFound; a reply proves the method works.
    return r.value.err ? `responded (${JSON.stringify(r.value.err).slice(0, 40)})` : "responded";
  });
  return out;
}