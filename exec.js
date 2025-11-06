import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

export function createExecutor({
  connection,
  wallet,
  jupBase,
  priorityFeeLamports = 50000,
  onlyDirectRoutes = false,
}) {
  async function fetchWithBackoff(url, options = {}, retries = 4) {
    let delay = 500;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetch(url, options);
      if (res.status !== 429) return res;
      const wait = Math.min(4000, delay);
      await new Promise((r) => setTimeout(r, wait));
      delay *= 2;
    }
    return await fetch(url, options);
  }

  async function getBlockhashWithRetry(retries = 4) {
    let delay = 500;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await connection.getLatestBlockhash();
      } catch (e) {
        if (String(e).includes("429")) {
          const d = Math.min(4000, delay);
          await new Promise((r) => setTimeout(r, d));
          delay *= 2;
          continue;
        }
        throw e;
      }
    }
    return await connection.getLatestBlockhash();
  }

  async function jupQuote({
    inputMint,
    outputMint,
    amountAtomic,
    slippageBps,
  }) {
    const url = `${jupBase}/swap/v1/quote?onlyDirectRoutes=${onlyDirectRoutes}&inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountAtomic}&slippageBps=${slippageBps}`;
    const res = await fetchWithBackoff(url);
    if (!res.ok) throw new Error(`Quote failed: ${res.status}`);
    return await res.json();
  }

  async function jupSwapInstructions({ quoteResponse, userPublicKey }) {
    const res = await fetchWithBackoff(`${jupBase}/swap/v1/swap-instructions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userPublicKey,
        quoteResponse,
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: priorityFeeLamports,
        dynamicComputeUnitLimit: true,
      }),
    });
    if (!res.ok) throw new Error(`swap-instructions failed: ${res.status}`);
    return await res.json();
  }

  async function executeSwap({
    inputMint,
    outputMint,
    amountAtomic,
    slippageBps,
  }) {
    if (!wallet) throw new Error("Wallet not configured");
    const quoteResponse = await jupQuote({
      inputMint,
      outputMint,
      amountAtomic,
      slippageBps,
    });
    const inst = await jupSwapInstructions({
      quoteResponse,
      userPublicKey: wallet.publicKey.toBase58(),
    });

    const { blockhash } = await getBlockhashWithRetry();
    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    for (const ix of inst.computeBudgetInstructions || []) {
      tx.add(
        new TransactionInstruction({
          programId: new PublicKey(ix.programId),
          keys: ix.accounts.map((a) => ({
            pubkey: new PublicKey(a.pubkey),
            isSigner: a.isSigner,
            isWritable: a.isWritable,
          })),
          data: Buffer.from(ix.data, "base64"),
        })
      );
    }
    for (const ix of inst.setupInstructions || []) {
      tx.add(
        new TransactionInstruction({
          programId: new PublicKey(ix.programId),
          keys: ix.accounts.map((a) => ({
            pubkey: new PublicKey(a.pubkey),
            isSigner: a.isSigner,
            isWritable: a.isWritable,
          })),
          data: Buffer.from(ix.data, "base64"),
        })
      );
    }
    tx.add(
      new TransactionInstruction({
        programId: new PublicKey(inst.swapInstruction.programId),
        keys: inst.swapInstruction.accounts.map((a) => ({
          pubkey: new PublicKey(a.pubkey),
          isSigner: a.isSigner,
          isWritable: a.isWritable,
        })),
        data: Buffer.from(inst.swapInstruction.data, "base64"),
      })
    );
    if (inst.cleanupInstruction) {
      const c = inst.cleanupInstruction;
      tx.add(
        new TransactionInstruction({
          programId: new PublicKey(c.programId),
          keys: c.accounts.map((a) => ({
            pubkey: new PublicKey(a.pubkey),
            isSigner: a.isSigner,
            isWritable: a.isWritable,
          })),
          data: Buffer.from(c.data, "base64"),
        })
      );
    }

    tx.sign(wallet);
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    const conf = await connection.confirmTransaction(
      { signature: sig, commitment: "confirmed" },
      60_000
    );
    return { signature: sig, confirmation: conf?.value };
  }

  return { executeSwap };
}
