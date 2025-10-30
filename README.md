## Agent Registry & Staking Programs

Solana smart contracts for managing on-chain AI Agent metadata and token staking. The Agent Registry enables decentralized registration and management of AI agents on Solana, providing immutable proof of agent identity, configuration, and memory state.

**🌐 Network**: Currently deployed on **Devnet**

### Table of Contents

- [Quick Start with SDK](#quick-start-with-sdk)
- [Key Features](#key-features)
- [Use Cases](#use-cases)
- [Programs](#programs)
- [Account Structure](#account-structure-agentregistry)
- [Instructions](#instructions)
- [Usage Examples](#usage-examples)
- [Build & Deploy](#local-build--test)
- [TypeScript Integration](#typescript-examples)
- [License](#license)

---

### Quick Start with SDK

The easiest way to interact with the Agent Registry program is using our official SDK:

**[Agent Registry SDK](https://github.com/QuantumAgentic/agent-registry-sdk)** _(Coming soon to npm)_

You can install it directly from GitHub:

```bash
npm install github:QuantumAgentic/agent-registry-sdk
```

```typescript
import { AgentRegistryClient } from '@quantumagentic/agent-registry-sdk';

// Initialize the client
const client = new AgentRegistryClient(connection, wallet);

// Create an agent
const agentAddress = await client.createAgent({
  agentWallet: agentKeypair.publicKey,
  cardUri: 'https://example.com/agent-card.json',
  cardHash: cardHashBytes
});

// Update agent memory
await client.setMemory({
  agentAddress,
  mode: 'url',
  pointer: 'https://storage.example.com/agent-memory.json',
  hash: memoryHashBytes
});
```

For complete SDK documentation, examples, and API reference, visit the [SDK repository](https://github.com/QuantumAgentic/agent-registry-sdk).

---

### Key Features

- **Decentralized Agent Identity**: Each agent is uniquely identified by a PDA derived from its creator's wallet
- **Immutable Memory Locking**: Lock agent memory and configuration to create tamper-proof agent states
- **Multiple Storage Options**: Support for IPFS (CID), IPNS, URLs, and manifest formats
- **Metadata Management**: Store and update agent cards with cryptographic hash verification
- **Ownership Transfer**: Transfer admin rights to new owners while preserving agent identity
- **Efficient Storage**: Only 285 bytes per agent (~0.002 SOL rent)
- **Event Emissions**: Comprehensive event logging for all state changes
- **Security First**: Built-in validation for URLs, hash verification, and permission checks

### Use Cases

The Agent Registry is designed for various AI agent applications:

- **Trading & DeFi Agents**: Register autonomous trading bots with verifiable strategies and memory
- **NFT Agents**: On-chain identity and configuration for generative AI agents
- **Gaming Agents**: Store game AI configurations, behaviors, and learning states
- **Social Agents**: Manage chatbot personalities, memory, and interaction history
- **Data Agents**: Register agents that process and analyze on-chain data
- **DAO Agents**: Automate governance decisions with transparent agent logic

---

### 📋 Programs

#### **Agent Registry**
**Program ID**: `25wEsSLdsmZUisXuciyUXZqbpocsk5CJ7Uf6Eq553N8r`
📊 [View on Solscan](https://solscan.io/account/25wEsSLdsmZUisXuciyUXZqbpocsk5CJ7Uf6Eq553N8r?cluster=devnet)

Manage on-chain AI Agent metadata. Each Agent is a PDA derived from seeds `["agent", creator]`.

#### **Agent Staking**
**Program ID**: `j3WMvorrddakwt69dqrQ5cve5APpyd4bxUCb9UF9Aqj`
📊 [View on Solscan](https://solscan.io/account/j3WMvorrddakwt69dqrQ5cve5APpyd4bxUCb9UF9Aqj?cluster=devnet)

SPL token staking for agents with time-based unstake fees.

#### **Agent Platform (Merged)**
**Program ID**: `3TNdmF3EC9yrJjm5fxfFrrBxur5ntiuoByCqYSgtrEbw`
📊 [View on Solscan](https://solscan.io/account/3TNdmF3EC9yrJjm5fxfFrrBxur5ntiuoByCqYSgtrEbw?cluster=devnet)

Unified program (32.9% smaller, 33% cheaper to deploy).

> 📄 See [PROGRAM_IDS.md](./PROGRAM_IDS.md) for complete details.

---

### Account Structure: AgentRegistry

```rust
pub struct AgentRegistry {
    pub version: u8,
    pub creator: Pubkey,      // Immutable, used in PDA seeds
    pub owner: Pubkey,        // Mutable, can be transferred
    pub memory_mode: u8,      // 0=None, 1=CID, 2=IPFS, 3=URL
    pub memory_ptr_len: u8,
    pub memory_ptr: [u8; 96],
    pub memory_hash: [u8; 32],
    pub card_uri_len: u8,
    pub card_uri: [u8; 96],   // REQUIRED: https:// or ipfs://
    pub card_hash: [u8; 32],  // REQUIRED: SHA3-256 hash
    pub flags: u32,           // bit 0=ACTIVE, bit 1=LOCKED, bit 2=HAS_STAKING
    pub bump: u8,
}
```

**Size**: 8 + 277 bytes = 285 bytes  
**Rent cost**: ~0.002 SOL

### Validation & Security
- card_uri must be `https://` or `ipfs://` and ≤ 96 bytes.
- Memory Url mode: pointer must be valid UTF‑8 and start with `https://`.
- Memory None mode: pointer is cleared (len=0) and buffer zero‑filled to avoid leaking previous bytes.
- Length limits enforced for all fixed-size fields.

### Instructions
1) create_agent(agent_wallet, card_uri_opt, card_hash_opt)
   - Creates PDA: seeds ["agent", agent_wallet].
   - Initializes fields and optionally sets the card.
   - Accounts: [agent (init, seeds), admin (signer, payer), system_program]

2) set_card(card_uri, card_hash)
   - Updates card URI and 32-byte hash.
   - URI must be `https://` or `ipfs://`.
   - Accounts: [agent (mut, seeds), admin (signer, has_one)]

3) set_memory(mode, ptr: bytes, hash_opt: Option<[u8;32]>)
   - Truth table:
     - None: ptr empty, hash_opt None/zero. Zero‑fills memory_ptr.
     - Cid: ptr non-empty (e.g., CID string bytes), no hash.
     - Ipns/Manifest/Url: ptr non-empty, requires non-zero hash.
     - Url: ptr must be UTF‑8 and start with `https://`.
   - Accounts: [agent (mut, seeds), admin (signer, has_one)]

4) lock_memory()
   - Sets LOCKED bit. Irreversible.
   - Accounts: [agent (mut, seeds), admin (signer, has_one)]

5) set_active(is_active)
   - Toggles ACTIVE bit.
   - Accounts: [agent (mut, seeds), admin (signer, has_one)]

6) transfer_admin(new_admin)
   - Updates admin pubkey.
   - Accounts: [agent (mut, seeds), admin (signer, has_one)]

7) close_agent()
   - Closes the account if not ACTIVE and no staking.
   - Accounts: [agent (mut, seeds, close=recipient), admin (signer, has_one), recipient, system_program]

### Errors
- AdminRequired (6000)
- InvalidLength (6001)
- InvalidMemoryFields (6002)
- MemoryLocked (6003)
- AgentActive (6004)
- StakingEnabled (6005)
- InsecureUrl (6006) — used also for disallowed schemes
- AlreadyInitialized (6007)

### Events
- AgentCreated { agent_wallet }
- CardSet { agent_wallet, card_uri, card_hash }
- MemoryUpdated { agent_wallet, mode, ptr_preview, hash }
- MemoryLocked { agent_wallet }
- AgentActiveSet { agent_wallet, is_active }
- AgentClosed { agent_wallet }
- AdminTransferred { agent_wallet, new_admin }

---

## 📚 Usage Examples

### Use Case 1: Registering a Trading AI Agent

```typescript
import * as anchor from "@coral-xyz/anchor";
import { web3, Program } from "@coral-xyz/anchor";
import { AgentRegistry } from "../target/types/agent_registry";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.agentRegistry as Program<AgentRegistry>;

// Step 1: Create agent identity
const agentWallet = web3.Keypair.generate().publicKey;
const [agentPda] = web3.PublicKey.findProgramAddressSync(
  [Buffer.from("agent"), agentWallet.toBuffer()],
  program.programId
);

// Step 2: Register agent with metadata card
const cardUri = "https://storage.example.com/trading-agent-card.json";
const cardHash = new Uint8Array(32); // SHA3-256 of the card JSON
await program.methods
  .createAgent(agentWallet, cardUri, Array.from(cardHash))
  .accountsPartial({
    agent: agentPda,
    admin: provider.wallet.publicKey
  })
  .rpc();

console.log("Trading agent registered:", agentPda.toString());

// Step 3: Set agent memory (e.g., model configuration, trading strategy)
const memoryUrl = "https://storage.example.com/agent-memory/v1.json";
const memoryPtr = Buffer.from(new TextEncoder().encode(memoryUrl));
const memoryHash = new Uint8Array(32).fill(1); // SHA3-256 of memory content

await program.methods
  .setMemory(3, memoryPtr, Array.from(memoryHash)) // Mode 3 = URL
  .accountsPartial({
    agent: agentPda,
    admin: provider.wallet.publicKey
  })
  .rpc();

console.log("Agent memory configured");

// Step 4: Activate agent
await program.methods
  .setActive(true)
  .accountsPartial({
    agent: agentPda,
    admin: provider.wallet.publicKey
  })
  .rpc();

console.log("Trading agent is now active!");
```

### Use Case 2: Versioning Agent Memory with IPFS

```typescript
// Update agent to new memory version using IPFS
const ipfsCid = "QmT5NvUtoM5nWFfrQdVrFtvGfKFmG7AHE8P34isapyhCxX";
const memoryPtr = Buffer.from(new TextEncoder().encode(ipfsCid));

// Mode 1 = CID (no hash required for IPFS CIDs)
await program.methods
  .setMemory(1, memoryPtr, null)
  .accountsPartial({
    agent: agentPda,
    admin: provider.wallet.publicKey
  })
  .rpc();

console.log("Agent memory updated to IPFS CID:", ipfsCid);

// Lock memory to make it immutable
await program.methods
  .lockMemory()
  .accountsPartial({
    agent: agentPda,
    admin: provider.wallet.publicKey
  })
  .rpc();

console.log("Agent memory is now permanently locked");
```

### Use Case 3: Transferring Agent Ownership

```typescript
// Transfer agent admin rights to a new owner
const newOwner = new web3.PublicKey("NewOwnerPublicKeyHere...");

await program.methods
  .transferAdmin(newOwner)
  .accountsPartial({
    agent: agentPda,
    admin: provider.wallet.publicKey
  })
  .rpc();

console.log("Agent ownership transferred to:", newOwner.toString());
```

### Use Case 4: Fetching and Reading Agent Data

```typescript
// Fetch agent account data
const agentAccount = await program.account.agentRegistry.fetch(agentPda);

console.log("Agent Info:");
console.log("- Creator:", agentAccount.creator.toString());
console.log("- Owner:", agentAccount.owner.toString());
console.log("- Active:", (agentAccount.flags & 1) === 1);
console.log("- Locked:", (agentAccount.flags & 2) === 2);
console.log("- Memory Mode:", agentAccount.memoryMode);

// Decode memory pointer
const memoryPtrBytes = agentAccount.memoryPtr.slice(0, agentAccount.memoryPtrLen);
const memoryPtrString = new TextDecoder().decode(memoryPtrBytes);
console.log("- Memory Pointer:", memoryPtrString);

// Decode card URI
const cardUriBytes = agentAccount.cardUri.slice(0, agentAccount.cardUriLen);
const cardUriString = new TextDecoder().decode(cardUriBytes);
console.log("- Card URI:", cardUriString);
```

### Use Case 5: Decommissioning an Agent

```typescript
// Deactivate agent first
await program.methods
  .setActive(false)
  .accountsPartial({
    agent: agentPda,
    admin: provider.wallet.publicKey
  })
  .rpc();

// Close agent account and reclaim rent
const recipientWallet = provider.wallet.publicKey;
await program.methods
  .closeAgent()
  .accountsPartial({
    agent: agentPda,
    admin: provider.wallet.publicKey,
    recipient: recipientWallet
  })
  .rpc();

console.log("Agent decommissioned, rent reclaimed");
```

### Use Case 6: Batch Agent Operations

```typescript
// Register multiple agents in parallel
const agentWallets = [
  web3.Keypair.generate().publicKey,
  web3.Keypair.generate().publicKey,
  web3.Keypair.generate().publicKey
];

const createPromises = agentWallets.map(async (wallet) => {
  const [pda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), wallet.toBuffer()],
    program.programId
  );

  return program.methods
    .createAgent(
      wallet,
      `https://storage.example.com/agents/${wallet.toString()}.json`,
      Array.from(new Uint8Array(32))
    )
    .accountsPartial({
      agent: pda,
      admin: provider.wallet.publicKey
    })
    .rpc();
});

await Promise.all(createPromises);
console.log(`${agentWallets.length} agents registered successfully`);
```

---

### Local Build & Test
```bash
anchor build
anchor test
```

### Deploy (Devnet)
```bash
anchor build
anchor deploy --provider.cluster devnet
```
Ensure your wallet has SOL and `declare_id!` matches the deployed address.

### TypeScript Examples

Derive PDA and create agent:
```ts
import * as anchor from "@coral-xyz/anchor";
import { web3, Program } from "@coral-xyz/anchor";
import { AgentRegistry } from "../target/types/agent_registry";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.agentRegistry as Program<AgentRegistry>;

const agentWallet = web3.Keypair.generate().publicKey;
const [agentPda] = web3.PublicKey.findProgramAddressSync(
  [Buffer.from("agent"), agentWallet.toBuffer()],
  program.programId
);

await program.methods
  .createAgent(agentWallet, "https://example.com/card.json", Array.from(new Uint8Array(32)))
  .accountsPartial({ agent: agentPda, admin: provider.wallet.publicKey })
  .rpc();
```

Set memory to Url with hash:
```ts
const ptr = Buffer.from(new TextEncoder().encode("https://host/manifest.json"));
const hash = new Uint8Array(32).fill(7);
await program.methods
  .setMemory(3, ptr, Array.from(hash))
  .accountsPartial({ agent: agentPda, admin: provider.wallet.publicKey })
  .rpc();
```

Lock memory and deactivate:
```ts
await program.methods.lockMemory().accountsPartial({ agent: agentPda, admin: provider.wallet.publicKey }).rpc();
await program.methods.setActive(false).accountsPartial({ agent: agentPda, admin: provider.wallet.publicKey }).rpc();
```

Close agent:
```ts
await program.methods
  .closeAgent()
  .accountsPartial({ agent: agentPda, admin: provider.wallet.publicKey, recipient: provider.wallet.publicKey })
  .rpc();
```

### License
MIT


