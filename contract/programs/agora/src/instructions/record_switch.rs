use anchor_lang::prelude::*;

use crate::errors::AgoraError;
use crate::state::{MechanismSwitchLog, TaskAccount, TaskStatus};

#[derive(Accounts)]
#[instruction(task_id: [u8; 32], switch_index: u8)]
pub struct RecordMechanismSwitch<'info> {
    #[account(
        mut,
        seeds = [b"task", task_id.as_ref()],
        bump = task_account.bump
    )]
    pub task_account: Account<'info, TaskAccount>,

    #[account(
        init,
        payer = authority,
        space = 8 + MechanismSwitchLog::LEN,
        seeds = [b"switch", task_id.as_ref(), switch_index.to_le_bytes().as_ref()],
        bump
    )]
    pub switch_log: Account<'info, MechanismSwitchLog>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RecordMechanismSwitch>,
    task_id: [u8; 32],
    switch_index: u8,
    from_mechanism: u8,
    to_mechanism: u8,
    reason_hash: [u8; 32],
    round_number: u8,
) -> Result<()> {
    let task_account = &mut ctx.accounts.task_account;

    require_keys_eq!(ctx.accounts.authority.key(), task_account.payer, AgoraError::Unauthorized);
    require!(matches!(task_account.status, TaskStatus::InProgress), AgoraError::InvalidTaskStatus);
    require!(from_mechanism != to_mechanism, AgoraError::SameMechanism);
    require!(switch_index == task_account.mechanism_switches, AgoraError::InvalidSwitchIndex);

    let log_account = &mut ctx.accounts.switch_log;
    log_account.task_id = task_id;
    log_account.switch_index = switch_index;
    log_account.from_mechanism = from_mechanism;
    log_account.to_mechanism = to_mechanism;
    log_account.reason_hash = reason_hash;
    log_account.round_number = round_number;
    log_account.timestamp = Clock::get()?.unix_timestamp;
    log_account.bump = ctx.bumps.switch_log;

    task_account.mechanism_switches = task_account.mechanism_switches.saturating_add(1);
    task_account.switched_to = Some(to_mechanism);
    task_account.mechanism = to_mechanism;

    Ok(())
}
