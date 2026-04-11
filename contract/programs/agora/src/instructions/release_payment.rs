use anchor_lang::prelude::*;

use crate::errors::AgoraError;
use crate::state::{TaskAccount, TaskStatus, VaultAccount};

#[derive(Accounts)]
#[instruction(task_id: [u8; 32])]
pub struct ReleasePayment<'info> {
    #[account(
        mut,
        seeds = [b"task", task_id.as_ref()],
        bump = task_account.bump
    )]
    pub task_account: Account<'info, TaskAccount>,

    #[account(
        mut,
        seeds = [b"vault", task_id.as_ref()],
        bump = task_account.vault_bump,
        close = authority
    )]
    pub vault: Account<'info, VaultAccount>,

    #[account(mut)]
    pub recipient: SystemAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ReleasePayment>, _task_id: [u8; 32]) -> Result<()> {
    let task_account = &mut ctx.accounts.task_account;

    require_keys_eq!(
        ctx.accounts.authority.key(),
        task_account.payer,
        AgoraError::Unauthorized
    );
    if matches!(task_account.status, TaskStatus::Paid) {
        return err!(AgoraError::AlreadyPaid);
    }
    require!(
        matches!(task_account.status, TaskStatus::Completed),
        AgoraError::InvalidTaskStatus
    );
    require!(task_account.quorum_reached, AgoraError::QuorumNotReached);
    require_keys_eq!(
        ctx.accounts.recipient.key(),
        task_account.recipient,
        AgoraError::RecipientMismatch
    );

    let payment_amount = task_account.payment_amount;
    if payment_amount == 0 {
        task_account.status = TaskStatus::Paid;
        return Ok(());
    }

    if payment_amount > 0 {
        let vault_info = ctx.accounts.vault.to_account_info();
        let recipient_info = ctx.accounts.recipient.to_account_info();

        let available = vault_info.lamports();
        require!(available > 0, AgoraError::NoPayment);
        let transfer_amount = payment_amount.min(available);

        **vault_info.try_borrow_mut_lamports()? -= transfer_amount;
        **recipient_info.try_borrow_mut_lamports()? += transfer_amount;
    }

    task_account.payment_amount = 0;
    task_account.status = TaskStatus::Paid;

    Ok(())
}
