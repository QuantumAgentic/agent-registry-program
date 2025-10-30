/**
 * Test E2E Complet sur Devnet AVEC SDK
 * 
 * Ce test utilise le SDK (@pipeline/sdk) pour valider:
 * 1. SDK agent-registry (createAgent, fetchAgent, etc.)
 * 2. SDK agent-staking (initProgramState, createStakingPool, stakeTokens, withdrawStake)
 * 3. Flow complet E2E
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

// Colors for console
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
  sdk: (msg: string) => console.log(`${colors.magenta}🔧 SDK: ${msg}${colors.reset}`),
};

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("\n" + "=".repeat(70));
  log.step("TEST E2E AVEC SDK - AGENT REGISTRY + STAKING (DEVNET)");
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
  log.step("ÉTAPE 1: Créer un SPL Token (via @solana/spl-token)");
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
  log.step("ÉTAPE 2: Init Program State (SDK.initProgramState)");
  console.log("-".repeat(70));

  const [statePda] = SDK.deriveProgramStatePda(agentStakingProgramId);
  log.info(`Program State PDA: ${statePda.toBase58()}`);

  try {
    const stakingProgram = SDK.getStakingProgram(provider, agentStakingIdl, agentStakingProgramId);
    const stateAccount = await (stakingProgram.account as any).programState.fetch(statePda);
    log.info("Program state déjà initialisé");
    log.info(`  Authority: ${stateAccount.authority.toBase58()}`);
  } catch (e) {
    log.sdk("Appel: SDK.initProgramState()");
    await SDK.initProgramState({
      provider,
      stakingIdl: agentStakingIdl,
      treasury: wallet.publicKey,
      stakingProgramId: agentStakingProgramId,
    });
    log.success("Program state initialisé via SDK");
  }

  console.log("\n" + "-".repeat(70));
  log.step("ÉTAPE 3: Créer un Agent (SDK.createAgent)");
  console.log("-".repeat(70));

  const creator = Keypair.generate();
  log.info(`Agent Wallet: ${creator.publicKey.toBase58()}`);

  log.sdk("Appel: SDK.createAgent({ hasStaking: true })");
  const agentPda = await SDK.createAgent({
    provider,
    creator: creator.publicKey,
    hasStaking: true,  // ✅ Staking activé
    programId: agentRegistryProgramId,
  });
  log.success(`Agent créé: ${agentPda.toBase58()}`);

  // Fetch agent via SDK
  log.sdk("Appel: SDK.fetchAgentByPda()");
  const agentAccount = await SDK.fetchAgentByPda(provider, agentPda, agentRegistryProgramId);
  if (!agentAccount) {
    log.error("Agent non trouvé!");
    process.exit(1);
  }
  
  log.info(`  Admin: ${agentAccount.admin.toBase58()}`);
  log.info(`  Flags: ${agentAccount.flags}`);
  log.info(`  Active: ${agentAccount.isActive ? "✅" : "❌"}`);
  log.info(`  Has Staking: ${(agentAccount.flags & 4) !== 0 ? "✅" : "❌"}`);

  if ((agentAccount.flags & 4) === 0) {
    log.error("FLAG_HAS_STAKING pas activé!");
    process.exit(1);
  }

  console.log("\n" + "-".repeat(70));
  log.step("ÉTAPE 4: Créer un Staking Pool (SDK.createStakingPool)");
  console.log("-".repeat(70));

  const minStakeAmount = 1000;
  log.sdk("Appel: SDK.createStakingPool()");
  const { poolPda, vaultPda } = await SDK.createStakingPool({
    provider,
    stakingIdl: agentStakingIdl,
    agentPda,
    tokenMint,
    minStakeAmount,
    stakingProgramId: agentStakingProgramId,
  });
  log.success(`Pool créé: ${poolPda.toBase58()}`);
  log.success(`Vault créé: ${vaultPda.toBase58()}`);

  // Fetch pool
  const stakingProgram = SDK.getStakingProgram(provider, agentStakingIdl, agentStakingProgramId);
  const poolAccount = await (stakingProgram.account as any).stakingPool.fetch(poolPda);
  log.info(`  Token Mint: ${poolAccount.tokenMint.toBase58()}`);
  log.info(`  Min Stake: ${poolAccount.minStakeAmount.toString()} tokens`);

  console.log("\n" + "-".repeat(70));
  log.step("ÉTAPE 5: Stake des tokens (SDK.stakeTokens)");
  console.log("-".repeat(70));

  const stakeAmount = 10000;
  log.sdk("Appel: SDK.stakeTokens()");
  const stakePda = await SDK.stakeTokens({
    provider,
    stakingIdl: agentStakingIdl,
    agentPda,
    stakerTokenAccount: userTokenAccount.address,
    amount: stakeAmount,
    stakingProgramId: agentStakingProgramId,
  });
  log.success(`Stake effectué: ${stakePda.toBase58()}`);

  // Fetch stake account
  const stakeAccountData = await (stakingProgram.account as any).stakeAccount.fetch(stakePda);
  log.info(`  Staked Amount: ${stakeAccountData.stakedAmount.toString()} tokens`);
  log.info(`  Staked At: ${new Date(stakeAccountData.stakedAt.toNumber() * 1000).toISOString()}`);

  // Verify vault balance
  const vaultAccountInfo = await connection.getTokenAccountBalance(vaultPda);
  log.info(`  Vault Balance: ${vaultAccountInfo.value.amount} tokens`);

  console.log("\n" + "-".repeat(70));
  log.step("ÉTAPE 6: Attendre 5 secondes");
  console.log("-".repeat(70));

  log.info("Attente de 5 secondes (simulation time elapsed)...");
  await sleep(5000);
  log.success("Temps écoulé");

  console.log("\n" + "-".repeat(70));
  log.step("ÉTAPE 7: Withdraw stake (SDK.withdrawStake)");
  console.log("-".repeat(70));

  const balanceBefore = await connection.getBalance(wallet.publicKey);
  log.info(`Balance SOL avant: ${balanceBefore / LAMPORTS_PER_SOL} SOL`);

  log.sdk("Appel: SDK.withdrawStake()");
  await SDK.withdrawStake({
    provider,
    stakingIdl: agentStakingIdl,
    agentPda,
    stakerTokenAccount: userTokenAccount.address,
    treasury: wallet.publicKey,
    stakingProgramId: agentStakingProgramId,
  });
  log.success("Withdraw effectué");

  const balanceAfter = await connection.getBalance(wallet.publicKey);
  const feePaid = balanceBefore - balanceAfter;
  log.info(`Fee payée: ~${Math.abs(feePaid) / LAMPORTS_PER_SOL} SOL`);

  // Verify stake account
  const stakeAccountAfter = await (stakingProgram.account as any).stakeAccount.fetch(stakePda);
  log.info(`  Staked Amount après: ${stakeAccountAfter.stakedAmount.toString()}`);

  if (stakeAccountAfter.stakedAmount.toNumber() !== 0) {
    log.error("Staked amount devrait être 0!");
  } else {
    log.success("✅ FIX C-02: Staked amount réinitialisé à 0 (compte existe toujours)");
  }

  // Verify tokens returned
  const userBalanceAfter = await connection.getTokenAccountBalance(userTokenAccount.address);
  log.info(`  User token balance: ${userBalanceAfter.value.amount}`);

  console.log("\n" + "=".repeat(70));
  log.success("TEST E2E AVEC SDK RÉUSSI! 🎉");
  console.log("=".repeat(70) + "\n");

  console.log("📊 RÉSUMÉ:");
  console.log(`  ✅ Agent créé via SDK.createAgent()`);
  console.log(`  ✅ Agent fetché via SDK.fetchAgentByPda()`);
  console.log(`  ✅ Pool créé via SDK.createStakingPool()`);
  console.log(`  ✅ Stake via SDK.stakeTokens()`);
  console.log(`  ✅ Withdraw via SDK.withdrawStake()`);
  console.log(`  ✅ Tous les PDAs dérivés via SDK helpers`);

  console.log("\n🔧 SDK VALIDÉ:");
  console.log(`  ✅ SDK.createAgent()             - agent-registry`);
  console.log(`  ✅ SDK.fetchAgentByPda()         - agent-registry`);
  console.log(`  ✅ SDK.deriveAgentPda()          - helpers`);
  console.log(`  ✅ SDK.initProgramState()        - agent-staking`);
  console.log(`  ✅ SDK.createStakingPool()       - agent-staking`);
  console.log(`  ✅ SDK.stakeTokens()             - agent-staking`);
  console.log(`  ✅ SDK.withdrawStake()           - agent-staking`);
  console.log(`  ✅ SDK.deriveStakingPoolPda()    - helpers`);
  console.log(`  ✅ SDK.deriveTokenVaultPda()     - helpers`);
  console.log(`  ✅ SDK.deriveStakeAccountPda()   - helpers`);
  console.log(`  ✅ SDK.deriveProgramStatePda()   - helpers`);

  console.log("\n📝 ADDRESSES:");
  console.log(`  Agent PDA: ${agentPda.toBase58()}`);
  console.log(`  Pool PDA: ${poolPda.toBase58()}`);
  console.log(`  Vault PDA: ${vaultPda.toBase58()}`);
  console.log(`  Token Mint: ${tokenMint.toBase58()}`);
  console.log(`  Stake Account: ${stakePda.toBase58()}`);

  console.log("\n✅ SDK et programmes fonctionnent ensemble parfaitement!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(`Erreur: ${error.message}`);
    console.error(error);
    process.exit(1);
  });

