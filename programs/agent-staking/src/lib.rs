use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, Transfer};
use agent_registry::{AgentRegistry, FLAG_HAS_STAKING};
use anchor_lang::solana_program;
use anchor_lang::solana_program::system_instruction;

declare_id!("j3WMvorrddakwt69dqrQ5cve5APpyd4bxUCb9UF9Aqj");

// Simple treasury-only fee model, upgradeable via admin instruction.

#[program]
pub mod agent_staking {
    use super::*;

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
        require!(min_stake_amount > 0, StakingError::InvalidMinStakeAmount);
        
        // Initialize token vault via CPI
        let pool_key = ctx.accounts.staking_pool.key();
        let seeds = &[b"token_vault", pool_key.as_ref(), &[ctx.bumps.token_vault]];
        let signer = &[&seeds[..]];
        
        let rent = &ctx.accounts.rent;
        let vault_rent = rent.minimum_balance(anchor_spl::token::TokenAccount::LEN);
        
        // Create account for token vault
        solana_program::program::invoke_signed(
            &system_instruction::create_account(
                ctx.accounts.owner.key,
                ctx.accounts.token_vault.key,
                vault_rent,
                165, // Size of TokenAccount
                ctx.accounts.token_program.key,
            ),
            &[
                ctx.accounts.owner.to_account_info(),
                ctx.accounts.token_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer,
        )?;
        
        // Initialize token account via token program
        let init_ix = anchor_spl::token::spl_token::instruction::initialize_account3(
            &anchor_spl::token::ID,
            ctx.accounts.token_vault.key,
            ctx.accounts.token_mint.key,
            &ctx.accounts.staking_pool.key(), // authority = staking_pool PDA
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
        pool.flags = 1; // ACTIVE
        pool.bump = ctx.bumps.staking_pool;
        emit!(PoolCreated { agent_pda: pool.agent_pda, owner: pool.owner, min_stake_amount });
        Ok(())
    }

    pub fn update_min_stake(ctx: Context<UpdateMinStake>, new_min_stake_amount: u64) -> Result<()> {
        require!(new_min_stake_amount > 0, StakingError::InvalidMinStakeAmount);
        require_keys_eq!(ctx.accounts.staking_pool.owner, ctx.accounts.owner.key(), StakingError::Unauthorized);
        let pool = &mut ctx.accounts.staking_pool;
        let old = pool.min_stake_amount;
        pool.min_stake_amount = new_min_stake_amount;
        emit!(MinStakeUpdated { agent_pda: pool.agent_pda, old_amount: old, new_amount: new_min_stake_amount });
        Ok(())
    }

    // Initialize a new stake account (required before first stake)
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

    // Stake tokens (requires stake account to be initialized first)
    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, StakingError::InvalidStakeAmount);
        let pool = &mut ctx.accounts.staking_pool;
        let stake_acc = &mut ctx.accounts.stake_account;
        let clock = Clock::get()?;

        // First-time stake: enforce min_stake (FIX M-02)
        if stake_acc.staked_amount == 0 {
            require!(
                amount >= pool.min_stake_amount,
                StakingError::BelowMinimumStake
            );
            pool.staker_count = pool.staker_count.saturating_add(1);
        }

        // Verify ownership
        require!(
            stake_acc.staker == ctx.accounts.staker.key(),
            StakingError::Unauthorized
        );

        // REAL SPL transfer: staker → vault
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

    // REMOVED: transfer_authority - no central authority in zero-admin architecture
    // Program parameters are hardcoded and can only be changed via program upgrades

    pub fn withdraw_stake(ctx: Context<WithdrawStake>) -> Result<()> {
        let pool = &mut ctx.accounts.staking_pool;
        let state = &ctx.accounts.program_state;
        let stake_acc = &mut ctx.accounts.stake_account;
        let clock = Clock::get()?;

        require!(stake_acc.staked_amount > 0, StakingError::NoStake);

        let elapsed = (clock.unix_timestamp - stake_acc.staked_at).max(0) as u64;
        let fee = calculate_unstake_fee(elapsed, state)?;  // FIX H-01: propagate error

        // FIX H-02: Check suffisance SOL AVANT transfer
        if fee > 0 {
            let staker_lamports = ctx.accounts.staker.lamports();
            let rent_exempt = Rent::get()?.minimum_balance(0);
            
            require!(
                staker_lamports >= fee.saturating_add(rent_exempt),
                StakingError::InsufficientSolForFee
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

        // REAL SPL transfer: vault → staker (PDA must sign)
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

        // FIX C-02: Ne PAS fermer le compte, juste réinitialiser montant
        // Ceci conserve staked_at pour éviter manipulation fees
        stake_acc.staked_amount = 0;
        stake_acc.last_updated_at = clock.unix_timestamp;
        
        pool.total_staked = pool.total_staked.saturating_sub(amount);
        // Note: staker_count reste inchangé (compte existe toujours)

        emit!(Withdrawn { staker: stake_acc.staker, agent_pda: pool.agent_pda, amount, fee });
        Ok(())
    }
}

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
    pub initializer: Signer<'info>,  // Just pays for initialization, no ongoing control
    /// CHECK: treasury system account
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// REMOVED: TransferAuthority context - no central authority needed

#[derive(Accounts)]
pub struct CreateStakingPool<'info> {
    /// FIX C-01 COMPLETE: Validation via lecture directe du compte agent-registry
    /// Vérifie que l'agent existe ET a le flag HAS_STAKING activé
    #[account(
        constraint = agent.flags & FLAG_HAS_STAKING != 0 @ StakingError::StakingNotEnabled,
        seeds = [b"agent", agent.creator.as_ref()],
        bump = agent.bump,
        seeds::program = agent_registry::ID
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
    /// CHECK: Token vault PDA - will be initialized via CPI in instruction
    #[account(
        mut,
        seeds = [b"token_vault", staking_pool.key().as_ref()],
        bump
    )]
    pub token_vault: AccountInfo<'info>,
    /// CHECK: Token mint - validated by token program during vault init
    pub token_mint: AccountInfo<'info>,
    #[account(
        mut,
        constraint = owner.key() == agent.owner @ StakingError::Unauthorized
    )]
    pub owner: Signer<'info>,  // Must be the current agent owner
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

// Context for initializing a new stake account
#[derive(Accounts)]
pub struct InitStake<'info> {
    #[account(
        seeds = [b"staking_pool", agent_pda.key().as_ref()],
        bump = staking_pool.bump
    )]
    pub staking_pool: Account<'info, StakingPool>,
    /// CHECK: agent pda in agent-registry program
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

// Context for staking tokens (requires initialized stake account)
#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(
        mut,
        seeds = [b"staking_pool", agent_pda.key().as_ref()],
        bump = staking_pool.bump
    )]
    pub staking_pool: Account<'info, StakingPool>,
    /// CHECK: agent pda in agent-registry program
    pub agent_pda: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"stake_account", staker.key().as_ref(), agent_pda.key().as_ref()],
        bump = stake_account.bump,
        constraint = stake_account.staker == staker.key() @ StakingError::Unauthorized
    )]
    pub stake_account: Account<'info, StakeAccount>,
    /// CHECK: Token vault to receive staked tokens - validated manually
    #[account(
        mut,
        constraint = token_vault.key() == staking_pool.token_vault @ StakingError::InvalidVault
    )]
    pub token_vault: AccountInfo<'info>,
    /// CHECK: Staker's token account (source of tokens) - validated by SPL transfer
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
    /// CHECK: agent pda in agent-registry program
    pub agent_pda: UncheckedAccount<'info>,
    #[account(
        mut,
        // FIX C-02: Ne plus fermer le compte pour conserver staked_at
        seeds = [b"stake_account", staker.key().as_ref(), agent_pda.key().as_ref()],
        bump = stake_account.bump,
        constraint = stake_account.staker == staker.key() @ StakingError::Unauthorized
    )]
    pub stake_account: Account<'info, StakeAccount>,
    /// CHECK: Token vault (source of returned tokens) - validated manually
    #[account(
        mut,
        constraint = token_vault.key() == staking_pool.token_vault @ StakingError::InvalidVault
    )]
    pub token_vault: AccountInfo<'info>,
    /// CHECK: Staker's token account (destination for returned tokens) - validated by SPL transfer
    #[account(mut)]
    pub staker_token_account: AccountInfo<'info>,
    #[account(mut)]
    pub staker: Signer<'info>,
    /// CHECK: treasury account (receives lamports)
    #[account(mut, address = program_state.treasury)]
    pub treasury: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
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
    pub const SPACE: usize = 8 + 8 + 8 + 4 + 32 + 1; // Removed authority field (32 bytes)
    pub const DEFAULT_IMMEDIATE_FEE: u64 = 100_000_000; // 0.1 SOL
    pub const DEFAULT_REGULAR_FEE: u64 = 1_000_000;     // 0.001 SOL
    pub const DEFAULT_MAX_FEE: u64 = 100_000_000;       // 0.1 SOL (cap)
    pub const DEFAULT_DECAY_DURATION: u32 = 86_400;     // 24h
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
    // OPTIMIZATION: pool supprimé, peut être dérivé de agent_pda
    // Économie: 32 bytes = 0.00024 SOL par staker
    pub staked_amount: u64,
    pub staked_at: i64,
    pub last_updated_at: i64,
    pub bump: u8,
}

impl StakeAccount {
    pub const SPACE: usize = 32 + 32 + 8 + 8 + 8 + 1;  // 89 bytes (vs 121)
}

// FIX H-01: Retourner Result pour gérer division par zéro
fn calculate_unstake_fee(elapsed_secs: u64, state: &ProgramState) -> Result<u64> {
    require!(state.decay_duration_seconds > 0, StakingError::InvalidFeeConfig);
    
    if elapsed_secs >= state.decay_duration_seconds as u64 {
        return Ok(state.fee_regular_lamports.min(state.fee_max_lamports));
    }
    
    let immediate = state.fee_immediate_lamports as u128;
    let regular = state.fee_regular_lamports as u128;
    let duration = state.decay_duration_seconds as u128;
    let elapsed = elapsed_secs as u128;
    let diff = immediate.saturating_sub(regular);
    
    // linear decay - division sécurisée
    let reduction = diff
        .saturating_mul(elapsed)
        .checked_div(duration)
        .ok_or(StakingError::InvalidFeeConfig)?;
    
    let fee = immediate.saturating_sub(reduction);
    Ok(fee.min(state.fee_max_lamports as u128) as u64)
}

#[error_code]
pub enum StakingError {
    #[msg("Invalid minimum stake amount")]
    InvalidMinStakeAmount,
    #[msg("Invalid fee configuration")]
    InvalidFeeConfig,
    #[msg("Invalid stake amount")]
    InvalidStakeAmount,
    #[msg("No stake to withdraw")]
    NoStake,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid token vault")]
    InvalidVault,
    #[msg("Stake amount below minimum required")]
    BelowMinimumStake,
    #[msg("Insufficient SOL to pay unstaking fee")]
    InsufficientSolForFee,
    #[msg("Invalid agent PDA")]
    InvalidAgent,
    // REMOVED: InvalidAuthority - no central authority in zero-admin architecture
    #[msg("Agent does not have staking enabled")]
    StakingNotEnabled,
}

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

// REMOVED: AuthorityTransferred event - no central authority in zero-admin architecture


