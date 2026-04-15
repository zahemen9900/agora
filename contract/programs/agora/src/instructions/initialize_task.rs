use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::errors::AgoraError;
use crate::state::{TaskAccount, TaskStatus, VaultAccount};

const MAX_MECHANISM: u8 = 4;

#[derive(Accounts)]
#[instruction(task_id: [u8; 32])]
pub struct InitializeTask<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + TaskAccount::LEN,
        seeds = [b"task", task_id.as_ref()],
        bump
    )]
    pub task_account: Account<'info, TaskAccount>,

    #[account(
        init,
        payer = payer,
        space = 8 + VaultAccount::LEN,
        seeds = [b"vault", task_id.as_ref()],
        bump
    )]
    pub vault: Account<'info, VaultAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeTask>,
    task_id: [u8; 32],
    mechanism: u8,
    task_hash: [u8; 32],
    consensus_threshold: u8,
    agent_count: u8,
    payment_amount: u64,
    recipient: Pubkey,
) -> Result<()> {
    require!(
        consensus_threshold > 0 && consensus_threshold <= 100,
        AgoraError::InvalidThreshold
    );
    require!(
        agent_count > 0 && agent_count <= 10,
        AgoraError::InvalidAgentCount
    );
    require!(mechanism <= MAX_MECHANISM, AgoraError::InvalidMechanism);
    require!(recipient != Pubkey::default(), AgoraError::InvalidRecipient);

    let now = Clock::get()?.unix_timestamp;

    let task_account = &mut ctx.accounts.task_account;
    task_account.task_id = task_id;
    task_account.task_hash = task_hash;
    task_account.mechanism = mechanism;
    task_account.switched_to = None;
    task_account.selector_reasoning_hash = [0; 32];
    task_account.transcript_merkle_root = [0; 32];
    task_account.decision_hash = [0; 32];
    task_account.quorum_reached = false;
    task_account.agent_count = agent_count;
    task_account.consensus_threshold = consensus_threshold;
    task_account.payment_amount = payment_amount;
    task_account.payer = ctx.accounts.payer.key();
    task_account.recipient = recipient;
    task_account.mechanism_switches = 0;
    task_account.status = TaskStatus::Pending;
    task_account.created_at = now;
    task_account.completed_at = None;
    task_account.bump = ctx.bumps.task_account;
    task_account.vault_bump = ctx.bumps.vault;

    let vault = &mut ctx.accounts.vault;
    vault.bump = ctx.bumps.vault;

    if payment_amount > 0 {
        let transfer_accounts = Transfer {
            from: ctx.accounts.payer.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
        };
        let transfer_ctx = CpiContext::new(ctx.accounts.system_program.key(), transfer_accounts);
        transfer(transfer_ctx, payment_amount)?;
    }

    Ok(())
}
