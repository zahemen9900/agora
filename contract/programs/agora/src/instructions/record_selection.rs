use anchor_lang::prelude::*;

use crate::errors::AgoraError;
use crate::state::{TaskAccount, TaskStatus};

#[derive(Accounts)]
#[instruction(task_id: [u8; 32])]
pub struct RecordSelection<'info> {
    #[account(
        mut,
        seeds = [b"task", task_id.as_ref()],
        bump = task_account.bump
    )]
    pub task_account: Account<'info, TaskAccount>,
    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<RecordSelection>, _task_id: [u8; 32], selector_reasoning_hash: [u8; 32]) -> Result<()> {
    let task_account = &mut ctx.accounts.task_account;

    require_keys_eq!(ctx.accounts.authority.key(), task_account.payer, AgoraError::Unauthorized);
    require!(matches!(task_account.status, TaskStatus::Pending), AgoraError::InvalidTaskStatus);

    task_account.selector_reasoning_hash = selector_reasoning_hash;
    task_account.status = TaskStatus::InProgress;

    Ok(())
}
