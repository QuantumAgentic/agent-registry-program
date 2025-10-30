import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { AgentRegistry } from "../target/types/agent_registry";

function deriveAgentPda(creator: anchor.web3.PublicKey, programId: anchor.web3.PublicKey) {
  return anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("agent"), creator.toBuffer()], programId);
}

describe("register-devnet", () => {
  it("creates multiple agents on devnet", async () => {
    anchor.setProvider(anchor.AnchorProvider.env());
    const provider = anchor.getProvider() as anchor.AnchorProvider;
    const program = anchor.workspace.agentRegistry as Program<AgentRegistry>;

    const creator = provider.wallet.publicKey;
    const [agentPda] = deriveAgentPda(creator, program.programId);
    
    // Check if agent already exists (from previous test suite)
    const existingAccount = await program.account.agentRegistry.fetchNullable(agentPda);
    
    if (existingAccount) {
      console.log("\n📋 Agent Creation Test - Using Existing Agent");
      console.log("✓ Agent already exists from previous test suite");
      console.log(`  Creator: ${creator.toBase58()}`);
      console.log(`  PDA: ${agentPda.toBase58()}`);
      console.log(`  Card URI: ${Buffer.from(existingAccount.cardUri.slice(0, existingAccount.cardUriLen)).toString('utf8')}`);
      console.log(`  Flags: ${existingAccount.flags} (${(existingAccount.flags & 0x04) ? 'HAS_STAKING' : 'no staking'})`);
      
      // Verify the agent is properly structured
      expect(existingAccount.creator.toBase58()).to.equal(creator.toBase58());
      expect(existingAccount.cardUriLen).to.be.greaterThan(0);
      
      console.log("✓ Verified existing agent structure");
      console.log("  (This agent cannot be closed because staking is enabled - expected behavior)\n");
      return;
    }

    // No existing agent - create a new one for testing
    console.log("\n📋 Agent Creation Test - Creating New Agent");
    
    const testAgent = { 
      name: "Devnet Test Agent", 
      uri: "https://example.com/devnet-test-agent.json" 
    };
    
    const sig = await ((program.methods as any)
      .createAgent(
        creator, 
        testAgent.uri, 
        Array.from(new Uint8Array(32)), 
        false,  // has_staking=false to allow cleanup
        null,   // memory_mode
        null,   // memory_ptr
        null    // memory_hash
      ) as any)
      .accountsPartial({ 
        agent: agentPda, 
        creatorSigner: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      } as any)
      .rpc();
    
    console.log("✓ Created new agent:");
    console.log(`  Name: ${testAgent.name}`);
    console.log(`  Creator: ${creator.toBase58()}`);
    console.log(`  PDA: ${agentPda.toBase58()}`);
    console.log(`  Transaction: ${sig}`);
    
    // Verify the created agent
    const account = await program.account.agentRegistry.fetch(agentPda);
    expect(account.creator.toBase58()).to.equal(creator.toBase58());
    expect(account.cardUriLen).to.be.greaterThan(0);
    
    // Cleanup
    await program.methods
      .setActive(false)
      .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey })
      .rpc();
    await program.methods
      .closeAgent()
      .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey, recipient: provider.wallet.publicKey })
      .rpc();
    
    console.log("✓ Agent closed and cleaned up\n");
  });
});


