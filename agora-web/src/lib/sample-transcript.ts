// src/lib/sample-transcript.ts
// The 4 leaf strings that get SHA-256 hashed to build the demo Merkle tree.
// These correspond to the deliberation in LiveDeliberationPreview.tsx

export const SAMPLE_TRANSCRIPT: string[] = [
  'Agent-1 [PRO]: Microservices allow independent deployment cycles. Each service can be scaled, updated, and maintained without touching the others — critical when engineering velocity depends on parallel workstreams.',
  'Agent-2 [OPP]: A monolith is the right call because coordination overhead destroys small teams. With 3 engineers, distributed systems mean distributed debugging, distributed config drift, and distributed on-call pain.',
  'DA [cross-exam]: The proponents have not addressed deployment complexity. How do 3 engineers maintain service meshes, inter-service auth, distributed tracing, and a service registry — while shipping features?',
  'Agent-4 [OPP rebuttal]: Three engineers cannot maintain more than 4 services without significant operational overhead. A well-structured monolith with clear module boundaries gives you the benefits without the cost.',
];
