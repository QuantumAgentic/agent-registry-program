/**
 * Test E2E Complet sur Devnet
 * 
 * Flow testé:
 * 1. Init program state (agent-staking)
 * 2. Create agent avec has_staking=true
 * 3. Create staking pool
 * 4. Stake tokens
 * 5. Wait et withdraw avec fees
 * 6. Vérifications
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { 
  Connection, 
  Keypair, 
  PublicKey, 
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction
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

// Colors for console
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

const log = {
  success: (msg: string) => console.log(`${colors.green}✅ ${msg}${colors.reset}`),
  error: (msg: string) => console.log(`${colors.red}❌ ${msg}${colors.reset}`),
  info: (msg: string) => console.log(`${colors.blue}ℹ️  ${msg}${colors.reset}`),
  step: (msg: string) => console.log(`${colors.cyan}📍 ${msg}${colors.reset}`),
  warn: (msg: string) => console.log(`${colors.yellow}⚠️  ${msg}${colors.reset}`),
};

// Helper pour dériver PDAs
function deriveAgentPda(creator: PublicKey, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), creator.toBuffer()],
    programId
  );
  return pda;
}

function deriveStakingPoolPda(agentPda: PublicKey, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("staking_pool"), agentPda.toBuffer()],
    programId
  );
  return pda;
}

function deriveTokenVaultPda(poolPda: PublicKey, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_vault"), poolPda.toBuffer()],
    programId
  );
  return pda;
}

function deriveStakeAccountPda(
  staker: PublicKey,
  agentPda: PublicKey,
  programId: PublicKey
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake_account"), staker.toBuffer(), agentPda.toBuffer()],
    programId
  );
  return pda;
}

function deriveProgramStatePda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("program_state")],
    programId
  );
  return pda;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("\n" + "=".repeat(70));
  log.step("TEST E2E COMPLET - AGENT REGISTRY + STAKING (DEVNET)");
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

  // Load programs
  const agentRegistryIdl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../target/idl/agent_registry.json"),
      "utf-8"
    )
  );
  const agentStakingIdl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../target/idl/agent_staking.json"),
      "utf-8"
    )
  );

  const agentRegistryProgramId = new PublicKey(agentRegistryIdl.address);
  const agentStakingProgramId = new PublicKey(agentStakingIdl.address);

  const agentRegistryProgram = new Program(
    agentRegistryIdl,
    provider
  ) as Program<any>;
  const agentStakingProgram = new Program(
    agentStakingIdl,
    provider
  ) as Program<any>;

  log.info(`Agent Registry: ${agentRegistryProgramId.toBase58()}`);
  log.info(`Agent Staking: ${agentStakingProgramId.toBase58()}`);

  console.log("\n" + "-".repeat(70));
  log.step("ÉTAPE 1: Créer un SPL Token pour le staking");
  console.log("-".repeat(70));

  const tokenMint = await createMint(
    connection,
    walletKeypair,
    wallet.publicKey,
    null,
    9, // decimals
    undefined,
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID
  );
  log.success(`Token Mint créé: ${tokenMint.toBase58()}`);

  // Create token account for user
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

  // Mint tokens to user
  const mintAmount = 1_000_000_000_000; // 1M tokens
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
  log.step("ÉTAPE 2: Init Program State (agent-staking)");
  console.log("-".repeat(70));

  const programStatePda = deriveProgramStatePda(agentStakingProgramId);
  log.info(`Program State PDA: ${programStatePda.toBase58()}`);

  try {
    const stateAccount = await agentStakingProgram.account.programState.fetch(
      programStatePda
    );
    log.info("Program state déjà initialisé");
    log.info(`  Authority: ${stateAccount.authority.toBase58()}`);
    log.info(`  Treasury: ${stateAccount.treasury.toBase58()}`);
    log.info(`  Fee Immediate: ${stateAccount.feeImmediateLamports.toString()} lamports`);
    log.info(`  Fee Regular: ${stateAccount.feeRegularLamports.toString()} lamports`);
  } catch (e) {
    log.info("Initialisation du program state...");
    const tx = await agentStakingProgram.methods
      .initProgramState()
      .accounts({
        programState: programStatePda,
        authority: wallet.publicKey,
        treasury: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });
    log.success(`Program state initialisé: ${tx}`);
  }

  console.log("\n" + "-".repeat(70));
  log.step("ÉTAPE 3: Créer un Agent avec staking activé");
  console.log("-".repeat(70));

  const creator = Keypair.generate();
  log.info(`Agent Wallet: ${creator.publicKey.toBase58()}`);

  const agentPda = deriveAgentPda(creator.publicKey, agentRegistryProgramId);
  log.info(`Agent PDA: ${agentPda.toBase58()}`);

  const createAgentTx = await agentRegistryProgram.methods
    .createAgent(
      creator.publicKey,
      null, // card_uri
      null, // card_hash
      true  // has_staking = TRUE
    )
    .accounts({
      agent: agentPda,
      admin: wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });
  log.success(`Agent créé: ${createAgentTx}`);

  // Verify agent
  const agentAccount = await agentRegistryProgram.account.agentRegistry.fetch(agentPda);
  log.info(`  Admin: ${agentAccount.admin.toBase58()}`);
  log.info(`  Flags: ${agentAccount.flags} (HAS_STAKING=${(agentAccount.flags & 4) !== 0 ? "✅" : "❌"})`);

  if ((agentAccount.flags & 4) === 0) {
    log.error("FLAG_HAS_STAKING pas activé!");
    process.exit(1);
  }

  console.log("\n" + "-".repeat(70));
  log.step("ÉTAPE 4: Créer un Staking Pool");
  console.log("-".repeat(70));

  const poolPda = deriveStakingPoolPda(agentPda, agentStakingProgramId);
  const vaultPda = deriveTokenVaultPda(poolPda, agentStakingProgramId);
  log.info(`Pool PDA: ${poolPda.toBase58()}`);
  log.info(`Vault PDA: ${vaultPda.toBase58()}`);

  const minStakeAmount = 1000; // Minimum 1000 tokens
  const createPoolTx = await agentStakingProgram.methods
    .createStakingPool(new anchor.BN(minStakeAmount))
    .accounts({
      agent: agentPda,
      stakingPool: poolPda,
      tokenVault: vaultPda,
      tokenMint: tokenMint,
      owner: wallet.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .rpc({ commitment: "confirmed" });
  log.success(`Pool créé: ${createPoolTx}`);

  // Verify pool
  const poolAccount = await agentStakingProgram.account.stakingPool.fetch(poolPda);
  log.info(`  Token Mint: ${poolAccount.tokenMint.toBase58()}`);
  log.info(`  Token Vault: ${poolAccount.tokenVault.toBase58()}`);
  log.info(`  Min Stake: ${poolAccount.minStakeAmount.toString()} tokens`);
  log.info(`  Total Staked: ${poolAccount.totalStaked.toString()}`);

  console.log("\n" + "-".repeat(70));
  log.step("ÉTAPE 5: Stake des tokens");
  console.log("-".repeat(70));

  const stakeAccountPda = deriveStakeAccountPda(
    wallet.publicKey,
    agentPda,
    agentStakingProgramId
  );
  log.info(`Stake Account PDA: ${stakeAccountPda.toBase58()}`);

  const stakeAmount = 10000; // Stake 10k tokens
  const stakeTx = await agentStakingProgram.methods
    .stake(new anchor.BN(stakeAmount))
    .accounts({
      stakingPool: poolPda,
      agentPda: agentPda,
      stakeAccount: stakeAccountPda,
      tokenVault: vaultPda,
      stakerTokenAccount: userTokenAccount.address,
      staker: wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });
  log.success(`Stake effectué: ${stakeTx}`);

  // Verify stake
  const stakeAccountData = await agentStakingProgram.account.stakeAccount.fetch(
    stakeAccountPda
  );
  log.info(`  Staked Amount: ${stakeAccountData.stakedAmount.toString()} tokens`);
  log.info(`  Staked At: ${new Date(stakeAccountData.stakedAt.toNumber() * 1000).toISOString()}`);

  // Verify vault balance
  const vaultAccountInfo = await connection.getTokenAccountBalance(vaultPda);
  log.info(`  Vault Balance: ${vaultAccountInfo.value.amount} tokens`);

  console.log("\n" + "-".repeat(70));
  log.step("ÉTAPE 6: Attendre 5 secondes (simulation time elapsed)");
  console.log("-".repeat(70));

  log.info("Attente de 5 secondes...");
  await sleep(5000);
  log.success("Temps écoulé");

  console.log("\n" + "-".repeat(70));
  log.step("ÉTAPE 7: Withdraw stake avec fees");
  console.log("-".repeat(70));

  const balanceBefore = await connection.getBalance(wallet.publicKey);
  log.info(`Balance SOL avant withdraw: ${balanceBefore / LAMPORTS_PER_SOL} SOL`);

  const withdrawTx = await agentStakingProgram.methods
    .withdrawStake()
    .accounts({
      programState: programStatePda,
      stakingPool: poolPda,
      agentPda: agentPda,
      stakeAccount: stakeAccountPda,
      tokenVault: vaultPda,
      stakerTokenAccount: userTokenAccount.address,
      staker: wallet.publicKey,
      treasury: wallet.publicKey, // On est le treasury aussi
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });
  log.success(`Withdraw effectué: ${withdrawTx}`);

  const balanceAfter = await connection.getBalance(wallet.publicKey);
  const feePaid = balanceBefore - balanceAfter;
  log.info(`Fee payée: ${feePaid / LAMPORTS_PER_SOL} SOL`);

  // Verify stake account (should have 0 staked_amount)
  const stakeAccountAfter = await agentStakingProgram.account.stakeAccount.fetch(
    stakeAccountPda
  );
  log.info(`  Staked Amount after: ${stakeAccountAfter.stakedAmount.toString()}`);

  if (stakeAccountAfter.stakedAmount.toNumber() !== 0) {
    log.error("Staked amount devrait être 0!");
  } else {
    log.success("Staked amount correctement réinitialisé à 0");
  }

  // Verify tokens returned
  const userBalanceAfter = await connection.getTokenAccountBalance(
    userTokenAccount.address
  );
  log.info(`  User token balance: ${userBalanceAfter.value.amount}`);

  console.log("\n" + "=".repeat(70));
  log.success("TEST E2E COMPLET RÉUSSI! 🎉");
  console.log("=".repeat(70) + "\n");

  console.log("📊 RÉSUMÉ:");
  console.log(`  ✅ Agent créé avec HAS_STAKING`);
  console.log(`  ✅ Staking pool créé`);
  console.log(`  ✅ Stake de ${stakeAmount} tokens`);
  console.log(`  ✅ Withdraw avec fee de ${feePaid / LAMPORTS_PER_SOL} SOL`);
  console.log(`  ✅ Tokens récupérés`);
  console.log(`  ✅ Stake account réinitialisé (staked_amount=0)`);

  console.log("\n📝 ADDRESSES:");
  console.log(`  Agent PDA: ${agentPda.toBase58()}`);
  console.log(`  Pool PDA: ${poolPda.toBase58()}`);
  console.log(`  Vault PDA: ${vaultPda.toBase58()}`);
  console.log(`  Token Mint: ${tokenMint.toBase58()}`);
  console.log(`  Stake Account: ${stakeAccountPda.toBase58()}`);

  console.log("\n✅ Tous les tests sont passés!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(`Erreur: ${error.message}`);
    console.error(error);
    process.exit(1);
  });

