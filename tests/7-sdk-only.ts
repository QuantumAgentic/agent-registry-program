/**
 * SDK-Only Integration Tests (Pure Web3.js - No Anchor)
 * 
 * Standalone test file that only tests the SDK functionality.
 * Run with: anchor test --skip-build --skip-deploy tests/7-sdk-only.ts
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

describe("SDK Integration (Standalone)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const wallet = (provider.wallet as anchor.Wallet).payer;

  let tokenMint: PublicKey;

  before(async () => {
    console.log("\n🔧 Test Setup");
    console.log("   Wallet:", wallet.publicKey.toBase58());
    
    // Create a mint for staking tests
    tokenMint = await createMint(
      connection,
      wallet,
      wallet.publicKey,
      null,
      9
    );

    console.log("✅ Token mint:", tokenMint.toBase58());
  });

  describe("Program IDs & Utilities", () => {
    it("exports correct program IDs", () => {
      expect(AGENT_PROGRAM_ID.toBase58()).to.equal("59Z648TXaaZM7j3RrPpVAUQxdn9K42kaAFBbMFbDiops");
      expect(AGENT_STAKING_PROGRAM_ID.toBase58()).to.equal("FE5kcoY1CsnAFak5PBBUy689hRKvpE2261C1GaWSbJak");
      console.log("✅ Program IDs verified");
    });

    it("derives PDAs correctly", () => {
      const creator = Keypair.generate().publicKey;
      const [agentPda, bump1] = deriveAgentPda(creator);
      const [poolPda, bump2] = deriveStakingPoolPda(agentPda);
      const [vaultPda, bump3] = deriveTokenVaultPda(poolPda);

      expect(bump1).to.be.a('number').within(0, 255);
      expect(bump2).to.be.a('number').within(0, 255);
      expect(bump3).to.be.a('number').within(0, 255);
      console.log("✅ PDA derivation works");
    });

    it("hashes card with JCS", async () => {
      const card1 = { name: "Agent", version: "1.0" };
      const card2 = { version: "1.0", name: "Agent" }; // Different order

      const hash1 = await hashCardJcs(card1);
      const hash2 = await hashCardJcs(card2);

      expect(hash1.length).to.equal(32);
      expect(Buffer.from(hash1).toString("hex")).to.equal(Buffer.from(hash2).toString("hex"));
      console.log("✅ JCS hashing works");
    });
  });

  describe("Basic Agent Lifecycle", () => {
    // Use unique creator for this test
    const creator = Keypair.generate();
    let agentPda: PublicKey;
    let cardHash: Uint8Array;

    before(async () => {
      // Airdrop to creator
      const sig = await connection.requestAirdrop(creator.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);
      
      cardHash = await hashCardJcs({ name: "Test Agent", version: "1.0" });
      console.log("\n👤 Creator:", creator.publicKey.toBase58());
    });

    it("creates an agent", async () => {
      console.log("\n📝 Creating agent...");
      
      agentPda = await createAgent({
        connection,
        payer: creator,
        cardUri: "https://example.com/agent.json",
        cardHash: Array.from(cardHash),
        hasStaking: false,
      });

      console.log("✅ Agent created:", agentPda.toBase58());

      // Verify
      const result = await fetchAgentByCreator(connection, creator.publicKey);
      expect(result).to.not.be.null;
      expect(result!.account.creator.toBase58()).to.equal(creator.publicKey.toBase58());
      expect(result!.account.owner.toBase58()).to.equal(creator.publicKey.toBase58());
      expect(result!.account.isActive).to.be.true;
      expect(result!.account.hasStaking).to.be.false;
    });

    it("updates card", async () => {
      console.log("\n📝 Updating card...");
      
      const newHash = await hashCardJcs({ name: "Test Agent", version: "2.0" });

      await setCard({
        connection,
        payer: creator,
        agentPda,
        cardUri: "https://example.com/agent-v2.json",
        cardHash: Array.from(newHash),
      });

      console.log("✅ Card updated");
    });

    it("sets memory", async () => {
      console.log("\n📝 Setting memory...");
      
      const url = "https://example.com/memory.json";
      const ptr = new TextEncoder().encode(url);
      const hash = new Uint8Array(32).fill(99);

      await setMemory({
        connection,
        payer: creator,
        agentPda,
        mode: 3, // URL
        ptr,
        hash: Array.from(hash),
      });

      const result = await fetchAgentByCreator(connection, creator.publicKey);
      expect(result!.account.memoryMode).to.equal(3);
      console.log("✅ Memory set");
    });

    it("transfers ownership", async () => {
      console.log("\n📝 Transferring ownership...");
      
      const newOwner = Keypair.generate();

      await transferOwner({
        connection,
        payer: creator,
        agentPda,
        newOwner: newOwner.publicKey,
      });

      const result = await fetchAgentByCreator(connection, creator.publicKey);
      expect(result!.account.owner.toBase58()).to.equal(newOwner.publicKey.toBase58());
      console.log("✅ Ownership transferred");

      // Transfer back
      await transferOwner({
        connection,
        payer: newOwner,
        agentPda,
        newOwner: creator.publicKey,
      });
      console.log("✅ Ownership restored");
    });

    it("deactivates and closes agent", async () => {
      console.log("\n📝 Deactivating agent...");
      
      await setActive({
        connection,
        payer: creator,
        agentPda,
        isActive: false,
      });

      console.log("✅ Agent deactivated");

      await closeAgent({
        connection,
        payer: creator,
        agentPda,
        recipient: creator.publicKey,
      });

      const result = await fetchAgentByCreator(connection, creator.publicKey);
      expect(result).to.be.null;
      console.log("✅ Agent closed");
    });
  });

  describe("Atomic Agent + Staking Creation", () => {
    const creator = Keypair.generate();
    let agentPda: PublicKey;
    let poolPda: PublicKey;
    let vaultPda: PublicKey;

    before(async () => {
      // Airdrop
      const sig = await connection.requestAirdrop(creator.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);
      console.log("\n👤 Creator:", creator.publicKey.toBase58());
    });

    it("creates agent + staking pool atomically", async () => {
      console.log("\n📝 Creating agent + staking pool...");
      
      const cardHash = await hashCardJcs({ name: "Staking Agent", version: "1.0" });

      const result = await createAgentWithStakingPool({
        connection,
        payer: creator,
        tokenMint,
        minStakeAmount: 1_000_000_000n,
        cardUri: "https://example.com/staking-agent.json",
        cardHash: Array.from(cardHash),
      });

      agentPda = result.agentPda;
      poolPda = result.poolPda;
      vaultPda = result.vaultPda;

      console.log("✅ Agent PDA:", agentPda.toBase58());
      console.log("✅ Pool PDA:", poolPda.toBase58());
      console.log("✅ Vault PDA:", vaultPda.toBase58());

      // Verify agent
      const agentResult = await fetchAgentByCreator(connection, creator.publicKey);
      expect(agentResult).to.not.be.null;
      expect(agentResult!.account.hasStaking).to.be.true;

      // Verify pool exists
      const poolAccount = await connection.getAccountInfo(poolPda);
      expect(poolAccount).to.not.be.null;
      expect(poolAccount!.owner.toBase58()).to.equal(AGENT_STAKING_PROGRAM_ID.toBase58());

      // Verify vault exists
      const vaultAccount = await connection.getAccountInfo(vaultPda);
      expect(vaultAccount).to.not.be.null;
    });

    it("cannot close agent with staking enabled", async () => {
      console.log("\n📝 Attempting to close (should fail)...");
      
      // Deactivate
      await setActive({
        connection,
        payer: creator,
        agentPda,
        isActive: false,
      });

      // Try to close
      try {
        await closeAgent({
          connection,
          payer: creator,
          agentPda,
          recipient: creator.publicKey,
        });
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("StakingEnabled");
        console.log("✅ Close correctly prevented");
      }
    });
  });
});

