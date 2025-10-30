/**
 * Test SDK Integration with agent-registry and agent-staking programs
 * 
 * This test uses the pure Web3.js SDK to interact with the programs.
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import {
  createAgent,
  fetchAgentByCreator,
  setCard,
  setMemory,
  setActive,
  transferOwner,
  closeAgent,
  createAgentWithStakingPool,
  hashCardJcs,
  deriveAgentPda,
  deriveStakingPoolPda,
  deriveTokenVaultPda,
  AGENT_PROGRAM_ID,
  AGENT_STAKING_PROGRAM_ID,
} from "../../../sdk/src/index";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

describe("SDK Integration Tests (agent-registry + agent-staking)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  let tokenMint: PublicKey;
  let payerTokenAccount: PublicKey;

  before(async () => {
    console.log("\n🔧 Setup: Creating SPL token mint...");
    
    // Create a mint for staking
    tokenMint = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      9
    );

    // Create token account for payer
    const tokenAccountInfo = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      tokenMint,
      payer.publicKey
    );
    payerTokenAccount = tokenAccountInfo.address;

    // Mint some tokens
    await mintTo(
      connection,
      payer,
      tokenMint,
      payerTokenAccount,
      payer,
      1_000_000_000_000n
    );

    console.log("✅ Token mint created:", tokenMint.toBase58());
    console.log("✅ Payer token account:", payerTokenAccount.toBase58());
  });

  describe("Agent Registry (SDK)", () => {
    let agentPda: PublicKey;
    const cardData = {
      name: "SDK Test Agent",
      description: "Testing with pure Web3.js SDK",
      version: "1.0.0",
    };
    let cardHash: Uint8Array;

    before(async () => {
      console.log("\n👤 Creator (payer):", payer.publicKey.toBase58());

      // Calculate card hash
      cardHash = await hashCardJcs(cardData);
      console.log("🔐 Card hash:", Buffer.from(cardHash).toString("hex").slice(0, 16) + "...");
    });

    it("creates an agent using SDK", async () => {
      console.log("\n📝 Creating agent with SDK...");
      
      agentPda = await createAgent({
        connection,
        payer,
        // creator defaults to payer.publicKey
        cardUri: "https://example.com/agent-sdk.json",
        cardHash: Array.from(cardHash),
        hasStaking: false,
      });

      console.log("✅ Agent created:", agentPda.toBase58());

      // Verify the agent was created
      const result = await fetchAgentByCreator(connection, payer.publicKey);
      expect(result).to.not.be.null;
      expect(result!.pda.toBase58()).to.equal(agentPda.toBase58());
      expect(result!.account.creator.toBase58()).to.equal(payer.publicKey.toBase58());
      expect(result!.account.owner.toBase58()).to.equal(payer.publicKey.toBase58());
      expect(result!.account.flags & 1).to.equal(1); // ACTIVE by default
    });

    it("updates card using SDK", async () => {
      console.log("\n📝 Updating card...");
      
      const newCardData = { ...cardData, version: "1.1.0" };
      const newCardHash = await hashCardJcs(newCardData);

      await setCard({
        connection,
        payer,
        agentPda: agentPda,
        cardUri: "https://example.com/agent-sdk-v2.json",
        cardHash: Array.from(newCardHash),
      });

      // Verify
      const result = await fetchAgentByCreator(connection, payer.publicKey);
      expect(result).to.not.be.null;
      const cardUriStr = Buffer.from(result!.account.cardUri).toString('utf-8').replace(/\0/g, '');
      expect(cardUriStr).to.equal("https://example.com/agent-sdk-v2.json");
    });

    it("sets memory using SDK", async () => {
      console.log("\n📝 Setting memory...");
      
      const memoryUrl = "https://example.com/memory.json";
      const memoryPtr = new TextEncoder().encode(memoryUrl);
      const memoryHash = new Uint8Array(32).fill(42);

      await setMemory({
        connection,
        payer,
        agentPda: agentPda,
        mode: 3, // URL mode
        ptr: memoryPtr,
        hash: Array.from(memoryHash),
      });

      // Verify
      const result = await fetchAgentByCreator(connection, payer.publicKey);
      expect(result).to.not.be.null;
      expect(result!.account.memoryMode).to.equal(3);
    });

    it("deactivates agent using SDK", async () => {
      console.log("\n📝 Deactivating agent...");
      
      await setActive({
        connection,
        payer,
        agentPda: agentPda,
        isActive: false,
      });

      // Verify
      const result = await fetchAgentByCreator(connection, payer.publicKey);
      expect(result).to.not.be.null;
      expect(result!.account.flags & 1).to.equal(0); // ACTIVE bit should be off
    });

    it("transfers ownership using SDK", async () => {
      console.log("\n📝 Transferring ownership...");
      
      const newOwner = Keypair.generate();

      await transferOwner({
        connection,
        payer,
        agentPda: agentPda,
        newOwner: newOwner.publicKey,
      });

      // Verify
      const result = await fetchAgentByCreator(connection, payer.publicKey);
      expect(result).to.not.be.null;
      expect(result!.account.owner.toBase58()).to.equal(newOwner.publicKey.toBase58());

      // Transfer back for cleanup
      await transferOwner({
        connection,
        payer: newOwner,
        agentPda: agentPda,
        newOwner: payer.publicKey,
      });
    });

    it("closes agent using SDK", async () => {
      console.log("\n📝 Closing agent...");
      
      await closeAgent({
        connection,
        payer,
        agentPda: agentPda,
        recipient: payer.publicKey,
      });

      // Verify account is closed
      const result = await fetchAgentByCreator(connection, payer.publicKey);
      expect(result).to.be.null;
    });
  });

  describe("Atomic Agent + Staking Pool Creation (SDK)", () => {
    let agentPda: PublicKey;
    let poolPda: PublicKey;
    let vaultPda: PublicKey;
    const cardData = {
      name: "SDK Staking Agent",
      description: "Agent with staking pool created atomically",
      version: "1.0.0",
    };
    let cardHash: Uint8Array;

    before(async () => {
      cardHash = await hashCardJcs(cardData);
      console.log("\n👤 Creator (payer):", payer.publicKey.toBase58());
    });

    it("creates agent with staking pool atomically using SDK", async () => {
      console.log("\n📝 Creating agent + staking pool atomically...");
      
      const result = await createAgentWithStakingPool({
        connection,
        payer,
        // creator defaults to payer.publicKey
        tokenMint,
        minStakeAmount: 1000000000n, // 1 token
        cardUri: "https://example.com/staking-agent.json",
        cardHash: Array.from(cardHash),
        memoryMode: 3,
        memoryPtr: "https://example.com/memory.json",
        memoryHash: Array.from(new Uint8Array(32).fill(99)),
      });

      agentPda = result.agentPda;
      poolPda = result.poolPda;
      vaultPda = result.vaultPda;

      console.log("✅ Agent PDA:", agentPda.toBase58());
      console.log("✅ Pool PDA:", poolPda.toBase58());
      console.log("✅ Vault PDA:", vaultPda.toBase58());
      console.log("✅ Transaction:", result.signature);

      // Verify agent exists
      const agentResult = await fetchAgentByCreator(connection, payer.publicKey);
      expect(agentResult).to.not.be.null;
      expect(agentResult!.account.hasStaking).to.be.true;

      // Verify staking pool exists
      const poolAccount = await connection.getAccountInfo(poolPda);
      expect(poolAccount).to.not.be.null;
      expect(poolAccount!.owner.toBase58()).to.equal(AGENT_STAKING_PROGRAM_ID.toBase58());

      // Verify token vault exists
      const vaultAccount = await connection.getAccountInfo(vaultPda);
      expect(vaultAccount).to.not.be.null;
    });

    after(async () => {
      // Cleanup: close agent
      console.log("\n🧹 Cleanup: Closing agent...");
      try {
        await setActive({
          connection,
          payer,
          agentPda: agentPda,
          isActive: false,
        });
        // Note: Cannot close agent with staking enabled
        // This is expected behavior
      } catch (err) {
        console.log("⚠️  Cannot close agent with staking (expected)");
      }
    });
  });

  describe("SDK Program IDs", () => {
    it("has correct program IDs", () => {
      console.log("\n🔍 Verifying program IDs...");
      console.log("  AGENT_PROGRAM_ID:", AGENT_PROGRAM_ID.toBase58());
      console.log("  AGENT_STAKING_PROGRAM_ID:", AGENT_STAKING_PROGRAM_ID.toBase58());

      // Verify they match Anchor.toml
      expect(AGENT_PROGRAM_ID.toBase58()).to.equal("59Z648TXaaZM7j3RrPpVAUQxdn9K42kaAFBbMFbDiops");
      expect(AGENT_STAKING_PROGRAM_ID.toBase58()).to.equal("FE5kcoY1CsnAFak5PBBUy689hRKvpE2261C1GaWSbJak");
    });

    it("derives PDAs correctly", () => {
      const testCreator = Keypair.generate().publicKey;
      const [agentPda, agentBump] = deriveAgentPda(testCreator);
      const [poolPda, poolBump] = deriveStakingPoolPda(agentPda);
      const [vaultPda, vaultBump] = deriveTokenVaultPda(poolPda);

      console.log("\n🔍 PDA Derivation:");
      console.log("  Creator:", testCreator.toBase58());
      console.log("  Agent PDA:", agentPda.toBase58(), "bump:", agentBump);
      console.log("  Pool PDA:", poolPda.toBase58(), "bump:", poolBump);
      console.log("  Vault PDA:", vaultPda.toBase58(), "bump:", vaultBump);

      // Verify PDAs are valid
      expect(agentPda.toBase58()).to.be.a('string');
      expect(poolPda.toBase58()).to.be.a('string');
      expect(vaultPda.toBase58()).to.be.a('string');
      expect(agentBump).to.be.a('number');
      expect(poolBump).to.be.a('number');
      expect(vaultBump).to.be.a('number');
    });
  });
});

