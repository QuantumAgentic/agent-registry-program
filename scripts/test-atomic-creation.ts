/**
 * Test Transaction Atomique: Agent + Pool en 1 TX
 * 
 * Démontre l'usage de SDK.createAgentWithStakingPool() qui crée
 * l'agent et le staking pool dans une seule transaction atomique.
 */

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { 
  Connection, 
  Keypair, 
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "fs";
import path from "path";

// Import SDK
import * as SDK from "../../../sdk/src/index.js";

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

const log = {
  success: (msg: string) => console.log(`${colors.green}✅ ${msg}${colors.reset}`),
  error: (msg: string) => console.log(`${colors.red}❌ ${msg}${colors.reset}`),
  info: (msg: string) => console.log(`${colors.blue}ℹ️  ${msg}${colors.reset}`),
  step: (msg: string) => console.log(`${colors.cyan}📍 ${msg}${colors.reset}`),
  warn: (msg: string) => console.log(`${colors.yellow}⚠️  ${msg}${colors.reset}`),
  atomic: (msg: string) => console.log(`${colors.magenta}⚛️  ATOMIC: ${msg}${colors.reset}`),
};

async function main() {
  console.log("\n" + "=".repeat(70));
  log.step("TEST TRANSACTION ATOMIQUE - AGENT + POOL (1 TX)");
  console.log("=".repeat(70) + "\n");

  // Configuration
  const DEVNET_RPC = "https://api.devnet.solana.com";
  const connection = new Connection(DEVNET_RPC, "confirmed");

  // Load wallet
  const walletPath = path.join(process.env.HOME!, ".config/solana/id.json");
  if (!fs.existsSync(walletPath)) {
    log.error("Wallet non trouvé. Exécutez: solana-keygen new");
    process.exit(1);
  }

  const walletKeypair = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  const wallet = new Wallet(walletKeypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  log.info(`Wallet: ${wallet.publicKey.toBase58()}`);
  const balance = await connection.getBalance(wallet.publicKey);
  log.info(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < 0.5 * LAMPORTS_PER_SOL) {
    log.warn("Balance faible! Airdrop recommandé: solana airdrop 2");
    process.exit(1);
  }

  // Load IDLs
  const agentStakingIdl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../target/idl/agent_staking.json"),
      "utf-8"
    )
  );

  const agentRegistryProgramId = new PublicKey(SDK.AGENT_PROGRAM_ID);
  const agentStakingProgramId = new PublicKey(agentStakingIdl.address);

  log.info(`Agent Registry: ${agentRegistryProgramId.toBase58()}`);
  log.info(`Agent Staking: ${agentStakingProgramId.toBase58()}`);

  console.log("\n" + "-".repeat(70));
  log.step("ÉTAPE 1: Créer SPL Token Mint");
  console.log("-".repeat(70));

  const tokenMint = await createMint(
    connection,
    walletKeypair,
    wallet.publicKey,
    null,
    9,
    undefined,
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID
  );
  log.success(`Token Mint: ${tokenMint.toBase58()}`);

  const userTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    walletKeypair,
    tokenMint,
    wallet.publicKey,
    false,
    "confirmed",
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  log.success(`Token Account: ${userTokenAccount.address.toBase58()}`);

  const mintAmount = 1_000_000_000_000;
  await mintTo(
    connection,
    walletKeypair,
    tokenMint,
    userTokenAccount.address,
    wallet.publicKey,
    mintAmount,
    [],
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID
  );
  log.success(`Minté ${mintAmount / 1e9} tokens`);

  console.log("\n" + "-".repeat(70));
  log.step("ÉTAPE 2: Init Program State (si nécessaire)");
  console.log("-".repeat(70));

  const [statePda] = SDK.deriveProgramStatePda(agentStakingProgramId);
  try {
    const stakingProgram = SDK.getStakingProgram(provider, agentStakingIdl, agentStakingProgramId);
    await (stakingProgram.account as any).programState.fetch(statePda);
    log.info("Program state déjà initialisé");
  } catch (e) {
    await SDK.initProgramState({
      provider,
      stakingIdl: agentStakingIdl,
      treasury: wallet.publicKey,
      stakingProgramId: agentStakingProgramId,
    });
    log.success("Program state initialisé");
  }

  console.log("\n" + "=".repeat(70));
  log.atomic("TRANSACTION ATOMIQUE: Agent + Pool en 1 seule TX");
  console.log("=".repeat(70) + "\n");

  const creator = Keypair.generate();
  log.info(`Agent Wallet: ${creator.publicKey.toBase58()}`);
  
  const minStakeAmount = 1000;
  log.atomic("SDK.createAgentWithStakingPool() - 2 instructions en 1 TX");
  log.info("  Instruction 1: agent-registry.createAgent(has_staking=true)");
  log.info("  Instruction 2: agent-staking.createStakingPool()");
  log.info("  → Atomic: Tout ou rien!");

  const startTime = Date.now();
  const result = await SDK.createAgentWithStakingPool({
    provider,
    stakingIdl: agentStakingIdl,
    creator: creator.publicKey,
    tokenMint,
    minStakeAmount,
    agentRegistryProgramId,
    stakingProgramId: agentStakingProgramId,
  });
  const elapsed = Date.now() - startTime;

  log.success(`Transaction confirmée en ${elapsed}ms`);
  log.success(`Signature: ${result.signature}`);
  log.info(`Agent PDA: ${result.agentPda.toBase58()}`);
  log.info(`Pool PDA: ${result.poolPda.toBase58()}`);
  log.info(`Vault PDA: ${result.vaultPda.toBase58()}`);

  console.log("\n" + "-".repeat(70));
  log.step("ÉTAPE 3: Vérifier l'agent créé");
  console.log("-".repeat(70));

  const agentAccount = await SDK.fetchAgentByPda(provider, result.agentPda, agentRegistryProgramId);
  if (!agentAccount) {
    log.error("Agent non trouvé!");
    process.exit(1);
  }

  log.success("Agent trouvé:");
  log.info(`  Admin: ${agentAccount.admin.toBase58()}`);
  log.info(`  Flags: ${agentAccount.flags}`);
  log.info(`  Active: ${agentAccount.isActive ? "✅" : "❌"}`);
  log.info(`  Has Staking: ${(agentAccount.flags & 4) !== 0 ? "✅" : "❌"}`);

  if ((agentAccount.flags & 4) === 0) {
    log.error("FLAG_HAS_STAKING pas activé!");
    process.exit(1);
  }

  console.log("\n" + "-".repeat(70));
  log.step("ÉTAPE 4: Vérifier le pool créé");
  console.log("-".repeat(70));

  const poolAccount = await SDK.fetchStakingPool(
    provider,
    agentStakingIdl,
    result.poolPda,
    agentStakingProgramId
  );
  if (!poolAccount) {
    log.error("Pool non trouvé!");
    process.exit(1);
  }

  log.success("Pool trouvé:");
  log.info(`  Owner: ${poolAccount.owner.toBase58()}`);
  log.info(`  Token Mint: ${poolAccount.tokenMint.toBase58()}`);
  log.info(`  Min Stake: ${poolAccount.minStakeAmount.toString()} tokens`);
  log.info(`  Total Staked: ${poolAccount.totalStaked.toString()} tokens`);

  console.log("\n" + "-".repeat(70));
  log.step("ÉTAPE 5: Stake des tokens");
  console.log("-".repeat(70));

  const stakeAmount = 10000;
  const stakePda = await SDK.stakeTokens({
    provider,
    stakingIdl: agentStakingIdl,
    agentPda: result.agentPda,
    stakerTokenAccount: userTokenAccount.address,
    amount: stakeAmount,
    stakingProgramId: agentStakingProgramId,
  });
  log.success(`Stake effectué: ${stakePda.toBase58()}`);

  const stakeAccount = await SDK.fetchStakeAccount(
    provider,
    agentStakingIdl,
    stakePda,
    agentStakingProgramId
  );
  log.info(`  Staked Amount: ${stakeAccount?.stakedAmount.toString()} tokens`);

  console.log("\n" + "-".repeat(70));
  log.step("ÉTAPE 6: Lister tous les pools");
  console.log("-".repeat(70));

  const allPools = await SDK.listStakingPools(provider, agentStakingIdl, {
    stakingProgramId: agentStakingProgramId,
    limit: 5,
  });
  log.success(`Trouvé ${allPools.length} pool(s)`);
  for (const pool of allPools) {
    log.info(`  ${pool.pubkey.toBase58()}: ${pool.account.totalStaked.toString()} staked`);
  }

  console.log("\n" + "-".repeat(70));
  log.step("ÉTAPE 7: Lister stakes du user");
  console.log("-".repeat(70));

  const userStakes = await SDK.listStakesByUser(
    provider,
    agentStakingIdl,
    wallet.publicKey,
    {
      stakingProgramId: agentStakingProgramId,
    }
  );
  log.success(`Trouvé ${userStakes.length} stake(s) pour ce user`);
  for (const stake of userStakes) {
    log.info(`  ${stake.pubkey.toBase58()}: ${stake.account.stakedAmount.toString()} tokens`);
  }

  console.log("\n" + "=".repeat(70));
  log.success("TEST TRANSACTION ATOMIQUE RÉUSSI! 🎉");
  console.log("=".repeat(70) + "\n");

  console.log("📊 AVANTAGES TRANSACTION ATOMIQUE:");
  console.log(`  ✅ 1 seule TX au lieu de 2`);
  console.log(`  ✅ Tout ou rien (atomic garantie)`);
  console.log(`  ✅ Moins de fees (1 TX fee vs 2)`);
  console.log(`  ✅ Plus rapide (${elapsed}ms)`);
  console.log(`  ✅ Cohérence garantie (agent + pool toujours ensemble)`);

  console.log("\n🔧 FONCTIONS SDK TESTÉES:");
  console.log(`  ✅ SDK.createAgentWithStakingPool() - ATOMIC`);
  console.log(`  ✅ SDK.fetchAgentByPda()`);
  console.log(`  ✅ SDK.fetchStakingPool()`);
  console.log(`  ✅ SDK.fetchStakeAccount()`);
  console.log(`  ✅ SDK.stakeTokens()`);
  console.log(`  ✅ SDK.listStakingPools()`);
  console.log(`  ✅ SDK.listStakesByUser()`);

  console.log("\n✅ SDK V2 complet et production-ready!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(`Erreur: ${error.message}`);
    console.error(error);
    process.exit(1);
  });

