# 🔑 Program IDs

This document lists all program IDs for the Agent Registry ecosystem.

## Programs

### Agent Registry
**Program ID**: `25wEsSLdsmZUisXuciyUXZqbpocsk5CJ7Uf6Eq553N8r`

**Description**: Core agent registry program for managing on-chain AI agent metadata.

**Features**:
- Create agent accounts (PDA derived from `["agent", creator]`)
- Set card URI and hash
- Manage memory (CID, IPFS, URL, Manifest)
- Toggle agent active status
- Lock memory (irreversible)
- Transfer ownership
- Close agent account (when inactive and no staking)

**Deployed on**:
- ✅ Localnet
- ✅ Devnet

---

### Agent Staking
**Program ID**: `j3WMvorrddakwt69dqrQ5cve5APpyd4bxUCb9UF9Aqj`

**Description**: Staking program for agent tokens with linear decaying unstake fees.

**Features**:
- Create staking pools for agents
- Initialize stake accounts
- Stake SPL tokens
- Withdraw stakes with time-based fees
- Update minimum stake amounts
- Fee model: linear decay from `fee_immediate` to `fee_regular` over `decay_duration`

**Deployed on**:
- ✅ Localnet
- ✅ Devnet

---

### Agent Platform (Merged)
**Program ID**: `3TNdmF3EC9yrJjm5fxfFrrBxur5ntiuoByCqYSgtrEbw`

**Description**: Unified program combining agent-registry and agent-staking functionality.

**Benefits**:
- 32.9% smaller binary size vs separate programs
- 33% lower deployment costs
- Single program for atomic operations
- No CPI overhead between registry and staking

**Deployed on**:
- ✅ Localnet
- ✅ Devnet

---

## SDK Configuration

The SDK uses these program IDs by default:

```typescript
import { AGENT_PROGRAM_ID, AGENT_STAKING_PROGRAM_ID } from "@pipeline/agent-registry-sdk";

console.log(AGENT_PROGRAM_ID.toBase58());
// => 25wEsSLdsmZUisXuciyUXZqbpocsk5CJ7Uf6Eq553N8r

console.log(AGENT_STAKING_PROGRAM_ID.toBase58());
// => j3WMvorrddakwt69dqrQ5cve5APpyd4bxUCb9UF9Aqj
```

You can override these by passing `programId` or `stakingProgramId` parameters to SDK functions.

---

## Verification

To verify program IDs on-chain:

```bash
# Check agent-registry
solana program show 25wEsSLdsmZUisXuciyUXZqbpocsk5CJ7Uf6Eq553N8r --url devnet

# Check agent-staking
solana program show j3WMvorrddakwt69dqrQ5cve5APpyd4bxUCb9UF9Aqj --url devnet

# Check agent-platform
solana program show 3TNdmF3EC9yrJjm5fxfFrrBxur5ntiuoByCqYSgtrEbw --url devnet
```

---

## Anchor.toml

The program IDs are declared in `Anchor.toml`:

```toml
[programs.localnet]
agent_registry = "25wEsSLdsmZUisXuciyUXZqbpocsk5CJ7Uf6Eq553N8r"
agent_staking = "j3WMvorrddakwt69dqrQ5cve5APpyd4bxUCb9UF9Aqj"
agent_platform = "3TNdmF3EC9yrJjm5fxfFrrBxur5ntiuoByCqYSgtrEbw"
```

And in the Rust source code with `declare_id!` macro:

- `programs/agent-registry/src/lib.rs:5`
- `programs/agent-staking/src/lib.rs:7`
- `programs/agent-platform/src/lib.rs:6`

---

## Last Updated

**Date**: October 10, 2025  
**Version**: v1.0.0

