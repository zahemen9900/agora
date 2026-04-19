use anchor_lang::prelude::*;

#[error_code]
pub enum AgoraError {
    #[msg("Invalid consensus threshold: must be 1-100")]
    InvalidThreshold,

    #[msg("Invalid agent count: must be 1-10")]
    InvalidAgentCount,

    #[msg("Task is not in the expected status")]
    InvalidTaskStatus,

    #[msg("Unauthorized: signer is not the task payer")]
    Unauthorized,

    #[msg("Quorum not reached: cannot release payment")]
    QuorumNotReached,

    #[msg("Payment already released")]
    AlreadyPaid,

    #[msg("Recipient mismatch")]
    RecipientMismatch,

    #[msg("Mechanism switch source and target must differ")]
    SameMechanism,

    #[msg("Invalid switch index: must match current switch count")]
    InvalidSwitchIndex,

    #[msg("No payment to release: payment amount is zero")]
    NoPayment,

    #[msg("Insufficient vault balance for requested payment amount")]
    InsufficientVaultBalance,

    #[msg("Invalid mechanism value")]
    InvalidMechanism,

    #[msg("Invalid recipient pubkey")]
    InvalidRecipient,
}
