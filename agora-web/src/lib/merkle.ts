// src/lib/merkle.ts
// Real client-side SHA-256 via Web Crypto API (§9.5)
// No backend. No mocked hashes. Browser recomputes the root.

const encoder = new TextEncoder();

export async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(buf)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export type VerifyStep = {
  stage: 'leaf' | 'parent' | 'root';
  index?: number;
  value: string;
};

export async function verifyReceipt(
  transcript: string[],
  claimedRoot: string,
  onStep?: (step: VerifyStep) => void,
): Promise<{ valid: boolean; computedRoot: string }> {
  console.log(
    '%c[Agora Merkle] Starting verification',
    'color:#22d38a;font-weight:bold;font-size:13px',
  );

  // Hash leaves
  const leaves: string[] = [];
  for (let i = 0; i < transcript.length; i++) {
    const h = await sha256(transcript[i]);
    leaves.push(h);
    console.log(`%c  leaf[${i}] = 0x${h.slice(0, 16)}…`, 'color:#7f848c');
    onStep?.({ stage: 'leaf', index: i, value: h });
    await new Promise<void>(r => setTimeout(r, 240));
  }

  // Build tree bottom-up
  let level = leaves;
  let depth = 0;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? level[i]; // duplicate on odd
      const parent = await sha256(a + b);
      next.push(parent);
      console.log(
        `%c  depth ${depth} parent = 0x${parent.slice(0, 16)}…`,
        'color:#7f848c',
      );
      onStep?.({ stage: 'parent', index: depth * 100 + Math.floor(i / 2), value: parent });
      await new Promise<void>(r => setTimeout(r, 240));
    }
    level = next;
    depth++;
  }

  const computedRoot = level[0];
  const valid = computedRoot === claimedRoot;

  console.log(
    `%c[Agora Merkle] ${valid ? '✓ MATCH' : '✗ MISMATCH'}`,
    `color:${valid ? '#22d38a' : '#ff6b6b'};font-weight:bold;font-size:13px`,
  );
  console.log(`  computed: 0x${computedRoot}`);
  console.log(`  claimed:  0x${claimedRoot}`);
  onStep?.({ stage: 'root', value: computedRoot });

  return { valid, computedRoot };
}
