/**
 * Minimal SDK Test - Just verify basic functionality
 */

import * as anchor from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import {
  createAgent,
  fetchAgentByCreator,
  hashCardJcs,
  AGENT_PROGRAM_ID,
  AGENT_STAKING_PROGRAM_ID,
} from "../../../sdk/src/index";

describe("Minimal SDK Test", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;

  it("has correct program IDs", () => {
    console.log("\nAgent Registry:", AGENT_PROGRAM_ID.toBase58());
    console.log("Agent Staking:", AGENT_STAKING_PROGRAM_ID.toBase58());
    
    expect(AGENT_PROGRAM_ID.toBase58()).to.equal("59Z648TXaaZM7j3RrPpVAUQxdn9K42kaAFBbMFbDiops");
    expect(AGENT_STAKING_PROGRAM_ID.toBase58()).to.equal("FE5kcoY1CsnAFak5PBBUy689hRKvpE2261C1GaWSbJak");
  });

  it("hashes card correctly", async () => {
    const card = { name: "Test", version: "1.0" };
    const hash = await hashCardJcs(card);
    
    expect(hash.length).to.equal(32);
    console.log("\n✅ Hash:", Buffer.from(hash).toString("hex").slice(0, 16) + "...");
  });

  it("creates an agent with SDK", async () => {
    const creator = Keypair.generate();
    
    console.log("\n📝 Requesting airdrop for:", creator.publicKey.toBase58());
    const airdropSig = await connection.requestAirdrop(creator.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdropSig, "confirmed");
    console.log("✅ Airdrop confirmed");

    const cardHash = await hashCardJcs({ name: "Minimal Test Agent" });
    
    console.log("📝 Creating agent...");
    const agentPda = await createAgent({
      connection,
      payer: creator,
      cardUri: "https://example.com/minimal.json",
      cardHash: Array.from(cardHash),
      hasStaking: false,
    });

    console.log("✅ Agent created:", agentPda.toBase58());

    // Fetch and verify
    const result = await fetchAgentByCreator(connection, creator.publicKey);
    expect(result).to.not.be.null;
    expect(result!.account.creator.toBase58()).to.equal(creator.publicKey.toBase58());
    console.log("✅ Agent verified on-chain");
  });
});

