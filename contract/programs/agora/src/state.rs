use anchor_lang::prelude::*;

#[account]
pub struct TaskAccount {
    pub task_id: [u8; 32],
    pub task_hash: [u8; 32],
    pub mechanism: u8,
    pub switched_to: Option<u8>,
    pub selector_reasoning_hash: [u8; 32],
    pub transcript_merkle_root: [u8; 32],
    pub decision_hash: [u8; 32],
    pub quorum_reached: bool,
    pub agent_count: u8,
    pub consensus_threshold: u8,
    pub payment_amount: u64,
    pub payer: Pubkey,
    pub recipient: Pubkey,
    pub mechanism_switches: u8,
    pub status: TaskStatus,
    pub created_at: i64,
    pub completed_at: Option<i64>,
    pub bump: u8,
    pub vault_bump: u8,
}

impl TaskAccount {
    pub const LEN: usize = 32
        + 32
        + 1
        + 2
        + 32
        + 32
        + 32
        + 1
        + 1
        + 1
        + 8
        + 32
        + 32
        + 1
        + 1
        + 8
        + 9
        + 1
        + 1;
}

#[account]
pub struct VaultAccount {
    pub bump: u8,
}

impl VaultAccount {
    pub const LEN: usize = 1;
}

#[account]
pub struct MechanismSwitchLog {
    pub task_id: [u8; 32],
    pub switch_index: u8,
    pub from_mechanism: u8,
    pub to_mechanism: u8,
    pub reason_hash: [u8; 32],
    pub round_number: u8,
    pub timestamp: i64,
    pub bump: u8,
}

impl MechanismSwitchLog {
    pub const LEN: usize = 32 + 1 + 1 + 1 + 32 + 1 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    Paid,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MechanismType {
    Debate,
    Vote,
    Delphi,
    MoA,
    Hybrid,
}
