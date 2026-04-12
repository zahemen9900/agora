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
        validate_vault_balance(available, payment_amount)?;

        **vault_info.try_borrow_mut_lamports()? -= payment_amount;
        **recipient_info.try_borrow_mut_lamports()? += payment_amount;
    }

    task_account.payment_amount = 0;
    task_account.status = TaskStatus::Paid;

    Ok(())
}

fn validate_vault_balance(available: u64, payment_amount: u64) -> Result<()> {
    require!(available > 0, AgoraError::NoPayment);
    require!(
        available >= payment_amount,
        AgoraError::InsufficientVaultBalance
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use anchor_lang::error::Error;

    use super::*;

    fn assert_anchor_error_name(result: Result<()>, expected_name: &str) {
        match result.expect_err("expected Anchor error") {
            Error::AnchorError(error) => assert_eq!(error.error_name, expected_name),
            other => panic!("expected AnchorError, got {other:?}"),
        }
    }

    #[test]
    fn rejects_empty_vault_balance() {
        assert_anchor_error_name(validate_vault_balance(0, 10), "NoPayment");
    }

    #[test]
    fn rejects_short_vault_balance() {
        assert_anchor_error_name(validate_vault_balance(9, 10), "InsufficientVaultBalance");
    }

    #[test]
    fn accepts_sufficient_vault_balance() {
        assert!(validate_vault_balance(10, 10).is_ok());
        assert!(validate_vault_balance(11, 10).is_ok());
    }
}
