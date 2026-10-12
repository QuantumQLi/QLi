/****
 * REVIEW ONLY. This is Lovable source snapshot 1293a24ca514bb49c0d86fcdcdfcf9a352316856 with the blockhash fix.
 * GitHub main is not synchronized. DO NOT merge/copy to production until dependency sources
 * have been synced and tests have run against complete Lovable application.
 */
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { readFileSync } from "node:fs";
import {
  buildFirstBuyConfig,
  buildPoolWithFirstBuy,
  checkFirstBuyFunds,
  minimumOutAfterSlippage,
  parseTokenAccount,
  sendStageOnce,
  validateFirstBuy,
  verifyFirstBuy,
} from "@/lib/qli-core/dbc-first-buy";
import { buildLaunch, validateLaunchForm, type LaunchForm } from "@/lib/qli-core/dbc-launch";
import { draftToForm, SUPPORTED_PATCH } from "@/lib/qli-core/launch-mapping";
import { initialLaunch } from "@/lib/qli-core/launch-draft";
import { signReviewedTransaction } from "@/lib/qli-core/wallet";
import { DBC_PROGRAM_ID } from "@/lib/qli-core/dbc";

afterEach(() => vi.restoreAllMocks());
const DBC = new PublicKey(DBC_PROGRAM_ID);
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const form: LaunchForm = {
  name: "QLi Test",
  symbol: "QLIT",
  uri: "https://example.com/m.json",
  decimals: 6,
  totalSupply: 1_000_000_000,
  initialMarketCap: 30,
  migrationMarketCap: 300,
  feeBps: 100,
  firstBuyLamports: 200_000_000,
};
const payer = Keypair.fromSeed(new Uint8Array(32).fill(9));

function tokenData(mint: PublicKey, owner: PublicKey, amount: bigint) {
  const d = new Uint8Array(165);
  d.set(mint.toBytes(), 0);
  d.set(owner.toBytes(), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return d;
}

function mocks(opts: { genesis?: string; balance?: number; out?: bigint; foreign?: boolean } = {}) {
  const conn = new Connection("http://localhost:8899", "confirmed");
  let mint: PublicKey | null = null;
  let ata: PublicKey | null = null;
  const minOuts: string[] = [];
  vi.spyOn(conn, "getGenesisHash").mockResolvedValue(opts.genesis ?? DEVNET);
  vi.spyOn(conn, "getAccountInfo").mockImplementation(async (k: PublicKey) =>
    k.equals(DBC)
      ? { executable: true, owner: SystemProgram.programId, lamports: 1, data: Buffer.alloc(0) }
      : { executable: false, owner: DBC, lamports: 1, data: Buffer.alloc(0) },
  );
  vi.spyOn(conn, "getLatestBlockhashAndContext").mockResolvedValue({
    context: { slot: 1 },
    value: { blockhash: SystemProgram.programId.toBase58(), lastValidBlockHeight: 100 },
  });
  vi.spyOn(conn, "getFeeForMessage").mockResolvedValue({ context: { slot: 1 }, value: 10_000 });
  vi.spyOn(conn, "getBalance").mockResolvedValue(opts.balance ?? 5_000_000_000);
  const sim = vi.spyOn(conn, "simulateTransaction").mockImplementation((async (
    _tx: unknown,
    cfg?: { accounts?: { addresses: string[] } },
  ) => ({
    context: { slot: 1 },
    value: {
      err: null,
      logs: [],
      unitsConsumed: 1000,
      accounts: cfg?.accounts
        ? [
            {
              data: [
                Buffer.from(tokenData(mint!, payer.publicKey, opts.out ?? 1_000_000n)).toString(
                  "base64",
                ),
                "base64",
              ],
              executable: false,
              lamports: 1,
              owner: TOKEN.toBase58(),
            },
          ]
        : null,
    },
  })) as never);
  const ix = (signers: PublicKey[]) =>
    new TransactionInstruction({
      programId: opts.foreign ? Keypair.generate().publicKey : DBC,
      keys: signers.map((s) => ({ pubkey: s, isSigner: true, isWritable: true })),
      data: Buffer.alloc(1),
    });
  const client = {
    partner: {
      createConfig: async (p: { config: PublicKey; payer: PublicKey }) =>
        new Transaction().add(ix([p.payer, p.config])),
    },
    creator: {
      createPoolWithFirstBuy: async (p: {
        createPoolParam: { baseMint: PublicKey; payer: PublicKey };
        firstBuyParam: { minimumAmountOut: { toString(): string } };
      }) => {
        mint = p.createPoolParam.baseMint;
        minOuts.push(p.firstBuyParam.minimumAmountOut.toString());
        return new Transaction().add(ix([p.createPoolParam.payer, mint]));
      },
    },
    state: {
      getPoolConfig: async () => ({ feeClaimer: payer.publicKey, quoteMint: WSOL }),
    },
  } as never;
  return { conn, client, minOuts, sim, getAta: () => ata, setAta: (a: PublicKey) => (ata = a) };
}

describe("first buy validation", () => {
  it("accepts 0.2 SOL on Devnet and refuses it on Mainnet", () => {
    expect(validateFirstBuy(200_000_000, 100, "devnet")).toEqual([]);
    expect(validateFirstBuy(200_000_000, 100, "mainnet-beta").join()).toMatch(/Devnet-only/);
    expect(validateLaunchForm(form, "devnet")).toEqual([]);
    expect(validateLaunchForm(form, "mainnet-beta").join()).toMatch(/Devnet-only/);
  });
  it("bounds input and slippage", () => {
    expect(validateFirstBuy(0, 100, "devnet").length).toBe(1);
    expect(validateFirstBuy(600_000_000, 100, "devnet").join()).toMatch(/0.5 SOL/);
    expect(validateFirstBuy(200_000_000, 0, "devnet").join()).toMatch(/slippage/);
    expect(validateFirstBuy(200_000_000, 501, "devnet").join()).toMatch(/slippage/);
  });
  it("first buy 0 keeps the single-transaction standard launch; >0 is refused there", async () => {
    expect(validateLaunchForm({ ...form, firstBuyLamports: 0 }, "mainnet-beta")).toEqual([]);
    await expect(
      buildLaunch(new Connection("http://localhost:1"), "devnet", payer.publicKey, form),
    ).rejects.toThrow(/two-stage/);
  });
  it("maps the creator 0.2 SOL first buy exactly; partner+creator is unsupported", () => {
    const ok = {
      ...initialLaunch,
      ...SUPPORTED_PATCH,
      endingBps: initialLaunch.startingBps,
      firstBuy: "creator" as const,
      firstBuyAmount: 0.2,
    };
    expect(draftToForm(ok).unsupported).toEqual([]);
    expect(draftToForm(ok).form.firstBuyLamports).toBe(200_000_000);
    expect(draftToForm({ ...ok, firstBuy: "partner-and-creator" }).unsupported.join()).toMatch(
      /Partner/,
    );
  });
  it("metadata URI must be https", () => {
    expect(validateLaunchForm({ ...form, uri: "" }, "devnet").join()).toMatch(/https URL/);
    expect(validateLaunchForm({ ...form, uri: "http://x/y.json" }, "devnet").join()).toMatch(
      /https/,
    );
  });
  it("slippage math is integer-safe and refuses zero", () => {
    expect(minimumOutAfterSlippage(1_000_000n, 100)).toBe(990_000n);
    expect(() => minimumOutAfterSlippage(0n, 100)).toThrow(/zero/);
    expect(() => minimumOutAfterSlippage(1n, 100)).toThrow(/zero/);
  });
  it("insufficient funds is refused before any wallet call", () => {
    expect(() => checkFirstBuyFunds(100_000_000, 200_000_000, 10_000)).toThrow(/Insufficient/);
    expect(() => checkFirstBuyFunds(5e9, 200_000_000, 10_000)).not.toThrow();
  });
});

describe("two-stage builders", () => {
  it("stage 1 builds a config with exactly wallet + config signers", async () => {
    const m = mocks();
    const b = await buildFirstBuyConfig(m.conn, "devnet", payer.publicKey, form, 100, "confirmed", {
      client: m.client,
    });
    expect(b.stage).toBe("config");
    expect(b.requiredSigners).toContain(payer.publicKey.toBase58());
    expect(b.requiredSigners).toHaveLength(2);
  });
  it("stage 2 quotes by simulation and rebuilds with minOut after slippage", async () => {
    const m = mocks({ out: 2_000_000n });
    const cfg = Keypair.generate().publicKey.toBase58();
    const b = await buildPoolWithFirstBuy(
      m.conn,
      "devnet",
      payer.publicKey,
      cfg,
      form,
      100,
      "confirmed",
      { client: m.client },
    );
    expect(m.minOuts).toEqual(["1", "1980000"]);
    expect(b.minimumOut).toBe("1980000");
    expect(b.expectedOut).toBe("2000000");
    expect(b.buyLamports).toBe(200_000_000);
    expect(b.requiredSigners).toHaveLength(2);
  });
  it("wrong genesis, mainnet, foreign program and low balance fail closed", async () => {
    await expect(
      buildFirstBuyConfig(
        mocks({ genesis: "x" }).conn,
        "devnet",
        payer.publicKey,
        form,
        100,
        "confirmed",
        {
          client: mocks().client,
        },
      ),
    ).rejects.toThrow(/differs/);
    const m = mocks();
    await expect(
      buildFirstBuyConfig(m.conn, "mainnet-beta", payer.publicKey, form, 100, "confirmed", {
        client: m.client,
      }),
    ).rejects.toThrow(/Devnet-only/);
    const f = mocks({ foreign: true });
    await expect(
      buildFirstBuyConfig(f.conn, "devnet", payer.publicKey, form, 100, "confirmed", {
        client: f.client,
      }),
    ).rejects.toThrow(/Unexpected program/);
    const poor = mocks({ balance: 100_000_000 });
    await expect(
      buildFirstBuyConfig(poor.conn, "devnet", payer.publicKey, form, 100, "confirmed", {
        client: poor.client,
      }),
    ).rejects.toThrow(/Insufficient/);
  });
  it("stage 2 refuses a missing/non-DBC config (stage 1 not confirmed)", async () => {
    const m = mocks();
    vi.spyOn(m.conn, "getAccountInfo").mockImplementation(async (k: PublicKey) =>
      k.equals(DBC)
        ? { executable: true, owner: SystemProgram.programId, lamports: 1, data: Buffer.alloc(0) }
        : null,
    );
    await expect(
      buildPoolWithFirstBuy(
        m.conn,
        "devnet",
        payer.publicKey,
        Keypair.generate().publicKey.toBase58(),
        form,
        100,
        "confirmed",
        { client: m.client },
      ),
    ).rejects.toThrow(/stage 1/);
  });
});

describe("send, proof and signatures", () => {
  it("sends once with no RPC retries and reports on-chain failure (partial failure surfaced)", async () => {
    const conn = new Connection("http://localhost:8899");
    const send = vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sig1");
    vi.spyOn(conn, "confirmTransaction").mockResolvedValue({
      context: { slot: 1 },
      value: { err: { InstructionError: [1, { Custom: 6013 }] } },
    });
    const tx = new Transaction({ recentBlockhash: SystemProgram.programId.toBase58() });
    await expect(
      sendStageOnce(
        conn,
        new Uint8Array(1),
        { transaction: tx, lastValidBlockHeight: 1 },
        () => {},
      ),
    ).rejects.toThrow(/failed on chain/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toMatchObject({ maxRetries: 0 });
  });
  it("buy proof requires DBC pool + matching token account >= minimum; SOL transfer is not proof", async () => {
    const mint = Keypair.generate().publicKey;
    const ata = Keypair.generate().publicKey;
    const pool = Keypair.generate().publicKey;
    const built = {
      pool: pool.toBase58(),
      baseMint: mint.toBase58(),
      receiverAta: ata.toBase58(),
      minimumOut: "100",
    };
    const conn = new Connection("http://localhost:8899");
    const set = (poolOwner: PublicKey, data: Uint8Array | null) =>
      vi
        .spyOn(conn, "getMultipleAccountsInfo")
        .mockResolvedValueOnce([
          { owner: poolOwner, data: Buffer.alloc(0), lamports: 1, executable: false },
          data && { owner: TOKEN, data: Buffer.from(data), lamports: 1, executable: false },
        ]);
    set(DBC, tokenData(mint, payer.publicKey, 150n));
    await expect(verifyFirstBuy(conn, built, payer.publicKey)).resolves.toEqual({ amount: "150" });
    set(SystemProgram.programId, null);
    await expect(verifyFirstBuy(conn, built, payer.publicKey)).rejects.toThrow(/DBC/);
    set(DBC, tokenData(mint, payer.publicKey, 99n));
    await expect(verifyFirstBuy(conn, built, payer.publicKey)).rejects.toThrow(/minimum/);
    set(DBC, tokenData(Keypair.generate().publicKey, payer.publicKey, 500n));
    await expect(verifyFirstBuy(conn, built, payer.publicKey)).rejects.toThrow(/match/);
    expect(parseTokenAccount(tokenData(mint, payer.publicKey, 7n)).amount).toBe(7n);
  });
  it("rejected, altered and wrong-genesis wallet signing never sends", async () => {
    const mintKp = Keypair.generate();
    const tx = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: SystemProgram.programId.toBase58(),
    }).add(
      new TransactionInstruction({
        programId: DBC,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: mintKp.publicKey, isSigner: true, isWritable: true },
        ],
        data: Buffer.alloc(1),
      }),
    );
    tx.partialSign(mintKp);
    const account: WalletAccount = {
      address: payer.publicKey.toBase58(),
      publicKey: payer.publicKey.toBytes(),
      chains: ["solana:devnet"],
      features: ["solana:signTransaction"],
    };
    const run = async (mode: "reject" | "drop-mint", genesis = DEVNET) => {
      const conn = new Connection("http://localhost:8899");
      vi.spyOn(conn, "getGenesisHash").mockResolvedValue(genesis);
      vi.spyOn(conn, "getBlockHeight").mockResolvedValue(10);
      vi.spyOn(conn, "isBlockhashValid").mockResolvedValue({ context: { slot: 1 }, value: true });
      vi.spyOn(conn, "simulateTransaction").mockResolvedValue({
        context: { slot: 1 },
        value: { err: null, logs: [], accounts: null, unitsConsumed: 1 },
      });
      const send = vi.spyOn(conn, "sendRawTransaction");
      const wallet = {
        version: "1.0.0",
        name: "Mock",
        icon: "data:image/svg+xml;base64,",
        chains: ["solana:devnet"],
        accounts: [account],
        features: {
          "solana:signTransaction": {
            version: "1.0.0",
            supportedTransactionVersions: ["legacy"],
            signTransaction: async ({ transaction }: { transaction: Uint8Array }) => {
              if (mode === "reject") throw new Error("User rejected the request.");
              const t = Transaction.from(transaction);
              t.partialSign(payer);
              t.signatures.find((s) => s.publicKey.equals(mintKp.publicKey))!.signature =
                Buffer.alloc(64, 1);
              return [
                {
                  signedTransaction: new Uint8Array(
                    t.serialize({ requireAllSignatures: false, verifySignatures: false }),
                  ),
                },
              ];
            },
          },
        },
      } as unknown as Wallet;
      await expect(
        signReviewedTransaction({
          wallet,
          account,
          connection: conn,
          transaction: tx,
          lastValidBlockHeight: 100,
          network: "devnet",
          reviewedMessage: new Uint8Array(tx.serializeMessage()),
        }),
      ).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
    };
    await run("reject");
    await run("drop-mint");
    await run("drop-mint", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
  });
  it("UI guards: one send per review, disconnect blocks build, review discarded on change, mainnet blocked", () => {
    const src = readFileSync("src/components/qli-core/launch-first-buy.tsx", "utf8");
    expect(src).toMatch(/setBuilt\(null\); \/\/ a reviewed transaction can be sent once only/);
    expect(src).toMatch(/if \(inFlight\.current \|\| !c\.account/);
    expect(src).toMatch(/builtFp !== fpRef\.current/);
    expect(src).toMatch(/First buy is Devnet-only/);
    expect(src).not.toMatch(/localStorage|sessionStorage\.setItem\([^)]*secret/);
    const launch = readFileSync("src/components/qli-core/launch.tsx", "utf8");
    expect(launch).toMatch(/Preview plan — DEMO/);
  });
});


describe("blockhash consistency and bounded build-only retries", () => {
  it("refreshes a lagging RPC blockhash and re-signs only the local config keypair", async () => {
    const m = mocks();
    const b1 = Keypair.generate().publicKey.toBase58();
    const b2 = Keypair.generate().publicKey.toBase58();
    const recent = vi.spyOn(m.conn, "getLatestBlockhashAndContext");
    recent.mockReset();
    recent
      .mockResolvedValueOnce({
        context: { slot: 10 },
        value: { blockhash: b1, lastValidBlockHeight: 150 },
      })
      .mockResolvedValueOnce({
        context: { slot: 11 },
        value: { blockhash: b2, lastValidBlockHeight: 151 },
      });
    m.sim.mockRejectedValueOnce(new Error("Transaction simulation failed: Blockhash not found"));
    const send = vi.spyOn(m.conn, "sendRawTransaction");
    const built = await buildFirstBuyConfig(m.conn, "devnet", payer.publicKey, form, 100, "confirmed", {
      client: m.client,
    });
    expect(recent).toHaveBeenCalledTimes(2);
    expect(m.sim).toHaveBeenCalledTimes(2);
    expect(built.transaction.recentBlockhash).toBe(b2);
    expect(built.lastValidBlockHeight).toBe(151);
    expect(built.reviewedMessage).toEqual(new Uint8Array(built.transaction.serializeMessage()));
    expect(built.transaction.verifySignatures(false)).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not retry unrelated simulation failures, and never sends on exhausted attempts", async () => {
    const invalid = mocks();
    invalid.sim.mockRejectedValueOnce(new Error("Simulation failed: custom program error: 0x177d"));
    await expect(buildFirstBuyConfig(
      invalid.conn, "devnet", payer.publicKey, form, 100, "confirmed", { client: invalid.client },
    )).rejects.toThrow(/0x177d/);
    expect(invalid.conn.getLatestBlockhashAndContext).toHaveBeenCalledTimes(1);

    const lagging = mocks();
    lagging.sim.mockRejectedValue(new Error("Blockhash not found"));
    const send = vi.spyOn(lagging.conn, "sendRawTransaction");
    await expect(buildFirstBuyConfig(
      lagging.conn, "devnet", payer.publicKey, form, 100, "confirmed", { client: lagging.client },
    )).rejects.toThrow(/after 3 build attempts/);
    expect(lagging.conn.getLatestBlockhashAndContext).toHaveBeenCalledTimes(3);
    expect(send).not.toHaveBeenCalled();
  });

  it("retries Stage 2 quote and final simulation together, never reuses a failed quote", async () => {
    const m = mocks({ out: 2_000_000n });
    m.sim.mockRejectedValueOnce(new Error("BlockhashNotFound"));
    const built = await buildPoolWithFirstBuy(
      m.conn, "devnet", payer.publicKey, Keypair.generate().publicKey.toBase58(),
      form, 100, "confirmed", { client: m.client },
    );
    expect(m.minOuts).toEqual(["1", "1", "1980000"]);
    expect(m.sim).toHaveBeenCalledTimes(3);
    expect(built.minimumOut).toBe("1980000");
    expect(built.reviewedMessage).toEqual(new Uint8Array(built.transaction.serializeMessage()));
  });
});

describe("ATA derivation parity", () => {
  it("matches @solana/spl-token", async () => {
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const { associatedTokenAddress } = await import("@/lib/qli-core/dbc-first-buy");
    const m = Keypair.generate().publicKey;
    expect(associatedTokenAddress(m, payer.publicKey).toBase58()).toBe(
      getAssociatedTokenAddressSync(m, payer.publicKey).toBase58(),
    );
  });
});