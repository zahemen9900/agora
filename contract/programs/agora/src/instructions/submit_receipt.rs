use anchor_lang::prelude::*;

use crate::errors::AgoraError;
use crate::state::{TaskAccount, TaskStatus};

#[derive(Accounts)]
#[instruction(task_id: [u8; 32])]
pub struct SubmitReceipt<'info> {
    #[account(
        mut,
        seeds = [b"task", task_id.as_ref()],
        bump = task_account.bump
    )]
    pub task_account: Account<'info, TaskAccount>,
    pub authority: Signer<'info>,
}

pub fn handler(
    ctx: Context<SubmitReceipt>,
    _task_id: [u8; 32],
    transcript_merkle_root: [u8; 32],
    decision_hash: [u8; 32],
    quorum_reached: bool,
    final_mechanism: u8,
) -> Result<()> {
    let task_account = &mut ctx.accounts.task_account;

    require_keys_eq!(
        ctx.accounts.authority.key(),
        task_account.payer,
        AgoraError::Unauthorized
    );
    require!(
        matches!(task_account.status, TaskStatus::InProgress),
        AgoraError::InvalidTaskStatus
    );

    task_account.transcript_merkle_root = transcript_merkle_root;
    task_account.decision_hash = decision_hash;
    task_account.quorum_reached = quorum_reached;

    if task_account.mechanism != final_mechanism {
        task_account.switched_to = Some(final_mechanism);
    }
    task_account.mechanism = final_mechanism;
    task_account.status = TaskStatus::Completed;
    task_account.completed_at = Some(Clock::get()?.unix_timestamp);

    Ok(())
}
