#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::{
    InitializeTask,
    RecordMechanismSwitch,
    RecordSelection,
    ReleasePayment,
    SubmitReceipt,
};
pub(crate) use instructions::initialize_task::__client_accounts_initialize_task;
pub(crate) use instructions::record_selection::__client_accounts_record_selection;
pub(crate) use instructions::record_switch::__client_accounts_record_mechanism_switch;
pub(crate) use instructions::release_payment::__client_accounts_release_payment;
pub(crate) use instructions::submit_receipt::__client_accounts_submit_receipt;

declare_id!("7XyyHB6ih5MxStBkyYWjbfKUXJTv2sSiecM5XR3ftP3f");

#[program]
pub mod agora {
    use super::*;

    pub fn initialize_task(
        ctx: Context<InitializeTask>,
        task_id: [u8; 32],
        mechanism: u8,
        task_hash: [u8; 32],
        consensus_threshold: u8,
        agent_count: u8,
        payment_amount: u64,
        recipient: Pubkey,
    ) -> Result<()> {
        instructions::initialize_task::handler(
            ctx,
            task_id,
            mechanism,
            task_hash,
            consensus_threshold,
            agent_count,
            payment_amount,
            recipient,
        )
    }

    pub fn record_selection(
        ctx: Context<RecordSelection>,
        task_id: [u8; 32],
        selector_reasoning_hash: [u8; 32],
    ) -> Result<()> {
        instructions::record_selection::handler(ctx, task_id, selector_reasoning_hash)
    }

    pub fn submit_receipt(
        ctx: Context<SubmitReceipt>,
        task_id: [u8; 32],
        transcript_merkle_root: [u8; 32],
        decision_hash: [u8; 32],
        quorum_reached: bool,
        final_mechanism: u8,
    ) -> Result<()> {
        instructions::submit_receipt::handler(
            ctx,
            task_id,
            transcript_merkle_root,
            decision_hash,
            quorum_reached,
            final_mechanism,
        )
    }

    pub fn record_mechanism_switch(
        ctx: Context<RecordMechanismSwitch>,
        task_id: [u8; 32],
        switch_index: u8,
        from_mechanism: u8,
        to_mechanism: u8,
        reason_hash: [u8; 32],
        round_number: u8,
    ) -> Result<()> {
        instructions::record_switch::handler(
            ctx,
            task_id,
            switch_index,
            from_mechanism,
            to_mechanism,
            reason_hash,
            round_number,
        )
    }

    pub fn release_payment(ctx: Context<ReleasePayment>, task_id: [u8; 32]) -> Result<()> {
        instructions::release_payment::handler(ctx, task_id)
    }
}
