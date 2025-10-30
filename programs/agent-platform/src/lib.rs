use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, Transfer};
use anchor_lang::solana_program;
use anchor_lang::solana_program::system_instruction;

declare_id!("3TNdmF3EC9yrJjm5fxfFrrBxur5ntiuoByCqYSgtrEbw");

// ============================================================================
// CONSTANTS & ENUMS
// ============================================================================

// Flags
pub const FLAG_ACTIVE: u32 = 1 << 0;
pub const FLAG_LOCKED: u32 = 1 << 1;
pub const FLAG_HAS_STAKING: u32 = 1 << 2;

const AGENT_REGISTRY_SPACE: usize = 336;
const MAX_URI: usize = 96;
const MAX_CID_LEN: usize = 96;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MemoryMode {
    None = 0,
    Cid = 1,
    Ipns = 2,
    Url = 3,
    Manifest = 4,
}

// ============================================================================
// PROGRAM
// ============================================================================

#[program]
pub mod agent_platform {
    use super::*;

    // ========================================================================
    // AGENT REGISTRY INSTRUCTIONS
    // ========================================================================

    pub fn create_agent(
        ctx: Context<CreateAgent>,
        creator: Pubkey,
        card_uri: String,
        card_hash: [u8; 32],
        has_staking: Option<bool>,
        memory_mode: Option<u8>,
        memory_ptr: Option<Vec<u8>>,
        memory_hash: Option<[u8; 32]>,
    ) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        agent.version = 1;
        agent.creator = creator;
        agent.owner = creator;
        
        // Memory (optional)
        if let Some(mode) = memory_mode {
            if let Some(ptr) = &memory_ptr {
                require!(ptr.len() > 0 && ptr.len() <= MAX_CID_LEN, PlatformError::InvalidLength);
                require!(mode <= 3, PlatformError::InvalidMemoryFields);
                
                if mode == MemoryMode::Url as u8 {
                    let url_str = core::str::from_utf8(ptr).map_err(|_| PlatformError::InvalidMemoryFields)?;
                    require!(url_str.starts_with("https://"), PlatformError::InsecureUrl);
                }
                
                agent.memory_mode = mode;
                agent.memory_ptr_len = ptr.len() as u8;
                write_fixed(&mut agent.memory_ptr, ptr);
                agent.memory_hash = memory_hash.unwrap_or([0u8; 32]);
            } else {
                return Err(PlatformError::InvalidMemoryFields.into());
            }
        } else {
            agent.memory_mode = MemoryMode::None as u8;
            agent.memory_ptr_len = 0;
            agent.memory_ptr = [0u8; 96];
            agent.memory_hash = [0u8; 32];
        }
        
        // Card (mandatory)
        let bytes = card_uri.as_bytes();
        require!(bytes.len() > 0 && bytes.len() <= MAX_URI, PlatformError::InvalidLength);
        let ok_scheme = card_uri.starts_with("https://") || card_uri.starts_with("ipfs://");
        require!(ok_scheme, PlatformError::InsecureUrl);
        agent.card_uri_len = bytes.len() as u8;
        write_fixed(&mut agent.card_uri, bytes);
        agent.card_hash = card_hash;
        
        // Flags
        agent.flags = FLAG_ACTIVE;
        if has_staking.unwrap_or(true) {
            agent.flags |= FLAG_HAS_STAKING;
        }
        
        agent.bump = ctx.bumps.agent;
        agent._padding = [0u8; 7];
        emit!(AgentCreated { creator, owner: creator });
        Ok(())
    }

    pub fn set_card(ctx: Context<UpdateAgent>, card_uri: String, card_hash: [u8; 32]) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        let bytes = card_uri.as_bytes();
        require!(bytes.len() > 0 && bytes.len() <= MAX_URI, PlatformError::InvalidLength);
        let ok_scheme = card_uri.starts_with("https://") || card_uri.starts_with("ipfs://");
        require!(ok_scheme, PlatformError::InsecureUrl);
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

    pub fn set_memory(
        ctx: Context<UpdateAgent>,
        mode: u8,
        ptr: Vec<u8>,
        hash_opt: Option<[u8; 32]>,
    ) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        require!(agent.flags & FLAG_LOCKED == 0, PlatformError::MemoryLocked);
        require!(ptr.len() <= 96, PlatformError::InvalidLength);

        let mode = match mode {
            0 => MemoryMode::None,
            1 => MemoryMode::Cid,
            2 => MemoryMode::Ipns,
            3 => MemoryMode::Url,
            4 => MemoryMode::Manifest,
            _ => return err!(PlatformError::InvalidMemoryFields),
        };

        let zero = [0u8; 32];
        match mode {
            MemoryMode::None => {
                require!(ptr.is_empty(), PlatformError::InvalidMemoryFields);
                require!(hash_opt.unwrap_or(zero) == zero, PlatformError::InvalidMemoryFields);
                agent.memory_hash = zero;
                agent.memory_ptr_len = 0;
                agent.memory_ptr = [0u8; 96];
            }
            MemoryMode::Cid => {
                require!(!ptr.is_empty(), PlatformError::InvalidMemoryFields);
                require!(hash_opt.unwrap_or(zero) == zero, PlatformError::InvalidMemoryFields);
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
                require!(is_cid_like, PlatformError::InvalidMemoryFields);
                agent.memory_hash = zero;
            }
            MemoryMode::Ipns | MemoryMode::Manifest | MemoryMode::Url => {
                require!(!ptr.is_empty(), PlatformError::InvalidMemoryFields);
                let h = hash_opt.ok_or(PlatformError::InvalidMemoryFields)?;
                require!(h != zero, PlatformError::InvalidMemoryFields);
                if let MemoryMode::Url = mode {
                    let s = core::str::from_utf8(&ptr).map_err(|_| error!(PlatformError::InvalidMemoryFields))?;
                    require!(s.starts_with("https://"), PlatformError::InsecureUrl);
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

    pub fn lock_memory(ctx: Context<UpdateAgent>) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        agent.flags |= FLAG_LOCKED;
        emit!(MemoryLocked { creator: agent.creator });
        Ok(())
    }

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

    pub fn close_agent(ctx: Context<CloseAgent>) -> Result<()> {
        let agent = &ctx.accounts.agent;
        require!(agent.flags & FLAG_ACTIVE == 0, PlatformError::AgentActive);
        require!(agent.flags & FLAG_HAS_STAKING == 0, PlatformError::StakingEnabled);
        emit!(AgentClosed { creator: agent.creator });
        Ok(())
    }

    pub fn transfer_owner(ctx: Context<UpdateAgent>, new_owner: Pubkey) -> Result<()> {
        require!(new_owner != Pubkey::default(), PlatformError::InvalidOwner);
        let agent = &mut ctx.accounts.agent;
        let old_owner = agent.owner;
        agent.owner = new_owner;
        emit!(OwnerTransferred { creator: agent.creator, old_owner, new_owner });
        Ok(())
    }

    // ========================================================================
    // STAKING INSTRUCTIONS
    // ========================================================================

    pub fn init_program_state(ctx: Context<InitProgramState>) -> Result<()> {
        let state = &mut ctx.accounts.program_state;
        state.fee_immediate_lamports = ProgramState::DEFAULT_IMMEDIATE_FEE;
        state.fee_regular_lamports = ProgramState::DEFAULT_REGULAR_FEE;
        state.fee_max_lamports = ProgramState::DEFAULT_MAX_FEE;
        state.decay_duration_seconds = ProgramState::DEFAULT_DECAY_DURATION;
        state.treasury = ctx.accounts.treasury.key();
        state.bump = ctx.bumps.program_state;
        Ok(())
    }

    pub fn create_staking_pool(ctx: Context<CreateStakingPool>, min_stake_amount: u64) -> Result<()> {
        require!(min_stake_amount > 0, PlatformError::InvalidMinStakeAmount);
        
        // Initialize token vault via CPI
        let pool_key = ctx.accounts.staking_pool.key();
        let seeds = &[b"token_vault", pool_key.as_ref(), &[ctx.bumps.token_vault]];
        let signer = &[&seeds[..]];
        
        let rent = &ctx.accounts.rent;
        let vault_rent = rent.minimum_balance(anchor_spl::token::TokenAccount::LEN);
        
        solana_program::program::invoke_signed(
            &system_instruction::create_account(
                ctx.accounts.owner.key,
                ctx.accounts.token_vault.key,
                vault_rent,
                165,
                ctx.accounts.token_program.key,
            ),
            &[
                ctx.accounts.owner.to_account_info(),
                ctx.accounts.token_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer,
        )?;
        
        let init_ix = anchor_spl::token::spl_token::instruction::initialize_account3(
            ctx.accounts.token_program.key,
            ctx.accounts.token_vault.key,
            ctx.accounts.token_mint.key,
            &ctx.accounts.staking_pool.key(),
        )?;
        
        solana_program::program::invoke(
            &init_ix,
            &[
                ctx.accounts.token_vault.to_account_info(),
                ctx.accounts.token_mint.to_account_info(),
            ],
        )?;
        
        let pool = &mut ctx.accounts.staking_pool;
        let clock = Clock::get()?;
        pool.agent_pda = ctx.accounts.agent.key();
        pool.owner = ctx.accounts.owner.key();
        pool.token_mint = ctx.accounts.token_mint.key();
        pool.token_vault = ctx.accounts.token_vault.key();
        pool.min_stake_amount = min_stake_amount;
        pool.total_staked = 0;
        pool.staker_count = 0;
        pool.created_at = clock.unix_timestamp;
        pool.flags = 1;
        pool.bump = ctx.bumps.staking_pool;
        emit!(PoolCreated { agent_pda: pool.agent_pda, owner: pool.owner, min_stake_amount });
        Ok(())
    }

    pub fn update_min_stake(ctx: Context<UpdateMinStake>, new_min_stake_amount: u64) -> Result<()> {
        require!(new_min_stake_amount > 0, PlatformError::InvalidMinStakeAmount);
        require_keys_eq!(ctx.accounts.staking_pool.owner, ctx.accounts.owner.key(), PlatformError::Unauthorized);
        let pool = &mut ctx.accounts.staking_pool;
        let old = pool.min_stake_amount;
        pool.min_stake_amount = new_min_stake_amount;
        emit!(MinStakeUpdated { agent_pda: pool.agent_pda, old_amount: old, new_amount: new_min_stake_amount });
        Ok(())
    }

    pub fn init_stake(ctx: Context<InitStake>) -> Result<()> {
        let pool = &ctx.accounts.staking_pool;
        let stake_acc = &mut ctx.accounts.stake_account;
        let clock = Clock::get()?;
        
        stake_acc.staker = ctx.accounts.staker.key();
        stake_acc.agent_pda = pool.agent_pda;
        stake_acc.staked_amount = 0;
        stake_acc.staked_at = clock.unix_timestamp;
        stake_acc.last_updated_at = clock.unix_timestamp;
        stake_acc.bump = ctx.bumps.stake_account;
        Ok(())
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, PlatformError::InvalidStakeAmount);
        let pool = &mut ctx.accounts.staking_pool;
        let stake_acc = &mut ctx.accounts.stake_account;
        let clock = Clock::get()?;

        // First-time stake: enforce min_stake
        if stake_acc.staked_amount == 0 {
            require!(amount >= pool.min_stake_amount, PlatformError::BelowMinimumStake);
            pool.staker_count = pool.staker_count.saturating_add(1);
        }

        require!(stake_acc.staker == ctx.accounts.staker.key(), PlatformError::Unauthorized);

        // SPL transfer: staker → vault
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.staker_token_account.to_account_info(),
                to: ctx.accounts.token_vault.to_account_info(),
                authority: ctx.accounts.staker.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, amount)?;

        stake_acc.staked_amount = stake_acc.staked_amount.saturating_add(amount);
        stake_acc.last_updated_at = clock.unix_timestamp;
        pool.total_staked = pool.total_staked.saturating_add(amount);

        emit!(Staked { staker: stake_acc.staker, agent_pda: pool.agent_pda, amount, total: stake_acc.staked_amount });
        Ok(())
    }

    pub fn withdraw_stake(ctx: Context<WithdrawStake>) -> Result<()> {
        let pool = &mut ctx.accounts.staking_pool;
        let state = &ctx.accounts.program_state;
        let stake_acc = &mut ctx.accounts.stake_account;
        let clock = Clock::get()?;

        require!(stake_acc.staked_amount > 0, PlatformError::NoStake);

        let elapsed = (clock.unix_timestamp - stake_acc.staked_at).max(0) as u64;
        let fee = calculate_unstake_fee(elapsed, state)?;

        // Check sufficient SOL before transfer
        if fee > 0 {
            let staker_lamports = ctx.accounts.staker.lamports();
            let rent_exempt = Rent::get()?.minimum_balance(0);
            
            require!(
                staker_lamports >= fee.saturating_add(rent_exempt),
                PlatformError::InsufficientSolForFee
            );
            
            let ix = anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.staker.key(),
                &state.treasury,
                fee,
            );
            anchor_lang::solana_program::program::invoke(
                &ix,
                &[
                    ctx.accounts.staker.to_account_info(),
                    ctx.accounts.treasury.to_account_info(),
                ],
            )?;
        }

        // SPL transfer: vault → staker (PDA must sign)
        let amount = stake_acc.staked_amount;
        let agent_pda = pool.agent_pda;
        let seeds = &[
            b"staking_pool",
            agent_pda.as_ref(),
            &[pool.bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.token_vault.to_account_info(),
                to: ctx.accounts.staker_token_account.to_account_info(),
                authority: pool.to_account_info(),
            },
            signer,
        );
        token::transfer(cpi_ctx, amount)?;

        // Reset stake amount but preserve staked_at
        stake_acc.staked_amount = 0;
        stake_acc.last_updated_at = clock.unix_timestamp;
        
        pool.total_staked = pool.total_staked.saturating_sub(amount);

        emit!(Withdrawn { staker: stake_acc.staker, agent_pda: pool.agent_pda, amount, fee });
        Ok(())
    }
}

// ============================================================================
// CONTEXTS
// ============================================================================

// Agent Registry Contexts

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
        constraint = creator_signer.key() == creator @ PlatformError::Unauthorized
    )]
    pub creator_signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAgent<'info> {
    #[account(
        mut,
        seeds = [b"agent", agent.creator.as_ref()],
        bump = agent.bump,
        constraint = agent.owner == owner.key() @ PlatformError::Unauthorized
    )]
    pub agent: Account<'info, AgentRegistry>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseAgent<'info> {
    #[account(
        mut,
        close = recipient,
        seeds = [b"agent", agent.creator.as_ref()],
        bump = agent.bump,
        constraint = agent.owner == owner.key() @ PlatformError::Unauthorized
    )]
    pub agent: Account<'info, AgentRegistry>,
    pub owner: Signer<'info>,
    /// CHECK: recipient receives lamports on close
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// Staking Contexts

#[derive(Accounts)]
pub struct InitProgramState<'info> {
    #[account(
        init,
        payer = initializer,
        space = 8 + ProgramState::SPACE,
        seeds = [b"program_state"],
        bump
    )]
    pub program_state: Account<'info, ProgramState>,
    #[account(mut)]
    pub initializer: Signer<'info>,
    /// CHECK: treasury system account
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateStakingPool<'info> {
    // No more CPI validation, agent is in the same program!
    #[account(
        constraint = agent.flags & FLAG_HAS_STAKING != 0 @ PlatformError::StakingNotEnabled,
        seeds = [b"agent", agent.creator.as_ref()],
        bump = agent.bump
    )]
    pub agent: Account<'info, AgentRegistry>,
    #[account(
        init,
        payer = owner,
        space = 8 + StakingPool::SPACE,
        seeds = [b"staking_pool", agent.key().as_ref()],
        bump
    )]
    pub staking_pool: Account<'info, StakingPool>,
    /// CHECK: Token vault PDA
    #[account(
        mut,
        seeds = [b"token_vault", staking_pool.key().as_ref()],
        bump
    )]
    pub token_vault: AccountInfo<'info>,
    /// CHECK: Token mint
    pub token_mint: AccountInfo<'info>,
    #[account(
        mut,
        constraint = owner.key() == agent.owner @ PlatformError::Unauthorized
    )]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct UpdateMinStake<'info> {
    #[account(
        mut,
        seeds = [b"staking_pool", staking_pool.agent_pda.as_ref()],
        bump = staking_pool.bump
    )]
    pub staking_pool: Account<'info, StakingPool>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitStake<'info> {
    #[account(
        seeds = [b"staking_pool", agent_pda.key().as_ref()],
        bump = staking_pool.bump
    )]
    pub staking_pool: Account<'info, StakingPool>,
    /// CHECK: agent pda
    pub agent_pda: UncheckedAccount<'info>,
    #[account(
        init,
        payer = staker,
        space = 8 + StakeAccount::SPACE,
        seeds = [b"stake_account", staker.key().as_ref(), agent_pda.key().as_ref()],
        bump
    )]
    pub stake_account: Account<'info, StakeAccount>,
    #[account(mut)]
    pub staker: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(
        mut,
        seeds = [b"staking_pool", agent_pda.key().as_ref()],
        bump = staking_pool.bump
    )]
    pub staking_pool: Account<'info, StakingPool>,
    /// CHECK: agent pda
    pub agent_pda: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"stake_account", staker.key().as_ref(), agent_pda.key().as_ref()],
        bump = stake_account.bump,
        constraint = stake_account.staker == staker.key() @ PlatformError::Unauthorized
    )]
    pub stake_account: Account<'info, StakeAccount>,
    /// CHECK: Token vault
    #[account(
        mut,
        constraint = token_vault.key() == staking_pool.token_vault @ PlatformError::InvalidVault
    )]
    pub token_vault: AccountInfo<'info>,
    /// CHECK: Staker's token account
    #[account(mut)]
    pub staker_token_account: AccountInfo<'info>,
    #[account(mut)]
    pub staker: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawStake<'info> {
    #[account(
        seeds = [b"program_state"],
        bump = program_state.bump
    )]
    pub program_state: Account<'info, ProgramState>,
    #[account(
        mut,
        seeds = [b"staking_pool", agent_pda.key().as_ref()],
        bump = staking_pool.bump
    )]
    pub staking_pool: Account<'info, StakingPool>,
    /// CHECK: agent pda
    pub agent_pda: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"stake_account", staker.key().as_ref(), agent_pda.key().as_ref()],
        bump = stake_account.bump,
        constraint = stake_account.staker == staker.key() @ PlatformError::Unauthorized
    )]
    pub stake_account: Account<'info, StakeAccount>,
    /// CHECK: Token vault
    #[account(
        mut,
        constraint = token_vault.key() == staking_pool.token_vault @ PlatformError::InvalidVault
    )]
    pub token_vault: AccountInfo<'info>,
    /// CHECK: Staker's token account
    #[account(mut)]
    pub staker_token_account: AccountInfo<'info>,
    #[account(mut)]
    pub staker: Signer<'info>,
    /// CHECK: treasury account
    #[account(mut, address = program_state.treasury)]
    pub treasury: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// ============================================================================
// ACCOUNT STRUCTS
// ============================================================================

#[account]
pub struct AgentRegistry {
    pub version: u8,
    pub creator: Pubkey,
    pub owner: Pubkey,
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

#[account]
pub struct ProgramState {
    pub fee_immediate_lamports: u64,
    pub fee_regular_lamports: u64,
    pub fee_max_lamports: u64,
    pub decay_duration_seconds: u32,
    pub treasury: Pubkey,
    pub bump: u8,
}

impl ProgramState {
    pub const SPACE: usize = 8 + 8 + 8 + 4 + 32 + 1;
    pub const DEFAULT_IMMEDIATE_FEE: u64 = 100_000_000;
    pub const DEFAULT_REGULAR_FEE: u64 = 1_000_000;
    pub const DEFAULT_MAX_FEE: u64 = 100_000_000;
    pub const DEFAULT_DECAY_DURATION: u32 = 86_400;
}

#[account]
pub struct StakingPool {
    pub agent_pda: Pubkey,
    pub owner: Pubkey,
    pub token_mint: Pubkey,
    pub token_vault: Pubkey,
    pub min_stake_amount: u64,
    pub total_staked: u64,
    pub staker_count: u32,
    pub created_at: i64,
    pub flags: u8,
    pub bump: u8,
}

impl StakingPool {
    pub const SPACE: usize = 32 + 32 + 32 + 32 + 8 + 8 + 4 + 8 + 1 + 1;
}

#[account]
pub struct StakeAccount {
    pub staker: Pubkey,
    pub agent_pda: Pubkey,
    pub staked_amount: u64,
    pub staked_at: i64,
    pub last_updated_at: i64,
    pub bump: u8,
}

impl StakeAccount {
    pub const SPACE: usize = 32 + 32 + 8 + 8 + 8 + 1;
}

// ============================================================================
// EVENTS
// ============================================================================

// Agent Events
#[event]
pub struct AgentCreated {
    pub creator: Pubkey,
    pub owner: Pubkey,
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
    pub creator: Pubkey,
    pub old_owner: Pubkey,
    pub new_owner: Pubkey,
}

// Staking Events
#[event]
pub struct PoolCreated {
    pub agent_pda: Pubkey,
    pub owner: Pubkey,
    pub min_stake_amount: u64,
}

#[event]
pub struct MinStakeUpdated {
    pub agent_pda: Pubkey,
    pub old_amount: u64,
    pub new_amount: u64,
}

#[event]
pub struct Staked {
    pub staker: Pubkey,
    pub agent_pda: Pubkey,
    pub amount: u64,
    pub total: u64,
}

#[event]
pub struct Withdrawn {
    pub staker: Pubkey,
    pub agent_pda: Pubkey,
    pub amount: u64,
    pub fee: u64,
}

// ============================================================================
// ERRORS
// ============================================================================

#[error_code]
pub enum PlatformError {
    // Agent errors
    #[msg("Only the owner can modify their agent")]
    Unauthorized,
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
    
    // Staking errors
    #[msg("Invalid minimum stake amount")]
    InvalidMinStakeAmount,
    #[msg("Invalid fee configuration")]
    InvalidFeeConfig,
    #[msg("Invalid stake amount")]
    InvalidStakeAmount,
    #[msg("No stake to withdraw")]
    NoStake,
    #[msg("Invalid token vault")]
    InvalidVault,
    #[msg("Stake amount below minimum required")]
    BelowMinimumStake,
    #[msg("Insufficient SOL to pay unstaking fee")]
    InsufficientSolForFee,
    #[msg("Agent does not have staking enabled")]
    StakingNotEnabled,
}

// ============================================================================
// HELPERS
// ============================================================================

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

fn calculate_unstake_fee(elapsed_secs: u64, state: &ProgramState) -> Result<u64> {
    require!(state.decay_duration_seconds > 0, PlatformError::InvalidFeeConfig);
    
    if elapsed_secs >= state.decay_duration_seconds as u64 {
        return Ok(state.fee_regular_lamports.min(state.fee_max_lamports));
    }
    
    let immediate = state.fee_immediate_lamports as u128;
    let regular = state.fee_regular_lamports as u128;
    let duration = state.decay_duration_seconds as u128;
    let elapsed = elapsed_secs as u128;
    let diff = immediate.saturating_sub(regular);
    
    let reduction = diff
        .saturating_mul(elapsed)
        .checked_div(duration)
        .ok_or(PlatformError::InvalidFeeConfig)?;
    
    let fee = immediate.saturating_sub(reduction);
    Ok(fee.min(state.fee_max_lamports as u128) as u64)
}
