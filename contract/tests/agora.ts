import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";

import { Agora } from "../target/types/agora";

describe("agora", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Agora as Program<Agora>;
  const payer = provider.wallet as anchor.Wallet;
  const recipient = anchor.web3.Keypair.generate();

  const taskSeed = Buffer.from("task-001");
  const taskId = Buffer.concat([taskSeed, Buffer.alloc(32 - taskSeed.length)]);

  const taskPda = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("task"), taskId],
    program.programId,
  )[0];

  const vaultPda = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), taskId],
    program.programId,
  )[0];

  it("initializes a task with escrow", async () => {
    const paymentAmount = new anchor.BN(100_000_000);

    await program.methods
      .initializeTask(
        [...taskId] as unknown as number[],
        0,
        [...taskId] as unknown as number[],
        60,
        3,
        paymentAmount,
        recipient.publicKey,
      )
      .accounts({
        taskAccount: taskPda,
        vault: vaultPda,
        payer: payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const account = await program.account.taskAccount.fetch(taskPda);
    expect(account.consensusThreshold).to.equal(60);
    expect(account.agentCount).to.equal(3);
    expect(account.status).to.deep.equal({ pending: {} });
  });

  it("records mechanism selection", async () => {
    const reasoningHash = Array(32).fill(1) as number[];

    await program.methods
      .recordSelection([...taskId] as unknown as number[], reasoningHash)
      .accounts({
        taskAccount: taskPda,
        authority: payer.publicKey,
      })
      .rpc();

    const account = await program.account.taskAccount.fetch(taskPda);
    expect(account.status).to.deep.equal({ inProgress: {} });
  });

  // NOTE: Week 1 coverage can be expanded with additional cases listed in
  // docs/Phase1_Josh_Week1_Infra_Contract.md as contract behavior stabilizes.
});
