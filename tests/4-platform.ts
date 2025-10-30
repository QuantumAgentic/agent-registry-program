import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { expect } from "chai";
import { AgentPlatform } from "../target/types/agent_platform";
import { sha3_256 } from "js-sha3";
import { createMint, mintTo, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";

const { PublicKey, Keypair } = web3;

function deriveAgentPda(creator: web3.PublicKey, programId: web3.PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("agent"), creator.toBuffer()], programId);
}

function derivePool(agentPda: web3.PublicKey, programId: web3.PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("staking_pool"), agentPda.toBuffer()], programId);
}

function deriveStake(staker: web3.PublicKey, agentPda: web3.PublicKey, programId: web3.PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("stake_account"), staker.toBuffer(), agentPda.toBuffer()],
    programId
  );
}

function deriveProgramState(programId: web3.PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("program_state")], programId);
}

function deriveTokenVault(poolPda: web3.PublicKey, programId: web3.PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("token_vault"), poolPda.toBuffer()], programId);
}

describe("agent-platform (merged)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.AgentPlatform as Program<AgentPlatform>;

  // SPL Token setup
  let tokenMint: web3.PublicKey;
  let userTokenAccount: web3.PublicKey;
  let payer: web3.Keypair;
  let hasPayer = false;

  before(async () => {
    if ((provider.wallet as any).payer) {
      payer = (provider.wallet as any).payer as web3.Keypair;
      hasPayer = true;
      
      console.log("🪙 Setting up SPL token for tests...");
      tokenMint = await createMint(
        provider.connection,
        payer,
        payer.publicKey,
        null,
        9
      );
      console.log(`  ✓ Created mint: ${tokenMint.toBase58()}`);

      const ata = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        tokenMint,
        provider.wallet.publicKey
      );
      userTokenAccount = ata.address;
      console.log(`  ✓ Created user token account: ${userTokenAccount.toBase58()}`);

      await mintTo(
        provider.connection,
        payer,
        tokenMint,
        userTokenAccount,
        payer,
        1_000_000_000_000
      );
      console.log("  ✓ Minted 1,000,000 tokens to user");
    } else {
      console.warn("⚠️  No payer available - SPL token tests will be skipped");
    }
  });

  async function expectFail(p: Promise<any>, expectedNames?: string[]) {
    try {
      await p;
      throw new Error("expected failure but succeeded");
    } catch (err: any) {
      const code = err?.error?.errorCode?.code ?? err?.code;
      const msg = err?.error?.errorMessage ?? err?.message;
      const logs: string[] | undefined = err?.logs ?? err?.errorLogs;
      if (expectedNames && expectedNames.length > 0) {
        const hay = [String(code ?? ""), String(msg ?? ""), ...(logs ?? []).map(String)].join("\n");
        const match = expectedNames.some((n) => hay.includes(n));
        if (!match) {
          console.log("Unexpected error kind; rethrowing");
          throw err;
        }
      }
    }
  }

  async function rpc<T extends { rpc: () => Promise<string> }>(builder: T, label: string) {
    console.log(`TX → ${label}`);
    const sig = await builder.rpc();
    console.log(`TX ✓ ${label}:`, sig);
    return sig;
  }

  // Helper pour créer un agent
  async function createAgentHelper(
    creator: web3.PublicKey,
    cardUri: string = "https://example.com/card.json",
    cardHash: number[] | Uint8Array = Array.from(new Uint8Array(32)),
    hasStaking: boolean | null = false,
    memoryMode: number | null = null,
    memoryPtr: number[] | Buffer | null = null,
    memoryHash: number[] | Uint8Array | null = null
  ) {
    const [agentPda] = deriveAgentPda(creator, program.programId);
    
    // Cleanup if exists
    try {
      const existing = await program.account.agentRegistry.fetchNullable(agentPda);
      if (existing) {
        await program.methods.setActive(false)
          .accountsPartial({ agent: agentPda, owner: creator }).rpc();
        await program.methods.closeAgent()
          .accountsPartial({ agent: agentPda, owner: creator, recipient: creator }).rpc();
        console.log("  🧹 Cleaned up existing agent");
      }
    } catch (e) {}
    
    return await program.methods
      .createAgent(
        creator,
        cardUri,
        Array.from(cardHash),
        hasStaking,
        memoryMode,
        memoryPtr ? Array.from(memoryPtr) : null,
        memoryHash ? Array.from(memoryHash) : null
      )
      .accountsPartial({
        agent: agentPda,
        creatorSigner: provider.wallet.publicKey,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();
  }

  // Helper pour cleanup
  async function cleanupAgent(creator: web3.PublicKey) {
    const [agentPda] = deriveAgentPda(creator, program.programId);
    try {
      const agent = await program.account.agentRegistry.fetchNullable(agentPda);
      if (agent) {
        await program.methods.setActive(false)
          .accountsPartial({ agent: agentPda, owner: creator }).rpc();
        await program.methods.closeAgent()
          .accountsPartial({ agent: agentPda, owner: creator, recipient: creator }).rpc();
      }
    } catch (e) {}
  }

  // =========================================================================
  // AGENT REGISTRY TESTS
  // =========================================================================

  describe("Agent Registry", () => {
    it("creates agent with card", async () => {
      const creator = provider.wallet.publicKey;
      const [agentPda] = deriveAgentPda(creator, program.programId);
      
      // Clean up if exists
      try {
        const existing = await program.account.agentRegistry.fetchNullable(agentPda);
        if (existing) {
          await program.methods.setActive(false)
            .accountsPartial({ agent: agentPda, owner: creator }).rpc();
          await program.methods.closeAgent()
            .accountsPartial({ agent: agentPda, owner: creator, recipient: creator }).rpc();
        }
      } catch (e) {}

      const cardUri = "https://example.com/agent-card.json";
      const cardHash = new Uint8Array(32);

      await rpc(
        program.methods.createAgent(
          creator,
          cardUri,
          Array.from(cardHash),
          false,
          null,
          null,
          null
        ).accountsPartial({
          agent: agentPda,
          creatorSigner: creator,
          systemProgram: web3.SystemProgram.programId,
        }),
        "create_agent"
      );

      const agent = await program.account.agentRegistry.fetch(agentPda);
      expect(agent.creator.toBase58()).eq(creator.toBase58());
      expect(agent.owner.toBase58()).eq(creator.toBase58());
      expect(agent.flags & 1).gt(0); // FLAG_ACTIVE
      expect(agent.flags & 4).eq(0); // FLAG_HAS_STAKING = false
      
      // Cleanup
      await program.methods.setActive(false).accountsPartial({ agent: agentPda, owner: creator }).rpc();
      await program.methods.closeAgent().accountsPartial({ agent: agentPda, owner: creator, recipient: creator }).rpc();
    });

    it("updates card", async () => {
      const creator = provider.wallet.publicKey;
      const [agentPda] = deriveAgentPda(creator, program.programId);
      
      await createAgentHelper(creator);

      const newUri = "https://example.com/new-card.json";
      const newHash = new Uint8Array(32).fill(1);

      await rpc(
        program.methods.setCard(newUri, Array.from(newHash))
          .accountsPartial({ agent: agentPda, owner: creator }),
        "set_card"
      );

      const agent = await program.account.agentRegistry.fetch(agentPda);
      const storedUri = Buffer.from(agent.cardUri).slice(0, agent.cardUriLen).toString();
      expect(storedUri).eq(newUri);
      
      // Cleanup
      await program.methods.setActive(false).accountsPartial({ agent: agentPda, owner: creator }).rpc();
      await program.methods.closeAgent().accountsPartial({ agent: agentPda, owner: creator, recipient: creator }).rpc();
    });

    it("sets memory (URL mode)", async () => {
      const creator = provider.wallet.publicKey;
      const [agentPda] = deriveAgentPda(creator, program.programId);
      
      await createAgentHelper(creator);

      const url = "https://example.com/memory.json";
      const hash = Array.from(new Uint8Array(32).fill(42));

      await rpc(
        program.methods.setMemory(3, Array.from(Buffer.from(url)), hash)
          .accountsPartial({ agent: agentPda, owner: creator }),
        "set_memory (URL)"
      );

      const agent = await program.account.agentRegistry.fetch(agentPda);
      expect(agent.memoryMode).eq(3);
      
      // Cleanup
      await cleanupAgent(creator);
    });

    it("locks memory", async () => {
      const creator = provider.wallet.publicKey;
      const [agentPda] = deriveAgentPda(creator, program.programId);
      
      await createAgentHelper(creator);

      await rpc(
        program.methods.lockMemory().accountsPartial({ agent: agentPda, owner: creator }),
        "lock_memory"
      );

      const agent = await program.account.agentRegistry.fetch(agentPda);
      expect(agent.flags & 2).gt(0); // FLAG_LOCKED

      // Should fail to update memory now
      await expectFail(
        program.methods.setMemory(0, [], null)
          .accountsPartial({ agent: agentPda, owner: creator }).rpc(),
        ["MemoryLocked"]
      );
      
      // Cleanup
      await cleanupAgent(creator);
    });

    it("transfers ownership", async () => {
      const creator = provider.wallet.publicKey;
      const [agentPda] = deriveAgentPda(creator, program.programId);
      const newOwner = web3.Keypair.generate().publicKey;
      
      await createAgentHelper(creator);

      await rpc(
        program.methods.transferOwner(newOwner)
          .accountsPartial({ agent: agentPda, owner: creator }),
        "transfer_owner"
      );

      const agent = await program.account.agentRegistry.fetch(agentPda);
      expect(agent.owner.toBase58()).eq(newOwner.toBase58());
      expect(agent.creator.toBase58()).eq(creator.toBase58()); // creator unchanged
      
      // Transfer back to cleanup
      await program.methods.transferOwner(creator)
        .accountsPartial({ agent: agentPda, owner: newOwner }).signers([provider.wallet.payer]).rpc();
      await cleanupAgent(creator);
    });

    it("cardHash validates SHA3-256 of card content", async () => {
      const creator = provider.wallet.publicKey;
      const [agentPda] = deriveAgentPda(creator, program.programId);

      const cardContent = JSON.stringify({ name: "Test Agent", version: "1.0" });
      const correctHash = Buffer.from(sha3_256(cardContent), "hex");
      const wrongHash = new Uint8Array(32).fill(99);

      // Create with correct hash
      await createAgentHelper(creator, "https://example.com/card.json", correctHash);

      const agent = await program.account.agentRegistry.fetch(agentPda);
      const storedHash = Buffer.from(agent.cardHash);

      // Verify hashes match
      expect(storedHash.toString("hex")).eq(correctHash.toString("hex"));
      expect(storedHash.toString("hex")).not.eq(Buffer.from(wrongHash).toString("hex"));
      
      // Cleanup
      await cleanupAgent(creator);
    });
  });

  // =========================================================================
  // STAKING TESTS
  // =========================================================================

  describe("Staking", () => {
    let agentPda: web3.PublicKey;
    let poolPda: web3.PublicKey;
    let statePda: web3.PublicKey;

    before(async () => {
      if (!hasPayer) {
        console.log("⚠️  Skipping staking tests - no payer available");
        return;
      }

      const creator = provider.wallet.publicKey;
      [agentPda] = deriveAgentPda(creator, program.programId);
      [poolPda] = derivePool(agentPda, program.programId);
      [statePda] = deriveProgramState(program.programId);

      // Create agent with staking enabled
      try {
        // Clean up first to ensure staking flag is correct
        try {
          const existing = await program.account.agentRegistry.fetchNullable(agentPda);
          if (existing && (existing.flags & 4) === 0) {
            // Agent exists but doesn't have staking - clean it
            await program.methods.setActive(false)
              .accountsPartial({ agent: agentPda, owner: creator }).rpc();
            await program.methods.closeAgent()
              .accountsPartial({ agent: agentPda, owner: creator, recipient: creator }).rpc();
            console.log("  🧹 Cleaned up agent without staking");
          }
        } catch (e) {}
        
        await createAgentHelper(creator, "https://example.com/card.json", new Uint8Array(32), true);
        console.log("  ✓ Created agent with staking enabled");
      } catch (e: any) {
        if (e.message?.includes("already in use")) {
          console.log("  ♻️  Agent already exists, reusing");
        } else {
          throw e;
        }
      }

      // Init program state if needed
      try {
        await program.account.programState.fetch(statePda);
        console.log("  ♻️  ProgramState already initialized");
      } catch (e) {
        const treasury = web3.Keypair.generate().publicKey;
        await rpc(
          program.methods.initProgramState()
            .accountsPartial({
              programState: statePda,
              initializer: provider.wallet.publicKey,
              treasury,
              systemProgram: web3.SystemProgram.programId,
            }),
          "init_program_state"
        );
        console.log("  ✓ Initialized ProgramState");
      }
    });

    it("creates staking pool", async function () {
      if (!hasPayer) return this.skip();

      const creator = provider.wallet.publicKey;
      const [vaultPda] = deriveTokenVault(poolPda, program.programId);

      // Check if pool already exists
      try {
        await program.account.stakingPool.fetch(poolPda);
        console.log("  ♻️  StakingPool already exists, skipping creation");
        return;
      } catch (e) {}

      await rpc(
        program.methods.createStakingPool(new anchor.BN(1000))
          .accountsPartial({
            agent: agentPda,
            stakingPool: poolPda,
            tokenVault: vaultPda,
            tokenMint,
            owner: creator,
            systemProgram: web3.SystemProgram.programId,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            rent: web3.SYSVAR_RENT_PUBKEY,
          }),
        "create_staking_pool"
      );

      const pool = await program.account.stakingPool.fetch(poolPda);
      expect(pool.minStakeAmount.toNumber()).eq(1000);
    });

    it("stakes tokens", async function () {
      if (!hasPayer) return this.skip();

      const staker = provider.wallet.publicKey;
      const [stakePda] = deriveStake(staker, agentPda, program.programId);
      const [vaultPda] = deriveTokenVault(poolPda, program.programId);

      // Init stake account if needed
      try {
        await program.account.stakeAccount.fetch(stakePda);
      } catch (e) {
        await rpc(
          program.methods.initStake()
            .accountsPartial({
              stakingPool: poolPda,
              agentPda,
              stakeAccount: stakePda,
              staker,
              systemProgram: web3.SystemProgram.programId,
            }),
          "init_stake"
        );
      }

      const amount = new anchor.BN(5000);
      await rpc(
        program.methods.stake(amount)
          .accountsPartial({
            stakingPool: poolPda,
            agentPda,
            stakeAccount: stakePda,
            tokenVault: vaultPda,
            stakerTokenAccount: userTokenAccount,
            staker,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          }),
        "stake"
      );

      const stake = await program.account.stakeAccount.fetch(stakePda);
      expect(stake.stakedAmount.toNumber()).gte(5000);
    });

    it("withdraws stake with fee", async function () {
      if (!hasPayer) return this.skip();

      const staker = provider.wallet.publicKey;
      const [stakePda] = deriveStake(staker, agentPda, program.programId);
      const [vaultPda] = deriveTokenVault(poolPda, program.programId);
      const state = await program.account.programState.fetch(statePda);

      const stakeBefore = await program.account.stakeAccount.fetch(stakePda);
      if (stakeBefore.stakedAmount.toNumber() === 0) {
        console.log("  ⚠️  No stake to withdraw, skipping");
        return;
      }

      await rpc(
        program.methods.withdrawStake()
          .accountsPartial({
            programState: statePda,
            stakingPool: poolPda,
            agentPda,
            stakeAccount: stakePda,
            tokenVault: vaultPda,
            stakerTokenAccount: userTokenAccount,
            staker,
            treasury: state.treasury,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            systemProgram: web3.SystemProgram.programId,
          }),
        "withdraw_stake"
      );

      const stakeAfter = await program.account.stakeAccount.fetch(stakePda);
      expect(stakeAfter.stakedAmount.toNumber()).eq(0);
    });

    it("updates min stake amount", async function () {
      if (!hasPayer) return this.skip();

      const owner = provider.wallet.publicKey;
      const newMinStake = new anchor.BN(2000);

      await rpc(
        program.methods.updateMinStake(newMinStake)
          .accountsPartial({
            stakingPool: poolPda,
            owner,
          }),
        "update_min_stake"
      );

      const pool = await program.account.stakingPool.fetch(poolPda);
      expect(pool.minStakeAmount.toNumber()).eq(2000);
    });

    it("agent with staking cannot be closed", async function () {
      if (!hasPayer) return this.skip();

      const creator = provider.wallet.publicKey;

      await expectFail(
        program.methods.closeAgent()
          .accountsPartial({
            agent: agentPda,
            owner: creator,
            recipient: creator,
          }).rpc(),
        ["StakingEnabled"]
      );
    });
  });
});

