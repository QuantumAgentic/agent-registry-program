## Agent Registry & Staking Programs

Solana smart contracts for managing on-chain AI Agent metadata and token staking.

**🌐 Network**: Currently deployed on **Devnet**

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

### 🏗️ Account Structure: AgentRegistry

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


