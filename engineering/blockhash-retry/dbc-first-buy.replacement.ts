/****
 * REVIEW ONLY. This is Lovable source snapshot 1293a24ca514bb49c0d86fcdcdfcf9a352316856 with the blockhash fix.
 * GitHub main is not synchronized. DO NOT merge/copy to production until dependency sources
 * have been synced and tests have run against complete Lovable application.
 */
import { ensureBrowserBuffer } from "./buffer-bootstrap";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Commitment,
  type TransactionSignature,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  DynamicBondingCurveClient,
  TokenAuthorityOption,
  deriveDbcPoolAddress,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { DBC_PROGRAM_ID } from "./dbc";
import {
  ALLOWED_PROGRAMS,
  GENESIS,
  WSOL_MINT,
  curveConfig,
  validateLaunchForm,
  type LaunchForm,
  type LaunchNetwork,
} from "./dbc-launch";

// Derived locally (no @solana/spl-token import) so the browser bundle needs no Node Buffer global.
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export function associatedTokenAddress(mint: PublicKey, owner: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ATA_PROGRAM_ID,
  )[0];
}

/**
 * Standard DBC launch WITH a creator first buy, Devnet only.
 *
 * SDK 1.5.13 `createConfigAndPoolWithFirstBuy` returns TWO transactions, so this path is
 * deliberately two-stage and NOT atomic:
 *   Stage 1 — create the DBC config (wallet + fresh config keypair sign).
 *   Stage 2 — `creator.createPoolWithFirstBuy`: pool init + first buy in ONE transaction
 *             (wallet + fresh mint keypair sign). Pool and buy land or fail together.
 * If stage 1 confirms and stage 2 fails, the config exists without a pool; stage 2 can be
 * rebuilt against the same confirmed config with a new mint. Nothing is retried automatically.
 */
export const FIRST_BUY_NETWORKS: readonly LaunchNetwork[] = ["devnet", "localnet"];
/** Preflight bound on the first-buy input, not an on-chain cap. */
export const DEVNET_FIRST_BUY_MAX_LAMPORTS = 500_000_000; // 0.5 SOL
export const FIRST_BUY_MAX_SLIPPAGE_BPS = 500;
/** Extra balance kept for fees, ATA/wSOL rent and pool rent, on top of the buy input. */
export const FIRST_BUY_RESERVE_LAMPORTS = 60_000_000; // 0.06 SOL heuristic

export function validateFirstBuy(
  lamports: number,
  slippageBps: number,
  network: LaunchNetwork,
): string[] {
  const e: string[] = [];
  if (!FIRST_BUY_NETWORKS.includes(network))
    e.push(
      "First buy is Devnet-only until a Devnet first-buy launch is proven on chain and the owner explicitly tests Mainnet.",
    );
  if (!Number.isInteger(lamports) || lamports <= 0)
    e.push("First buy must be a positive whole number of lamports.");
  else if (lamports > DEVNET_FIRST_BUY_MAX_LAMPORTS)
    e.push("First buy exceeds the 0.5 SOL Devnet preflight bound.");
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > FIRST_BUY_MAX_SLIPPAGE_BPS)
    e.push("First-buy slippage must be 1–500 bps.");
  return e;
}

/** Minimum base out after slippage, integer-safe. */
export function minimumOutAfterSlippage(expected: bigint, slippageBps: number): bigint {
  if (expected <= 0n) throw new Error("Quoted first-buy output is zero. Launch refused.");
  const min = (expected * BigInt(10_000 - slippageBps)) / 10_000n;
  if (min <= 0n) throw new Error("Minimum output after slippage is zero. Launch refused.");
  return min;
}

/** Parses an SPL token account (165 bytes): mint, owner, amount. */
export function parseTokenAccount(data: Uint8Array) {
  if (data.length < 72) throw new Error("Not a token account.");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mint: new PublicKey(data.slice(0, 32)).toBase58(),
    owner: new PublicKey(data.slice(32, 64)).toBase58(),
    amount: view.getBigUint64(64, true),
  };
}

export function checkFirstBuyFunds(balance: number, buyLamports: number, feeLamports: number) {
  const need = buyLamports + feeLamports + FIRST_BUY_RESERVE_LAMPORTS;
  if (balance < need)
    throw new Error(
      `Insufficient Devnet SOL: need about ${(need / 1e9).toFixed(4)} SOL (first buy + fees + rent reserve), wallet has ${(balance / 1e9).toFixed(4)} SOL.`,
    );
}

type Deps = { client?: Pick<DynamicBondingCurveClient, "partner" | "creator" | "state"> };

async function preflight(connection: Connection, network: LaunchNetwork, commitment: Commitment) {
  if (!FIRST_BUY_NETWORKS.includes(network))
    throw new Error("First-buy launches are Devnet-only. Mainnet is fail-closed.");
  if (network !== "localnet" && (await connection.getGenesisHash()) !== GENESIS[network])
    throw new Error("RPC network differs from the selected network.");
  const program = await connection.getAccountInfo(new PublicKey(DBC_PROGRAM_ID), commitment);
  if (!program?.executable) throw new Error("Meteora DBC program is not deployed on this network.");
}

function checkShape(tx: Transaction, expectedSigners: string[]) {
  const message = tx.compileMessage();
  const signers = message.accountKeys
    .slice(0, message.header.numRequiredSignatures)
    .map((k) => k.toBase58());
  const want = new Set(expectedSigners);
  if (signers.length !== want.size || !signers.every((s) => want.has(s)))
    throw new Error("Unexpected signer set in the SDK transaction. Launch refused.");
  const programIds = [...new Set(tx.instructions.map((i) => i.programId.toBase58()))];
  const foreign = programIds.filter((p) => !ALLOWED_PROGRAMS.has(p));
  if (foreign.length)
    throw new Error(`Unexpected program in the SDK transaction (${foreign[0]}). Launch refused.`);
  if (!programIds.includes(DBC_PROGRAM_ID))
    throw new Error("Transaction does not invoke the Meteora DBC program.");
  if (tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length > 1232)
    throw new Error("Transaction exceeds the 1232-byte limit. Launch refused.");
  return { message, signers, programIds };
}

async function simulate(
  connection: Connection,
  tx: Transaction,
  addresses: string[] = [],
  commitment: Commitment = "confirmed",
  minContextSlot?: number,
) {
  const r = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
    sigVerify: false,
    replaceRecentBlockhash: false,
    commitment,
    ...(minContextSlot === undefined ? {} : { minContextSlot }),
    ...(addresses.length ? { accounts: { encoding: "base64", addresses } } : {}),
  });
  if (r.value.err)
    throw new Error(
      `Simulation failed: ${JSON.stringify(r.value.err)}${(r.value.logs ?? []).slice(-3).join(" | ")}`,
    );
  return r.value;
}

/**
 * Only the UNSIGNED build may retry an RPC bank's unrecognized blockhash.
 * Never retry a wallet signature or send. On every attempt the exact locally
 * signed message is regenerated, checked, and simulated before review.
 */
export const BLOCKHASH_BUILD_MAX_ATTEMPTS = 3;
type ContextBlock = Awaited<ReturnType<Connection["getLatestBlockhashAndContext"]>>;

export function isTransientBuildBlockhashError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /blockhash\s+not\s+found|BlockhashNotFound|minimum context slot|MinContextSlotNotReached/i.test(
    message,
  );
}

async function withFreshBuildBlockhash<T>(
  connection: Connection,
  network: LaunchNetwork,
  commitment: Commitment,
  run: (block: ContextBlock) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= BLOCKHASH_BUILD_MAX_ATTEMPTS; attempt++) {
    // Public RPC load balancers can route each request to different banks.
    // A provider that silently switches clusters must NEVER reach wallet review.
    if (network !== "localnet" && (await connection.getGenesisHash()) !== GENESIS[network])
      throw new Error("RPC network differs from the selected network.");
    const block = await connection.getLatestBlockhashAndContext(commitment);
    try {
      return await run(block);
    } catch (e) {
      if (!isTransientBuildBlockhashError(e)) throw e;
      if (attempt === BLOCKHASH_BUILD_MAX_ATTEMPTS)
        throw new Error(
          "Simulation RPC could not recognize a recently fetched blockhash after 3 build attempts. " +
            "This can mean lagging load-balanced RPC nodes. Choose a dedicated Devnet RPC and rebuild. " +
            "No wallet signature was requested and no transaction was submitted.",
        );
    }
  }
  throw new Error("Blockhash build attempts exhausted without a simulated transaction.");
}

export type BuiltStage = {
  stage: "config" | "pool-first-buy";
  transaction: Transaction;
  reviewedMessage: Uint8Array;
  lastValidBlockHeight: number;
  config: string;
  requiredSigners: string[];
  programIds: string[];
  feeLamports: number;
  balanceLamports: number;
  simulatedUnits: number;
};
export type BuiltPoolFirstBuy = BuiltStage & {
  stage: "pool-first-buy";
  baseMint: string;
  pool: string;
  buyLamports: number;
  expectedOut: string;
  minimumOut: string;
  slippageBps: number;
  receiverAta: string;
};

/** Stage 1: config only. Signers exactly wallet + fresh config keypair. */
export async function buildFirstBuyConfig(
  connection: Connection,
  network: LaunchNetwork,
  wallet: PublicKey,
  form: LaunchForm,
  slippageBps: number,
  commitment: Commitment = "confirmed",
  deps: Deps = {},
): Promise<BuiltStage> {
  const problems = [
    ...validateLaunchForm(form, network),
    ...validateFirstBuy(form.firstBuyLamports, slippageBps, network),
  ];
  if (problems.length) throw new Error(problems[0]);
  await preflight(connection, network, commitment);
  await ensureBrowserBuffer();
  const client = deps.client ?? new DynamicBondingCurveClient(connection, commitment);
  const configKp = Keypair.generate();
  const params = curveConfig(form);
  if (params.tokenUpdateAuthority !== TokenAuthorityOption.Immutable)
    throw new Error("Unexpected token authority option in the SDK config. Launch refused.");
  const tx = await client.partner.createConfig({
    ...params,
    config: configKp.publicKey,
    feeClaimer: wallet,
    leftoverReceiver: wallet,
    quoteMint: new PublicKey(WSOL_MINT),
    payer: wallet,
  });
  return withFreshBuildBlockhash(connection, network, commitment, async (block) => {
    tx.feePayer = wallet;
    tx.recentBlockhash = block.value.blockhash;
    const { message, signers, programIds } = checkShape(tx, [
      wallet.toBase58(),
      configKp.publicKey.toBase58(),
    ]);
    // Refreshes the local config signature for this exact blockhash on EVERY attempt.
    tx.partialSign(configKp);
    const fee = (await connection.getFeeForMessage(message, commitment)).value ?? 10_000;
    const balance = await connection.getBalance(wallet, commitment);
    checkFirstBuyFunds(balance, form.firstBuyLamports, fee);
    const sim = await simulate(connection, tx, [], commitment, block.context.slot);
    return {
      stage: "config" as const,
      transaction: tx,
      reviewedMessage: new Uint8Array(tx.serializeMessage()),
      lastValidBlockHeight: block.value.lastValidBlockHeight,
      config: configKp.publicKey.toBase58(),
      requiredSigners: signers,
      programIds,
      feeLamports: fee,
      balanceLamports: balance,
      simulatedUnits: sim.unitsConsumed ?? 0,
    };
  });
}

/**
 * Stage 2: pool init + first buy in one transaction against a CONFIRMED, wallet-owned config.
 * The quote comes from simulating the exact SDK transaction (minOut=1) and reading the buyer's
 * base token account; the reviewed transaction is rebuilt with minOut after slippage and simulated again.
 */
export async function buildPoolWithFirstBuy(
  connection: Connection,
  network: LaunchNetwork,
  wallet: PublicKey,
  config: string,
  form: LaunchForm,
  slippageBps: number,
  commitment: Commitment = "confirmed",
  deps: Deps = {},
): Promise<BuiltPoolFirstBuy> {
  const problems = [
    ...validateLaunchForm(form, network),
    ...validateFirstBuy(form.firstBuyLamports, slippageBps, network),
  ];
  if (problems.length) throw new Error(problems[0]);
  await preflight(connection, network, commitment);
  const configKey = new PublicKey(config);
  const cfgAccount = await connection.getAccountInfo(configKey, commitment);
  if (!cfgAccount?.owner.equals(new PublicKey(DBC_PROGRAM_ID)))
    throw new Error("Config is not a confirmed DBC-owned account. Complete stage 1 first.");
  await ensureBrowserBuffer();
  const client = deps.client ?? new DynamicBondingCurveClient(connection, commitment);
  const cfg = await client.state.getPoolConfig(configKey);
  if (!cfg || cfg.feeClaimer.toBase58() !== wallet.toBase58())
    throw new Error("Config fee claimer is not the connected wallet. Launch refused.");
  if (cfg.quoteMint.toBase58() !== WSOL_MINT) throw new Error("Config quote mint is not SOL.");
  const mintKp = Keypair.generate();
  const receiverAta = associatedTokenAddress(mintKp.publicKey, wallet);
  const make = (minOut: BN) =>
    client.creator.createPoolWithFirstBuy({
      createPoolParam: {
        name: form.name,
        symbol: form.symbol,
        uri: form.uri,
        payer: wallet,
        poolCreator: wallet,
        config: configKey,
        baseMint: mintKp.publicKey,
      },
      firstBuyParam: {
        buyer: wallet,
        receiver: wallet,
        buyAmount: new BN(form.firstBuyLamports),
        minimumAmountOut: minOut,
        referralTokenAccount: null,
      },
    });
  const expectedSigners = [wallet.toBase58(), mintKp.publicKey.toBase58()];
  return withFreshBuildBlockhash(connection, network, commitment, async (block) => {
    // Probe and slippage-protected final transaction MUST use the same blockhash.
    // If either simulation sees a lagging bank, discard its quote and retry both.
    const probe = await make(new BN(1));
    probe.feePayer = wallet;
    probe.recentBlockhash = block.value.blockhash;
    checkShape(probe, expectedSigners);
    const probeSim = await simulate(
      connection,
      probe,
      [receiverAta.toBase58()],
      commitment,
      block.context.slot,
    );
    const acct = probeSim.accounts?.[0];
    if (!acct)
      throw new Error("Simulation did not report the buyer token account. Quote unavailable.");
    const raw = Uint8Array.from(atob((acct.data as string[])[0]!), (ch) => ch.charCodeAt(0));
    const parsed = parseTokenAccount(raw);
    if (parsed.mint !== mintKp.publicKey.toBase58() || parsed.owner !== wallet.toBase58())
      throw new Error("Simulated token account does not match mint/buyer. Launch refused.");
    const minOut = minimumOutAfterSlippage(parsed.amount, slippageBps);
    const tx = await make(new BN(minOut.toString()));
    tx.feePayer = wallet;
    tx.recentBlockhash = block.value.blockhash;
    const { message, signers, programIds } = checkShape(tx, expectedSigners);
    tx.partialSign(mintKp);
    const fee = (await connection.getFeeForMessage(message, commitment)).value ?? 10_000;
    const balance = await connection.getBalance(wallet, commitment);
    checkFirstBuyFunds(balance, form.firstBuyLamports, fee);
    const sim = await simulate(connection, tx, [], commitment, block.context.slot);
    return {
      stage: "pool-first-buy" as const,
      transaction: tx,
      reviewedMessage: new Uint8Array(tx.serializeMessage()),
      lastValidBlockHeight: block.value.lastValidBlockHeight,
      config,
      requiredSigners: signers,
      programIds,
      feeLamports: fee,
      balanceLamports: balance,
      simulatedUnits: sim.unitsConsumed ?? 0,
      baseMint: mintKp.publicKey.toBase58(),
      pool: deriveDbcPoolAddress(new PublicKey(WSOL_MINT), mintKp.publicKey, configKey).toBase58(),
      buyLamports: form.firstBuyLamports,
      expectedOut: parsed.amount.toString(),
      minimumOut: minOut.toString(),
      slippageBps,
      receiverAta: receiverAta.toBase58(),
    };
  });
}

/** Sends signed bytes exactly once (no SDK retries) and confirms against the reviewed blockhash. */
export async function sendStageOnce(
  connection: Connection,
  signed: Uint8Array,
  built: Pick<BuiltStage, "transaction" | "lastValidBlockHeight">,
  onSubmitted: (sig: TransactionSignature) => void,
  commitment: Commitment = "confirmed",
) {
  const sig = await connection.sendRawTransaction(signed, {
    skipPreflight: false,
    preflightCommitment: commitment,
    maxRetries: 0,
  });
  onSubmitted(sig);
  const res = await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: built.transaction.recentBlockhash!,
      lastValidBlockHeight: built.lastValidBlockHeight,
    },
    commitment,
  );
  if (res.value.err)
    throw new Error(`Transaction failed on chain: ${JSON.stringify(res.value.err)}`);
  return sig;
}

export async function verifyConfigCreated(connection: Connection, config: string) {
  const a = await connection.getAccountInfo(new PublicKey(config), "confirmed");
  if (!a?.owner.equals(new PublicKey(DBC_PROGRAM_ID)))
    throw new Error("Confirmed, but the config account is not owned by the DBC program.");
}

/** Proof of the buy: DBC-owned pool exists and the buyer's token account holds >= minimumOut of the new mint. */
export async function verifyFirstBuy(
  connection: Connection,
  built: Pick<BuiltPoolFirstBuy, "pool" | "baseMint" | "receiverAta" | "minimumOut">,
  wallet: PublicKey,
) {
  const [pool, ata] = await connection.getMultipleAccountsInfo(
    [new PublicKey(built.pool), new PublicKey(built.receiverAta)],
    "confirmed",
  );
  if (!pool?.owner.equals(new PublicKey(DBC_PROGRAM_ID)))
    throw new Error("Confirmed, but the pool is not owned by the DBC program.");
  if (!ata?.owner.equals(TOKEN_PROGRAM_ID))
    throw new Error("Confirmed, but the buyer token account was not found.");
  const t = parseTokenAccount(ata.data);
  if (t.mint !== built.baseMint || t.owner !== wallet.toBase58())
    throw new Error("Buyer token account does not match the launched mint and wallet.");
  if (t.amount < BigInt(built.minimumOut))
    throw new Error("Buyer token balance is below the reviewed minimum output.");
  return { amount: t.amount.toString() };
}