use anchor_lang::prelude::*;
#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;

declare_id!("25wEsSLdsmZUisXuciyUXZqbpocsk5CJ7Uf6Eq553N8r");

// security.txt metadata (visible in explorer tools supporting solana-security-txt)
#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "Solana Agent Registry",
    project_url: "https://qnt.sh",
    contacts: "email:contac@ppline.app,link:https://github.com/QuantumAgentic/solana-agent-registry",
    policy: "https://github.com/QuantumAgentic/solana-agent-registry/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/QuantumAgentic/solana-agent-registry",
    source_revision: "",
    source_release: "",
    auditors: "None"
}

// Flags (pub pour CPI)
pub const FLAG_ACTIVE: u32 = 1 << 0;
pub const FLAG_LOCKED: u32 = 1 << 1;
pub const FLAG_HAS_STAKING: u32 = 1 << 2;

// Fixed account size (without the 8-byte discriminator)
// Layout: version(1) + creator(32) + owner(32) + memory_mode(1) + memory_ptr_len(1) 
//         + memory_ptr(96) + memory_hash(32) + card_uri_len(1) + card_uri(96) 
//         + card_hash(32) + flags(4) + bump(1) + _padding(7) = 336 bytes
const AGENT_REGISTRY_SPACE: usize = 336;
const MAX_URI: usize = 96;
const MAX_CID_LEN: usize = 96; // reuse same cap as ptr buffer
 

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MemoryMode {
    None = 0,
    Cid = 1,
    Ipns = 2,
    Url = 3,
    Manifest = 4,
}

#[program]
pub mod agent_registry {
    use super::*;

    // Create an agent PDA: seeds = ["agent", creator]
    // creator = immutable (PDA seed), owner = mutable (control)
    // Card (uri + hash) is REQUIRED - every agent must have identity
    // has_staking defaults to true
    // memory can be set at creation (optional)
    pub fn create_agent(
        ctx: Context<CreateAgent>,
        creator: Pubkey,
        card_uri: String,           // ✅ OBLIGATOIRE
        card_hash: [u8; 32],        // ✅ OBLIGATOIRE
        has_staking: Option<bool>,  // ✅ OPTIONNEL (default = true)
        memory_mode: Option<u8>,    // ✅ OPTIONNEL: memory mode (None, CID, IPFS, URL)
        memory_ptr: Option<Vec<u8>>,// ✅ OPTIONNEL: memory pointer (CID, URL, etc.)
        memory_hash: Option<[u8; 32]>, // ✅ OPTIONNEL: memory content hash
    ) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        agent.version = 1;
        agent.creator = creator;    // Immutable: used in PDA seeds
        agent.owner = creator;      // Mutable: initially = creator, can be transferred
        
        // Memory: optionnel, peut être défini à la création
        if let Some(mode) = memory_mode {
            if let Some(ptr) = &memory_ptr {
                // Validate memory parameters
                require!(ptr.len() > 0 && ptr.len() <= MAX_CID_LEN, AgentError::InvalidLength);
                
                // Validate mode value (0=None, 1=CID, 2=IPFS, 3=URL)
                require!(mode <= 3, AgentError::InvalidMemoryFields);
                
                // Validate URL scheme for URL mode (3)
                if mode == MemoryMode::Url as u8 {
                    let url_str = core::str::from_utf8(ptr).map_err(|_| AgentError::InvalidMemoryFields)?;
                    require!(url_str.starts_with("https://"), AgentError::InsecureUrl);
                }
                
                agent.memory_mode = mode;
                agent.memory_ptr_len = ptr.len() as u8;
                write_fixed(&mut agent.memory_ptr, ptr);
                agent.memory_hash = memory_hash.unwrap_or([0u8; 32]);
            } else {
                // Mode provided but no pointer → invalid
                return Err(AgentError::InvalidMemoryFields.into());
            }
        } else {
            // No memory: default None
            agent.memory_mode = MemoryMode::None as u8;
            agent.memory_ptr_len = 0;
            agent.memory_ptr = [0u8; 96];
            agent.memory_hash = [0u8; 32];
        }
        
        // Card: OBLIGATOIRE (identité de l'agent)
        let bytes = card_uri.as_bytes();
        require!(bytes.len() > 0 && bytes.len() <= MAX_URI, AgentError::InvalidLength);
        // Allow only https:// or ipfs:// schemes for card_uri
        let ok_scheme = card_uri.starts_with("https://") || card_uri.starts_with("ipfs://");
        require!(ok_scheme, AgentError::InsecureUrl);
        agent.card_uri_len = bytes.len() as u8;
        write_fixed(&mut agent.card_uri, bytes);
        agent.card_hash = card_hash;
        
        // Flags: Active + has_staking (default true)
        agent.flags = FLAG_ACTIVE;
        if has_staking.unwrap_or(true) {  // Default = true
            agent.flags |= FLAG_HAS_STAKING;
        }
        
        agent.bump = ctx.bumps.agent;
        agent._padding = [0u8; 7];
        emit!(AgentCreated { creator, owner: creator });
        Ok(())
    }

    // Update card (URI + hash).
    pub fn set_card(ctx: Context<UpdateAgent>, card_uri: String, card_hash: [u8; 32]) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        let bytes = card_uri.as_bytes();
        require!(bytes.len() > 0 && bytes.len() <= MAX_URI, AgentError::InvalidLength);
        // Allow only https:// or ipfs:// schemes for card_uri
        let ok_scheme = card_uri.starts_with("https://") || card_uri.starts_with("ipfs://");
        require!(ok_scheme, AgentError::InsecureUrl);
        agent.card_uri_len = bytes.len() as u8;
        write_fixed(&mut agent.card_uri, bytes);
        agent.card_hash = card_hash;
        let preview = preview_str(bytes);
        emit!(CardSet {
            creator: agent.creator,
            card_uri: preview,
            card_hash,
        });
        Ok(())
    }

    // Update memory (mode + pointer + hash according to truth table).
    pub fn set_memory(
        ctx: Context<UpdateAgent>,
        mode: u8,
        ptr: Vec<u8>,
        hash_opt: Option<[u8; 32]>,
    ) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        require!(agent.flags & FLAG_LOCKED == 0, AgentError::MemoryLocked);
        require!(ptr.len() <= 96, AgentError::InvalidLength);

        let mode = match mode {
            0 => MemoryMode::None,
            1 => MemoryMode::Cid,
            2 => MemoryMode::Ipns,
            3 => MemoryMode::Url,
            4 => MemoryMode::Manifest,
            _ => return err!(AgentError::InvalidMemoryFields),
        };

        let zero = [0u8; 32];
        match mode {
            MemoryMode::None => {
                require!(ptr.is_empty(), AgentError::InvalidMemoryFields);
                require!(hash_opt.unwrap_or(zero) == zero, AgentError::InvalidMemoryFields);
                agent.memory_hash = zero;
                agent.memory_ptr_len = 0;
                agent.memory_ptr = [0u8; 96];
            }
            MemoryMode::Cid => {
                require!(!ptr.is_empty(), AgentError::InvalidMemoryFields);
                require!(hash_opt.unwrap_or(zero) == zero, AgentError::InvalidMemoryFields);
                // Basic CID shape validation (CIDv1 base32 lowercase or CIDv0 base58btc)
                // - v1: starts with "bafy", base32 [a-z2-7]
                // - v0: starts with "Qm", base58btc [1-9A-HJ-NP-Za-km-z]
                let is_cid_like = {
                    if let Ok(s) = core::str::from_utf8(&ptr) {
                        let bytes_ok = s.len() > 0 && s.len() <= MAX_CID_LEN;
                        if s.starts_with("bafy") {
                            bytes_ok && s.chars().all(|c| matches!(c, 'a'..='z' | '2'..='7'))
                        } else if s.starts_with("Qm") {
                            bytes_ok && s.chars().all(|c| match c {
                                '1'..='9' | 'A'..='H' | 'J'..='N' | 'P'..='Z' | 'a'..='k' | 'm'..='z' => true,
                                _ => false,
                            }) && s.len() == 46
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                };
                require!(is_cid_like, AgentError::InvalidMemoryFields);
                agent.memory_hash = zero;
            }
            MemoryMode::Ipns | MemoryMode::Manifest | MemoryMode::Url => {
                require!(!ptr.is_empty(), AgentError::InvalidMemoryFields);
                let h = hash_opt.ok_or(AgentError::InvalidMemoryFields)?;
                require!(h != zero, AgentError::InvalidMemoryFields);
                if let MemoryMode::Url = mode {
                    // Validate UTF-8 and enforce https:// scheme strictly
                    let s = core::str::from_utf8(&ptr).map_err(|_| error!(AgentError::InvalidMemoryFields))?;
                    require!(s.starts_with("https://"), AgentError::InsecureUrl);
                }
                agent.memory_hash = h;
            }
        }

        agent.memory_mode = mode as u8;
        if !matches!(mode, MemoryMode::None) {
            agent.memory_ptr_len = ptr.len() as u8;
            write_fixed(&mut agent.memory_ptr, &ptr);
        }

        let preview = preview_str(&ptr);
        emit!(MemoryUpdated {
            creator: agent.creator,
            mode: mode as u8,
            ptr_preview: preview,
            hash: agent.memory_hash,
        });
        Ok(())
    }

    // Permanently lock memory.
    pub fn lock_memory(ctx: Context<UpdateAgent>) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        agent.flags |= FLAG_LOCKED;
        emit!(MemoryLocked { creator: agent.creator });
        Ok(())
    }

    // Toggle the ACTIVE flag.
    pub fn set_active(ctx: Context<UpdateAgent>, is_active: bool) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        if is_active {
            agent.flags |= FLAG_ACTIVE;
        } else {
            agent.flags &= !FLAG_ACTIVE;
        }
        emit!(AgentActiveSet { creator: agent.creator, is_active });
        Ok(())
    }

    // Close the account if inactive and without staking; reclaim rent.
    pub fn close_agent(ctx: Context<CloseAgent>) -> Result<()> {
        let agent = &ctx.accounts.agent;
        require!(agent.flags & FLAG_ACTIVE == 0, AgentError::AgentActive);
        require!(agent.flags & FLAG_HAS_STAKING == 0, AgentError::StakingEnabled);
        emit!(AgentClosed { creator: agent.creator });
        Ok(())
    }

    // Transfer ownership to a new owner (creator remains immutable)
    pub fn transfer_owner(ctx: Context<UpdateAgent>, new_owner: Pubkey) -> Result<()> {
        require!(new_owner != Pubkey::default(), AgentError::InvalidOwner);
        let agent = &mut ctx.accounts.agent;
        let old_owner = agent.owner;
        agent.owner = new_owner;
        emit!(OwnerTransferred { creator: agent.creator, old_owner, new_owner });
        Ok(())
    }
}

// Accounts
#[derive(Accounts)]
#[instruction(creator: Pubkey)]
pub struct CreateAgent<'info> {
    #[account(
        init,
        payer = creator_signer,
        space = 8 + AGENT_REGISTRY_SPACE,
        seeds = [b"agent", creator.as_ref()],
        bump
    )]
    pub agent: Account<'info, AgentRegistry>,
    #[account(
        mut,
        constraint = creator_signer.key() == creator @ AgentError::Unauthorized
    )]
    pub creator_signer: Signer<'info>,  // Must be the creator (pays and signs)
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAgent<'info> {
    #[account(
        mut,
        seeds = [b"agent", agent.creator.as_ref()],
        bump = agent.bump,
        constraint = agent.owner == owner.key() @ AgentError::Unauthorized
    )]
    pub agent: Account<'info, AgentRegistry>,
    pub owner: Signer<'info>,  // Only the current owner can modify the agent
}

#[derive(Accounts)]
pub struct CloseAgent<'info> {
    #[account(
        mut,
        close = recipient,
        seeds = [b"agent", agent.creator.as_ref()],
        bump = agent.bump,
        constraint = agent.owner == owner.key() @ AgentError::Unauthorized
    )]
    pub agent: Account<'info, AgentRegistry>,
    pub owner: Signer<'info>,  // Only the current owner can close the agent
    /// CHECK: recipient receives lamports on close
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// Account data
// creator = immutable (used in PDA seeds)
// owner = mutable (can be transferred)
#[account]
pub struct AgentRegistry {
    pub version: u8,
    pub creator: Pubkey,  // Immutable: original creator (used in PDA seeds)
    pub owner: Pubkey,    // Mutable: current owner (can be transferred)
    pub memory_mode: u8,
    pub memory_ptr_len: u8,
    pub memory_ptr: [u8; 96],
    pub memory_hash: [u8; 32],
    pub card_uri_len: u8,
    pub card_uri: [u8; 96],
    pub card_hash: [u8; 32],
    pub flags: u32,
    pub bump: u8,
    pub _padding: [u8; 7],
}

// Events
#[event]
pub struct AgentCreated {
    pub creator: Pubkey,  // Immutable creator (PDA seed)
    pub owner: Pubkey,    // Initial owner (= creator)
}

#[event]
pub struct CardSet {
    pub creator: Pubkey,
    pub card_uri: String,
    pub card_hash: [u8; 32],
}

#[event]
pub struct MemoryUpdated {
    pub creator: Pubkey,
    pub mode: u8,
    pub ptr_preview: String,
    pub hash: [u8; 32],
}

#[event]
pub struct MemoryLocked {
    pub creator: Pubkey,
}

#[event]
pub struct AgentActiveSet {
    pub creator: Pubkey,
    pub is_active: bool,
}

#[event]
pub struct AgentClosed {
    pub creator: Pubkey,
}

#[event]
pub struct OwnerTransferred {
    pub creator: Pubkey,   // Immutable creator
    pub old_owner: Pubkey,
    pub new_owner: Pubkey,
}

// Errors
#[error_code]
pub enum AgentError {
    #[msg("Only the owner can modify their agent")]
    Unauthorized,
    #[msg("Admin signature required")]
    AdminRequired,
    #[msg("Invalid owner address")]
    InvalidOwner,
    #[msg("Invalid length")]
    InvalidLength,
    #[msg("Invalid memory mode/fields")]
    InvalidMemoryFields,
    #[msg("Memory is locked")]
    MemoryLocked,
    #[msg("Agent is still active")]
    AgentActive,
    #[msg("Staking is enabled, cannot close")]
    StakingEnabled,
    #[msg("URI must be https:// for Url mode")]
    InsecureUrl,
    #[msg("Account already initialized")]
    AlreadyInitialized,
}

// Helpers
fn write_fixed<const N: usize>(dst: &mut [u8; N], src: &[u8]) {
    let len = core::cmp::min(N, src.len());
    dst[..len].copy_from_slice(&src[..len]);
    if len < N {
        for b in &mut dst[len..] {
            *b = 0;
        }
    }
}

fn preview_str(bytes: &[u8]) -> String {
    let take = core::cmp::min(32, bytes.len());
    String::from_utf8_lossy(&bytes[..take]).to_string()
}
