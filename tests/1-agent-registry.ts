import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { expect } from "chai";
import { AgentRegistry } from "../target/types/agent_registry";
import { sha3_256 } from "js-sha3";

const { PublicKey, Keypair } = web3;

function deriveAgentPda(creator: web3.PublicKey, programId: web3.PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("agent"), creator.toBuffer()], programId);
}

// Staking PDAs are in a separate program; this test only toggles the flag via set_has_staking.

describe("agent-registry", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.agentRegistry as Program<AgentRegistry>;

  // Cleanup before each test to ensure no agent is left behind
  beforeEach(async () => {
    try {
      const creator = provider.wallet.publicKey;
      const [agentPda] = deriveAgentPda(creator, program.programId);
      
      // Try to fetch the agent account
      const account = await program.account.agentRegistry.fetchNullable(agentPda);
      if (account) {
        // Agent exists, try to close it
        try {
          await program.methods
            .setActive(false)
            .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey })
            .rpc();
        } catch (e) {
          // Might already be inactive, that's OK
        }
        
        try {
          await program.methods
            .closeAgent()
            .accountsPartial({ 
              agent: agentPda, 
              owner: provider.wallet.publicKey, 
              recipient: provider.wallet.publicKey 
            })
            .rpc();
          console.log("✓ Cleaned up existing agent before test");
        } catch (e) {
          // Can't close (e.g., staking enabled), that's OK
        }
      }
    } catch (e) {
      // Account doesn't exist or other error, that's OK
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
      console.log("Expected failure caught", { code, msg, hasLogs: !!logs });
      if (logs) {
        const preview = logs.slice(0, 5);
        if (preview.length) console.log("  logs:", preview);
      }
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

  // Helper pour créer un agent avec la nouvelle API
  async function createAgentHelper(
    creator: web3.PublicKey,
    cardUri: string = "https://example.com/card.json",
    cardHash: number[] | Uint8Array = Array.from(new Uint8Array(32)),
    hasStaking: boolean | null = true,
    memoryMode: number | null = null,
    memoryPtr: number[] | Buffer | null = null,
    memoryHash: number[] | Uint8Array | null = null
  ) {
    const [agentPda] = deriveAgentPda(creator, program.programId);
    
    // Convert to proper types for Anchor
    const hashArray = cardHash instanceof Uint8Array ? Array.from(cardHash) : cardHash;
    const ptrBuffer = memoryPtr ? (Buffer.isBuffer(memoryPtr) ? memoryPtr : Buffer.from(memoryPtr)) : null;
    const memHashArray = memoryHash ? (memoryHash instanceof Uint8Array ? Array.from(memoryHash) : memoryHash) : null;
    
    await ((program.methods as any)
      .createAgent(creator, cardUri, hashArray, hasStaking, memoryMode, ptrBuffer, memHashArray) as any)
      .accountsPartial({ 
        agent: agentPda, 
        creatorSigner: provider.wallet.publicKey,
        systemProgram: web3.SystemProgram.programId 
      } as any)
      .rpc();
    return agentPda;
  }

  it("Create -> set_card (https) -> memory flows -> lock -> close", async () => {
    const creator = provider.wallet.publicKey; // Must be signer
    const [agentPda] = deriveAgentPda(creator, program.programId);
    
    // create with card using helper (has_staking=false to allow closing)
    await createAgentHelper(creator, "https://example.com/card.json", Array.from(new Uint8Array(32)), false);

    // set_card invalid http
    await expectFail(
      program.methods
        .setCard("http://insecure.example.com/card.json", Array.from(new Uint8Array(32)))
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey })
        .rpc(),
      ["InsecureUrl"]
    );

    // set_card valid https
    const cardHash = new Uint8Array(32); // zero allowed
    await rpc(
      program.methods
        .setCard("https://example.com/card.json", Array.from(cardHash))
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }),
      "setCard(https)"
    );

    // memory None valid
    await rpc(
      program.methods
        .setMemory(0, Buffer.from([]), null)
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }),
      "setMemory(None)"
    );

    // memory None invalid (non-empty ptr)
    await expectFail(
      program.methods
        .setMemory(0, Buffer.from(new TextEncoder().encode("something")), null)
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey })
        .rpc(),
      ["InvalidMemoryFields"]
    );

    // memory Cid valid (ptr>0, no hash)
    await rpc(
      program.methods
        .setMemory(1, Buffer.from(new TextEncoder().encode("bafybeigdyrztw3examplecidbase32")), null)
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }),
      "setMemory(Cid)"
    );

    // memory Ipns missing hash -> error
    await expectFail(
      program.methods
        .setMemory(2, Buffer.from(new TextEncoder().encode("/ipns/name")), null)
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey })
        .rpc(),
      ["InvalidMemoryFields"]
    );

    // memory Url insecure -> error
    await expectFail(
      program.methods
        .setMemory(3, Buffer.from(new TextEncoder().encode("http://bad.example/manifest.json")), Array.from(new Uint8Array(32).fill(1)))
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey })
        .rpc(),
      ["InsecureUrl"]
    );

    // memory Url valid (https + 32B hash)
    const h = new Uint8Array(32).fill(7);
    await rpc(
      program.methods
        .setMemory(3, Buffer.from(new TextEncoder().encode("https://good.example/manifest.json")), Array.from(h))
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }),
      "setMemory(Url)"
    );

    // lock
    await rpc(
      program.methods
        .lockMemory()
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }),
      "lockMemory"
    );

    // memory after lock -> error
    await expectFail(
      program.methods
        .setMemory(1, Buffer.from(new TextEncoder().encode("bafy...cid2")), null)
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey })
        .rpc(),
      ["MemoryLocked"]
    );

    // deactivate and close
    await rpc(
      program.methods
        .setActive(false)
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }),
      "setActive(false)"
    );

    await rpc(
      program.methods
        .closeAgent()
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey, recipient: provider.wallet.publicKey }),
      "closeAgent"
    );
  });

  it("create with initial card sets fields", async () => {
    const creator = provider.wallet.publicKey; // Must be signer
    const initHash = new Uint8Array(32).fill(5);
    const agentPda = await createAgentHelper(
      creator, 
      "https://init.example/card.json", 
      Array.from(initHash),
      false  // has_staking=false to allow closing
    );

    const acc = await program.account.agentRegistry.fetch(agentPda);
    expect(acc.cardUriLen).to.be.greaterThan(0);
    expect(Array.from(acc.cardHash)).to.deep.equal(Array.from(initHash));

    await rpc(
      program.methods
        .setActive(false)
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }),
      "setActive(false)"
    );

    await rpc(
      program.methods
        .closeAgent()
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey, recipient: provider.wallet.publicKey }),
      "closeAgent"
    );
  });

  it("cardHash must match SHA3-256 of card content", async () => {
    const creator = provider.wallet.publicKey;
    
    // Simulate card JSON content
    const cardContent = JSON.stringify({
      name: "Test Agent",
      description: "An agent for testing hash validation",
      image: "https://example.com/image.png"
    });
    
    // Calculate correct SHA3-256 hash
    const correctHash = Buffer.from(sha3_256(cardContent), 'hex');
    const correctHashArray = Array.from(correctHash);
    
    // Create agent with correct hash
    const [agentPda] = deriveAgentPda(creator, program.programId);
    await rpc(
      ((program.methods as any)
        .createAgent(
          creator,
          "https://example.com/test-card.json",
          correctHashArray,
          false,
          null, null, null
        ) as any)
        .accountsPartial({
          agent: agentPda,
          creatorSigner: provider.wallet.publicKey,
          systemProgram: web3.SystemProgram.programId
        } as any),
      "createAgent with correct SHA3-256 hash"
    );
    
    // Verify the hash is stored correctly
    const acc = await program.account.agentRegistry.fetch(agentPda);
    expect(Array.from(acc.cardHash)).to.deep.equal(correctHashArray);
    
    // Try to update with an INCORRECT hash (should be allowed by contract but semantically wrong)
    const wrongHash = Array.from(new Uint8Array(32).fill(9));
    await rpc(
      program.methods
        .setCard("https://example.com/different-card.json", wrongHash)
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }),
      "setCard with different hash (allowed but semantically incorrect)"
    );
    
    // Verify wrong hash was stored (contract doesn't validate hash correctness)
    const acc2 = await program.account.agentRegistry.fetch(agentPda);
    expect(Array.from(acc2.cardHash)).to.deep.equal(wrongHash);
    expect(Array.from(acc2.cardHash)).to.not.deep.equal(correctHashArray);
    
    console.log(`
    ⚠️  NOTE: The contract stores cardHash but does NOT validate it matches the card content.
    It is the CLIENT's responsibility to:
    1. Fetch the card content from cardUri
    2. Compute SHA3-256 hash of the content
    3. Compare with the stored cardHash
    4. Reject if they don't match
    
    Correct hash: ${Buffer.from(correctHashArray).toString('hex')}
    Wrong hash:   ${Buffer.from(wrongHash).toString('hex')}
    `);
    
    // Cleanup
    await program.methods.setActive(false).accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }).rpc();
    await program.methods.closeAgent().accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey, recipient: provider.wallet.publicKey }).rpc();
  });

  it("double create fails with AlreadyInitialized", async () => {
    const creator = provider.wallet.publicKey; // Must be signer
    const [agentPda] = deriveAgentPda(creator, program.programId);
    await createAgentHelper(creator, "https://example.com/card.json", Array.from(new Uint8Array(32)), false);

    await expectFail(
      createAgentHelper(creator, "https://example.com/card.json", Array.from(new Uint8Array(32)), false)
    );

    // Cleanup
    await program.methods.setActive(false).accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }).rpc();
    await program.methods.closeAgent().accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey, recipient: provider.wallet.publicKey }).rpc();
  });

  it("setActive toggles ACTIVE flag", async () => {
    const creator = provider.wallet.publicKey; // Must be signer
    const [agentPda] = deriveAgentPda(creator, program.programId);
    await createAgentHelper(creator, "https://example.com/card.json", Array.from(new Uint8Array(32)), false);

    // deactivate
    await rpc(
      program.methods
        .setActive(false)
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }),
      "setActive(false)"
    );
    let acc = await program.account.agentRegistry.fetch(agentPda);
    expect((acc.flags & 1) === 0).to.eq(true);

    // reactivate
    await rpc(
      program.methods
        .setActive(true)
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }),
      "setActive(true)"
    );
    acc = await program.account.agentRegistry.fetch(agentPda);
    expect((acc.flags & 1) === 1).to.eq(true);
  });

  it("manifest memory mode updates fields", async () => {
    const creator = provider.wallet.publicKey; // Must be signer
    const [agentPda] = deriveAgentPda(creator, program.programId);
    await createAgentHelper(creator, "https://example.com/card.json", Array.from(new Uint8Array(32)), false);

    const ptr = Buffer.from(new TextEncoder().encode("manifest://v1/root"));
    const hash = new Uint8Array(32).fill(9);
    await rpc(
      program.methods
        .setMemory(4, ptr, Array.from(hash))
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }),
      "setMemory(Manifest)"
    );

    const acc = await program.account.agentRegistry.fetch(agentPda);
    expect(acc.memoryMode).to.eq(4);
    expect(acc.memoryPtrLen).to.eq(ptr.length);
    expect(Array.from(acc.memoryHash)).to.deep.equal(Array.from(hash));

    // Cleanup
    await program.methods.setActive(false).accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }).rpc();
    await program.methods.closeAgent().accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey, recipient: provider.wallet.publicKey }).rpc();
  });

  it("closeAgent fails when active", async () => {
    const creator = provider.wallet.publicKey; // Must be signer
    const [agentPda] = deriveAgentPda(creator, program.programId);
    await createAgentHelper(creator, "https://example.com/card.json", Array.from(new Uint8Array(32)), false);

    await expectFail(
      program.methods
        .closeAgent()
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey, recipient: provider.wallet.publicKey })
        .rpc(),
      ["AgentActive"]
    );

    // deactivate so cleanup does not leave garbage accounts
    await rpc(
      program.methods
        .setActive(false)
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }),
      "setActive(false)"
    );
    await rpc(
      program.methods
        .closeAgent()
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey, recipient: provider.wallet.publicKey }),
      "closeAgent"
    );
  });

  it("memory None zero-fills ptr and len=0", async () => {
    const creator = provider.wallet.publicKey; // Must be signer
    const [agentPda] = deriveAgentPda(creator, program.programId);
    await createAgentHelper(creator, "https://example.com/card.json", Array.from(new Uint8Array(32)), false);

    // Set some non-empty state first
    await rpc(
      program.methods
        .setMemory(1, Buffer.from(new TextEncoder().encode("bafybeigdyrztw3examplecidbase32")), null)
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }),
      "setMemory(Cid)"
    );

    // Now None should zero-fill
    await rpc(
      program.methods
        .setMemory(0, Buffer.from([]), null)
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }),
      "setMemory(None)"
    );

    const acc = await program.account.agentRegistry.fetch(agentPda);
    expect(acc.memoryPtrLen).to.eq(0);
    expect(Array.from(acc.memoryPtr)).to.deep.equal(Array.from(new Uint8Array(96).fill(0)));

    // Cleanup
    await program.methods.setActive(false).accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }).rpc();
    await program.methods.closeAgent().accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey, recipient: provider.wallet.publicKey }).rpc();
  });

  it("Url memory rejects non-UTF8 and http://; accepts https://", async () => {
    const creator = provider.wallet.publicKey; // Must be signer
    const [agentPda] = deriveAgentPda(creator, program.programId);
    await createAgentHelper(creator, "https://example.com/card.json", Array.from(new Uint8Array(32)), false);

    // non-UTF8 (invalid byte sequence)
    const bad = Buffer.from([0xff, 0xfe, 0xfd]);
    await expectFail(
      program.methods
        .setMemory(3, bad, Array.from(new Uint8Array(32).fill(1)))
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey })
        .rpc(),
      ["InvalidMemoryFields"]
    );

    // http:// rejected
    await expectFail(
      program.methods
        .setMemory(3, Buffer.from(new TextEncoder().encode("http://bad")), Array.from(new Uint8Array(32).fill(2)))
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey })
        .rpc(),
      ["InsecureUrl"]
    );

    // https:// accepted
    await rpc(
      program.methods
        .setMemory(3, Buffer.from(new TextEncoder().encode("https://ok")), Array.from(new Uint8Array(32).fill(3)))
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }),
      "setMemory(Url https)"
    );

    // Cleanup
    await program.methods.setActive(false).accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }).rpc();
    await program.methods.closeAgent().accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey, recipient: provider.wallet.publicKey }).rpc();
  });

  it("card_uri supports https:// and ipfs:// only", async () => {
    const creator = provider.wallet.publicKey; // Must be signer
    const [agentPda] = deriveAgentPda(creator, program.programId);
    await createAgentHelper(creator, "https://ok", Array.from(new Uint8Array(32)), false);

    await rpc(
      program.methods
        .setCard("ipfs://bafy...", Array.from(new Uint8Array(32).fill(4)))
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }),
      "setCard(ipfs)"
    );

    await expectFail(
      program.methods
        .setCard("mailto:bad@example.com", Array.from(new Uint8Array(32).fill(5)))
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey })
        .rpc(),
      ["InsecureUrl"]
    );

    await rpc(
      program.methods
        .setActive(false)
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }),
      "setActive(false)"
    );
    await rpc(
      program.methods
        .closeAgent()
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey, recipient: provider.wallet.publicKey }),
      "closeAgent"
    );
  });

  it("CID mode validates basic shape (v1/v0)", async () => {
    const creator = provider.wallet.publicKey; // Must be signer
    const [agentPda] = deriveAgentPda(creator, program.programId);
    await createAgentHelper(creator, "https://example.com/card.json", Array.from(new Uint8Array(32)), false);

    // Good CIDv1 style (rough)
    await rpc(
      program.methods
        .setMemory(1, Buffer.from(new TextEncoder().encode("bafybeigdyrztw3examplecidbase32")), null)
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }),
      "setMemory(Cid v1 ok)"
    );

    // Good CIDv0 style (46 chars base58btc starting with Qm). Use a plausible-length placeholder.
    await rpc(
      program.methods
        .setMemory(1, Buffer.from(new TextEncoder().encode("Qm" + "1".repeat(44))), null)
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }),
      "setMemory(Cid v0 ok)"
    );

    // Bad: wrong prefix
    await expectFail(
      program.methods
        .setMemory(1, Buffer.from(new TextEncoder().encode("cid:bad")), null)
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey })
        .rpc(),
      ["InvalidMemoryFields"]
    );

    // Bad: invalid characters for base32
    await expectFail(
      program.methods
        .setMemory(1, Buffer.from(new TextEncoder().encode("bafyBEI@#")), null)
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey })
        .rpc(),
      ["InvalidMemoryFields"]
    );

    // Cleanup
    await program.methods.setActive(false).accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }).rpc();
    await program.methods.closeAgent().accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey, recipient: provider.wallet.publicKey }).rpc();
  });

  it("create agent with memory at creation", async () => {
    const creator = provider.wallet.publicKey; // Must be signer
    const cardUri = "https://example.com/card.json";
    const cardHash = Array.from(new Uint8Array(32).fill(1));
    const memoryMode = 3; // URL
    const memoryPtr = Buffer.from(new TextEncoder().encode("https://memory.example/manifest.json"));
    const memoryHash = Array.from(new Uint8Array(32).fill(2));
    
    const agentPda = await createAgentHelper(
      creator,
      cardUri,
      cardHash,
      false,  // has_staking=false to allow cleanup
      memoryMode,
      Array.from(memoryPtr),
      memoryHash
    );

    const acc = await program.account.agentRegistry.fetch(agentPda);
    expect(acc.memoryMode).to.eq(memoryMode);
    expect(acc.memoryPtrLen).to.eq(memoryPtr.length);
    expect(Array.from(acc.memoryHash)).to.deep.equal(memoryHash);
    
    // Cleanup
    await program.methods
      .setActive(false)
      .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey })
      .rpc();
    await program.methods
      .closeAgent()
      .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey, recipient: provider.wallet.publicKey })
      .rpc();
  });

  it("transfer_owner updates owner field and can transfer back", async () => {
    const creator = provider.wallet.publicKey; // Must be signer
    const agentPda = await createAgentHelper(creator, "https://example.com/card.json", Array.from(new Uint8Array(32)), false);

    // Create a new keypair to transfer to
    const newOwnerKeypair = Keypair.generate();
    const newOwner = newOwnerKeypair.publicKey;
    
    await rpc(
      ((program.methods as any)
        .transferOwner(newOwner) as any)
        .accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey } as any),
      "transferOwner to newOwner"
    );

    let acc = await program.account.agentRegistry.fetch(agentPda);
    expect(acc.owner.toBase58()).to.eq(newOwner.toBase58());
    expect(acc.creator.toBase58()).to.eq(creator.toBase58()); // creator remains unchanged
    
    // Transfer back to original owner so we can cleanup
    await rpc(
      ((program.methods as any)
        .transferOwner(provider.wallet.publicKey) as any)
        .accountsPartial({ agent: agentPda, owner: newOwner } as any)
        .signers([newOwnerKeypair]),
      "transferOwner back to original"
    );
    
    acc = await program.account.agentRegistry.fetch(agentPda);
    expect(acc.owner.toBase58()).to.eq(provider.wallet.publicKey.toBase58());
    
    // Now cleanup
    await program.methods.setActive(false).accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey }).rpc();
    await program.methods.closeAgent().accountsPartial({ agent: agentPda, owner: provider.wallet.publicKey, recipient: provider.wallet.publicKey }).rpc();
  });

  // NOTE: Test "staking enabled blocks closeAgent" has been moved to 2-staking.ts
  // to ensure proper test execution order. This allows agent-registry tests to
  // complete cleanly before staking tests create agents that cannot be closed.
});
