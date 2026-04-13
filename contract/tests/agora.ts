import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";

import { Agora } from "../target/types/agora";

describe("agora", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Agora as Program<Agora>;
  const payer = provider.wallet as anchor.Wallet;

  const toBytes32 = (seed: string): Buffer => {
    const output = Buffer.alloc(32);
    Buffer.from(seed).copy(output);
    return output;
  };

  const deriveTaskPda = (taskId: Buffer): anchor.web3.PublicKey =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("task"), taskId],
      program.programId,
    )[0];

  const deriveVaultPda = (taskId: Buffer): anchor.web3.PublicKey =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), taskId],
      program.programId,
    )[0];

  const deriveSwitchPda = (
    taskId: Buffer,
    switchIndex: number,
  ): anchor.web3.PublicKey =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("switch"), taskId, Buffer.from([switchIndex])],
      program.programId,
    )[0];

  const taskKey = (label: string): Buffer =>
    toBytes32(`${label}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`);

  const initializeTask = async (
    taskId: Buffer,
    paymentAmount: anchor.BN,
    recipient: anchor.web3.PublicKey,
    threshold = 60,
    agentCount = 3,
  ): Promise<{ taskPda: anchor.web3.PublicKey; vaultPda: anchor.web3.PublicKey }> => {
    const taskPda = deriveTaskPda(taskId);
    const vaultPda = deriveVaultPda(taskId);

    await program.methods
      .initializeTask(
        [...taskId] as unknown as number[],
        0,
        [...taskId] as unknown as number[],
        threshold,
        agentCount,
        paymentAmount,
        recipient,
      )
      .accounts({
        taskAccount: taskPda,
        vault: vaultPda,
        payer: payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    return { taskPda, vaultPda };
  };

  const recordSelection = async (taskId: Buffer, taskPda: anchor.web3.PublicKey) => {
    const reasoningHash = Array(32).fill(1) as number[];
    await program.methods
      .recordSelection([...taskId] as unknown as number[], reasoningHash)
      .accounts({
        taskAccount: taskPda,
        authority: payer.publicKey,
      })
      .rpc();
  };

  const submitReceipt = async (
    taskId: Buffer,
    taskPda: anchor.web3.PublicKey,
    quorumReached: boolean,
  ) => {
    const merkle = Array(32).fill(2) as number[];
    const decision = Array(32).fill(3) as number[];

    await program.methods
      .submitReceipt(
        [...taskId] as unknown as number[],
        merkle,
        decision,
        quorumReached,
        1,
      )
      .accounts({
        taskAccount: taskPda,
        authority: payer.publicKey,
      })
      .rpc();
  };

  it("initializes a task with escrow", async () => {
    const taskId = taskKey("init-escrow");
    const recipient = anchor.web3.Keypair.generate();
    const paymentAmount = new anchor.BN(100_000_000);

    const { taskPda, vaultPda } = await initializeTask(taskId, paymentAmount, recipient.publicKey);

    const account = await program.account.taskAccount.fetch(taskPda);
    expect(account.consensusThreshold).to.equal(60);
    expect(account.agentCount).to.equal(3);
    expect(account.status).to.deep.equal({ pending: {} });

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.be.greaterThanOrEqual(paymentAmount.toNumber());
  });

  it("records mechanism selection", async () => {
    const taskId = taskKey("record-selection");
    const recipient = anchor.web3.Keypair.generate();
    const { taskPda } = await initializeTask(taskId, new anchor.BN(0), recipient.publicKey);

    await recordSelection(taskId, taskPda);

    const account = await program.account.taskAccount.fetch(taskPda);
    expect(account.status).to.deep.equal({ inProgress: {} });
  });

  it("submits receipt after execution", async () => {
    const taskId = taskKey("submit-receipt");
    const recipient = anchor.web3.Keypair.generate();
    const { taskPda } = await initializeTask(taskId, new anchor.BN(0), recipient.publicKey);

    await recordSelection(taskId, taskPda);
    await submitReceipt(taskId, taskPda, true);

    const account = await program.account.taskAccount.fetch(taskPda);
    expect(account.status).to.deep.equal({ completed: {} });
    expect(account.completedAt).to.not.equal(null);
  });

  it("records mechanism switches", async () => {
    const taskId = taskKey("switches");
    const recipient = anchor.web3.Keypair.generate();
    const { taskPda } = await initializeTask(taskId, new anchor.BN(0), recipient.publicKey);

    await recordSelection(taskId, taskPda);

    const switch0 = deriveSwitchPda(taskId, 0);
    await program.methods
      .recordMechanismSwitch(
        [...taskId] as unknown as number[],
        0,
        0,
        1,
        Array(32).fill(4) as number[],
        3,
      )
      .accounts({
        taskAccount: taskPda,
        switchLog: switch0,
        authority: payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const switch1 = deriveSwitchPda(taskId, 1);
    await program.methods
      .recordMechanismSwitch(
        [...taskId] as unknown as number[],
        1,
        1,
        0,
        Array(32).fill(5) as number[],
        4,
      )
      .accounts({
        taskAccount: taskPda,
        switchLog: switch1,
        authority: payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const account = await program.account.taskAccount.fetch(taskPda);
    expect(account.mechanismSwitches).to.equal(2);
  });

  it("releases payment on quorum", async () => {
    const taskId = taskKey("release-payment");
    const recipient = anchor.web3.Keypair.generate();
    const paymentAmount = new anchor.BN(50_000_000);
    const { taskPda, vaultPda } = await initializeTask(taskId, paymentAmount, recipient.publicKey);

    await recordSelection(taskId, taskPda);
    await submitReceipt(taskId, taskPda, true);

    const beforeBalance = await provider.connection.getBalance(recipient.publicKey);
    await program.methods
      .releasePayment([...taskId] as unknown as number[])
      .accounts({
        taskAccount: taskPda,
        vault: vaultPda,
        recipient: recipient.publicKey,
        authority: payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const afterBalance = await provider.connection.getBalance(recipient.publicKey);
    expect(afterBalance).to.be.greaterThan(beforeBalance);

    const account = await program.account.taskAccount.fetch(taskPda);
    expect(account.status).to.deep.equal({ paid: {} });
  });

  it("fails to release payment without quorum", async () => {
    const taskId = taskKey("no-quorum");
    const recipient = anchor.web3.Keypair.generate();
    const { taskPda, vaultPda } = await initializeTask(taskId, new anchor.BN(10_000_000), recipient.publicKey);

    await recordSelection(taskId, taskPda);
    await submitReceipt(taskId, taskPda, false);

    let failed = false;
    try {
      await program.methods
        .releasePayment([...taskId] as unknown as number[])
        .accounts({
          taskAccount: taskPda,
          vault: vaultPda,
          recipient: recipient.publicKey,
          authority: payer.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    } catch {
      failed = true;
    }

    expect(failed).to.equal(true);
  });

  it("fails to release payment twice", async () => {
    const taskId = taskKey("double-release");
    const recipient = anchor.web3.Keypair.generate();
    const { taskPda, vaultPda } = await initializeTask(taskId, new anchor.BN(20_000_000), recipient.publicKey);

    await recordSelection(taskId, taskPda);
    await submitReceipt(taskId, taskPda, true);

    await program.methods
      .releasePayment([...taskId] as unknown as number[])
      .accounts({
        taskAccount: taskPda,
        vault: vaultPda,
        recipient: recipient.publicKey,
        authority: payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    let failed = false;
    try {
      await program.methods
        .releasePayment([...taskId] as unknown as number[])
        .accounts({
          taskAccount: taskPda,
          vault: vaultPda,
          recipient: recipient.publicKey,
          authority: payer.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    } catch {
      failed = true;
    }

    expect(failed).to.equal(true);
  });

  it("fails with wrong signer", async () => {
    const taskId = taskKey("wrong-signer");
    const recipient = anchor.web3.Keypair.generate();
    const { taskPda } = await initializeTask(taskId, new anchor.BN(0), recipient.publicKey);
    const badSigner = anchor.web3.Keypair.generate();

    let failed = false;
    try {
      await program.methods
        .recordSelection([...taskId] as unknown as number[], Array(32).fill(1) as number[])
        .accounts({
          taskAccount: taskPda,
          authority: badSigner.publicKey,
        })
        .signers([badSigner])
        .rpc();
    } catch {
      failed = true;
    }

    expect(failed).to.equal(true);
  });

  it("fails with invalid threshold", async () => {
    const taskIdLow = taskKey("invalid-threshold-low");
    const recipient = anchor.web3.Keypair.generate();

    let failedLow = false;
    try {
      await initializeTask(taskIdLow, new anchor.BN(0), recipient.publicKey, 0, 3);
    } catch {
      failedLow = true;
    }
    expect(failedLow).to.equal(true);

    const taskIdHigh = taskKey("invalid-threshold-high");
    let failedHigh = false;
    try {
      await initializeTask(taskIdHigh, new anchor.BN(0), recipient.publicKey, 101, 3);
    } catch {
      failedHigh = true;
    }
    expect(failedHigh).to.equal(true);
  });

  it("handles zero-payment tasks", async () => {
    const taskId = taskKey("zero-payment");
    const recipient = anchor.web3.Keypair.generate();
    const { taskPda, vaultPda } = await initializeTask(taskId, new anchor.BN(0), recipient.publicKey);

    await recordSelection(taskId, taskPda);
    await submitReceipt(taskId, taskPda, true);

    await program.methods
      .releasePayment([...taskId] as unknown as number[])
      .accounts({
        taskAccount: taskPda,
        vault: vaultPda,
        recipient: recipient.publicKey,
        authority: payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const account = await program.account.taskAccount.fetch(taskPda);
    expect(account.status).to.deep.equal({ paid: {} });
  });

  it("creates task with deterministic PDA", async () => {
    const taskId = toBytes32("deterministic-task");
    const taskPda = deriveTaskPda(taskId);
    const manualPda = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("task"), taskId],
      program.programId,
    )[0];

    expect(taskPda.toBase58()).to.equal(manualPda.toBase58());
  });

  const getTaskStatus = async (taskId: Buffer) => {
    const taskPda = deriveTaskPda(taskId);
    return program.account.taskAccount.fetch(taskPda);
  };

  it("exposes task status helper", async () => {
    const taskId = taskKey("status-helper");
    const recipient = anchor.web3.Keypair.generate();
    const { taskPda } = await initializeTask(taskId, new anchor.BN(0), recipient.publicKey);

    const account = await getTaskStatus(taskId);
    const direct = await program.account.taskAccount.fetch(taskPda);
    expect(account.taskId).to.deep.equal(direct.taskId);
  });
});
