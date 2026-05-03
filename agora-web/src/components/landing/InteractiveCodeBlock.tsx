import { useEffect, useRef, useState, useCallback } from 'react';
import { Copy, RotateCcw, Check } from 'lucide-react';
import { usePostHog } from "@posthog/react";

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const CODE_LINES = [
  '$ pip install agora-arbitrator-sdk',
  '>>> from agora.sdk import AgoraArbitrator',
  '>>> result = await AgoraArbitrator().arbitrate(',
  '...     "Should we use microservices or a monolith?"',
  '... )',
];

const PROGRESS_STEPS = [
  '  Selecting mechanism...',
  '  DEBATE selected (91% confidence)',
  '  Running factional debate... Round 1/3',
  '  Running factional debate... Round 2/3',
  '  Running factional debate... Round 3/3',
  '  Convergence detected. Finalizing...',
  '✓ Quorum reached.',
];

const OUTPUT_LINES = [
  { prompt: '>>> result.mechanism_used', value: "'debate'" },
  { prompt: '>>> result.final_answer', value: "'Monolithic architecture for a team of 3...'" },
  { prompt: '>>> result.merkle_root', value: "'0x7a3f8b2e4c1d...e8b2'" },
  { prompt: '>>> result.quorum_reached', value: 'True' },
];

type Stage =
  | { type: 'idle' }
  | { type: 'typing_install' }
  | { type: 'install_output' }
  | { type: 'typing_import' }
  | { type: 'typing_call' }
  | { type: 'thinking'; spinnerIdx: number; progressIdx: number }
  | { type: 'output'; lines: number };


export function InteractiveCodeBlock() {
    const posthog = usePostHog();
  const containerRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Stage>({ type: 'idle' });
  const [copied, setCopied] = useState(false);
  const triggeredRef = useRef(false);
  const pausedRef = useRef(false);

  const setPausedState = (nextPaused: boolean) => {
    pausedRef.current = nextPaused;
  };

  const delay = useCallback((ms: number) => {
    return new Promise<void>((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (Date.now() - start >= ms) return resolve();
        if (!pausedRef.current) {
          setTimeout(tick, 16);
        } else {
          setTimeout(tick, 50);
        }
      };
      tick();
    });
  }, []);

  const runSequence = useCallback(async () => {
    setStage({ type: 'typing_install' });
    await delay(1000);
    setStage({ type: 'install_output' });
    await delay(600);
    setStage({ type: 'typing_import' });
    await delay(1200);
    setStage({ type: 'typing_call' });
    await delay(2000);

    // Thinking spinner
    let sIdx = 0;
    let pIdx = 0;
    setStage({ type: 'thinking', spinnerIdx: 0, progressIdx: 0 });

    for (let i = 0; i < PROGRESS_STEPS.length; i++) {
      for (let j = 0; j < 6; j++) {
        await delay(120);
        sIdx = (sIdx + 1) % SPINNER_FRAMES.length;
        setStage((s) => s.type === 'thinking' ? { ...s, spinnerIdx: sIdx } : s);
      }
      await delay(300);
      pIdx = i + 1;
      setStage((s) => s.type === 'thinking' ? { ...s, progressIdx: pIdx } : s);
    }

    await delay(400);

    // Output lines
    for (let n = 1; n <= OUTPUT_LINES.length; n++) {
      await delay(350);
      setStage({ type: 'output', lines: n });
    }
  }, [delay]);

  // IntersectionObserver trigger
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !triggeredRef.current) {
          triggeredRef.current = true;
          obs.disconnect();
          void runSequence();
        }
      },
      { threshold: 0.2 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [runSequence]);

  const handleReset = () => {
    setStage({ type: 'idle' });
    triggeredRef.current = false;
    setTimeout(() => {
      triggeredRef.current = true;
      void runSequence();
    }, 50);
  };

  const handleCopy = () => {
    const code = CODE_LINES.join('\n');
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Derive which lines are visible
  const showInstall = stage.type !== 'idle';
  const installDone = ['install_output', 'typing_import', 'typing_call', 'thinking', 'output'].includes(stage.type);
  const showImport = installDone;
  const importDone = ['typing_call', 'thinking', 'output'].includes(stage.type);
  const showCall = importDone;
  const callDone = stage.type === 'thinking' || stage.type === 'output';
  const showThinking = stage.type === 'thinking' || stage.type === 'output';
  const progressIdx = stage.type === 'thinking' ? stage.progressIdx : stage.type === 'output' ? PROGRESS_STEPS.length : 0;
  const spinnerFrame = stage.type === 'thinking' ? SPINNER_FRAMES[stage.spinnerIdx] : '✓';
  const outputLines = stage.type === 'output' ? stage.lines : 0;

  return (
    <div ref={containerRef} className="w-full max-w-2xl mx-auto relative">
      {/* Scanline overlay */}
      <div
        className="absolute inset-0 pointer-events-none z-10 rounded-2xl overflow-hidden"
        style={{
          background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.012) 2px, rgba(255,255,255,0.012) 4px)',
        }}
      />

      {/* Terminal card */}
      <div
        className="rounded-2xl overflow-hidden"
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-muted)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        {/* Titlebar */}
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)' }}
        >
          <div className="flex gap-2">
            {['#ff6058', '#ffbd2e', '#28ca41'].map((c, i) => (
              <div key={i} className="w-3 h-3 rounded-full" style={{ background: c, opacity: 0.7 }} />
            ))}
          </div>
          <span className="mono text-text-muted" style={{ fontSize: '10px', letterSpacing: '0.08em' }}>
            agora-arbitrator-sdk demo
          </span>
          <div className="flex gap-3 items-center">
            <button
              onClick={(e: any) => { posthog?.capture('interactivecodeblock_reset_clicked'); const handler = handleReset; if (typeof handler === 'function') (handler as any)(e); }}
              className="text-text-muted hover:text-text-secondary transition-colors"
              title="Reset"
            >
              <RotateCcw size={13} />
            </button>
            <button
              onClick={(e: any) => { posthog?.capture('interactivecodeblock_copy_code_clicked'); const handler = handleCopy; if (typeof handler === 'function') (handler as any)(e); }}
              className="text-text-muted hover:text-text-secondary transition-colors"
              title="Copy code"
            >
              {copied ? <Check size={13} className="text-accent" /> : <Copy size={13} />}
            </button>
          </div>
        </div>

        {/* Code body */}
        <div
          className="p-6 mono"
          style={{ fontSize: '12.5px', lineHeight: '1.7', minHeight: '320px' }}
          onMouseEnter={() => setPausedState(true)}
          onMouseLeave={() => setPausedState(false)}
        >
          {/* Line 1: pip install */}
          {showInstall && (
            <div style={{ animation: 'phase-fade-in 0.2s ease forwards' }}>
              <span style={{ color: 'var(--accent)' }}>$ </span>
              <TypingLine
                text="pip install agora-arbitrator-sdk"
                done={installDone}
                speed={22}
                color="var(--text-primary)"
              />
            </div>
          )}

          {/* Install success output */}
          {installDone && (
            <div className="text-text-muted mb-3" style={{ fontSize: '11px', animation: 'phase-fade-in 0.3s ease forwards' }}>
              Successfully installed agora-arbitrator-sdk-0.1.0
            </div>
          )}

          {/* Line 2: import */}
          {showImport && (
            <div style={{ animation: 'phase-fade-in 0.2s ease forwards' }}>
              <span style={{ color: 'var(--text-muted)' }}>{'>>> '}</span>
              <TypingLine
                text="from agora.sdk import AgoraArbitrator"
                done={importDone}
                speed={20}
                color="var(--text-primary)"
              />
            </div>
          )}

          {/* Lines 3-5: function call */}
          {showCall && (
            <div style={{ animation: 'phase-fade-in 0.2s ease forwards' }}>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>{'>>> '}</span>
                <TypingLine
                  text='result = await AgoraArbitrator().arbitrate('
                  done={callDone}
                  speed={18}
                  color="var(--text-primary)"
                />
              </div>
              {callDone && (
                <>
                  <div style={{ animation: 'phase-fade-in 0.2s ease forwards' }}>
                    <span style={{ color: 'var(--text-muted)' }}>{'... '}</span>
                    <span style={{ color: 'var(--devil-advocate)' }}>&quot;Should we use microservices or a monolith?&quot;</span>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>{'... '}</span>
                    <span style={{ color: 'var(--text-primary)' }}>)</span>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Thinking spinner + progress */}
          {showThinking && (
            <div className="mt-2 mb-1" style={{ animation: 'phase-fade-in 0.2s ease forwards' }}>
              {PROGRESS_STEPS.slice(0, progressIdx).map((step, i) => (
                <div key={i} style={{ color: i === progressIdx - 1 ? 'var(--accent)' : 'var(--text-muted)', fontSize: '11px', animation: 'phase-fade-in 0.2s ease forwards' }}>
                  {i === progressIdx - 1 && stage.type === 'thinking'
                    ? `${spinnerFrame} ${step.trim()}`
                    : step}
                </div>
              ))}
            </div>
          )}

          {/* Output lines */}
          {outputLines > 0 && (
            <div className="mt-2" style={{ animation: 'phase-fade-in 0.2s ease forwards' }}>
              {OUTPUT_LINES.slice(0, outputLines).map((line, i) => (
                <div key={i} style={{ animation: `phase-fade-in 0.25s ease ${i * 0.05}s both` }}>
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>{'>>> '}</span>
                    <span style={{ color: 'var(--text-secondary)' }}>{line.prompt.replace('>>> ', '')}</span>
                  </div>
                  <div style={{ color: 'var(--accent)', paddingLeft: '0px', marginBottom: '4px' }}>
                    {line.value}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Cursor */}
          {stage.type === 'idle' && (
            <span
              className="inline-block w-2 h-3.5 bg-text-muted"
              style={{ animation: 'pulse-glow 1s infinite' }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// Internal typewriter line — shows full text once done, types while typing
function TypingLine({ text, done, speed, color }: { text: string; done: boolean; speed: number; color: string }) {
  const [displayed, setDisplayed] = useState('');
  const [finished, setFinished] = useState(false);
  const idxRef = useRef(0);
  const visibleText = done ? text : displayed;
  const showCursor = !done && !finished;

  useEffect(() => {
    if (done) return;
    if (finished) return;
    const timer = setInterval(() => {
      if (idxRef.current < text.length) {
        setDisplayed(text.slice(0, idxRef.current + 1));
        idxRef.current++;
      } else {
        setFinished(true);
        clearInterval(timer);
      }
    }, speed);
    return () => clearInterval(timer);
  }, [text, done, speed, finished]);

  return (
    <span style={{ color }}>
      {visibleText}
      {showCursor && (
        <span
          className="inline-block w-1.5 h-3 ml-px"
          style={{ background: 'var(--text-secondary)', animation: 'pulse-glow 0.8s infinite' }}
        />
      )}
    </span>
  );
}
