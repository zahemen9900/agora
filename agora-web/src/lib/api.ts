export async function submitTask(
  _taskText: string,
  _agentCount: number,
  _stakes: number
) {
  // mock api call
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return {
    taskId: Math.random().toString(36).substring(7),
    mechanism: Math.random() > 0.5 ? "DEBATE" : "VOTE",
    confidence: Math.random() * 0.4 + 0.5, // 0.5 to 0.9
    reasoning: "Thompson sampling indicated optimal mechanism matching for task density."
  };
}

export async function streamDeliberation(
  _taskId: string,
  onEvent: (event: any) => void
) {
  let isClosed = false;

  const simulateStream = async () => {
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    await sleep(500);
    if(isClosed) return;
    onEvent({ type: "agent_output", faction: "proponent", agentId: "AgentAlpha", text: "I believe a monolith is vastly superior here." });

    await sleep(1500);
    if(isClosed) return;
    onEvent({ type: "convergence", entropy: 0.8, infoGain: 0.1, lockedClaims: [] });

    await sleep(1000);
    if(isClosed) return;
    onEvent({ type: "agent_output", faction: "opponent", agentId: "AgentBeta", text: "Microservices allow independent scaling." });

    await sleep(1500);
    if(isClosed) return;
    onEvent({ type: "agent_output", faction: "devil_advocate", agentId: "AgentGamma", text: "Both of you are ignoring the deployment overhead." });

    await sleep(1000);
    if(isClosed) return;
    onEvent({ type: "convergence", entropy: 0.4, infoGain: 0.5, lockedClaims: [{ text: "Deployment overhead is non-zero", method: "Consensus" }] });

    await sleep(1500);
    if(isClosed) return;
    onEvent({ type: "receipt", status: "quorum_reached", finalAnswer: "Start with a modular monolith.", confidence: 0.92 });
  };

  simulateStream();

  return {
    close: () => {
      isClosed = true;
    }
  };
}
