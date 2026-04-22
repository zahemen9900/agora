import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';

/* ── Types ──────────────────────────────────────────────────────── */
export type Faction = 'pro' | 'opp' | 'da';

type Phase = 'opening' | 'cross-exam' | 'rebuttal';

interface StreamEvent {
  kind: 'stream';
  phase: Phase;
  faction: Faction;
  agent: string;
  text: string;
  /** ms to display a thinking doodle before streaming begins */
  thinkingBefore: number;
}

interface LockEvent {
  kind: 'lock';
  phase: 'lock';
  claim: string;
  verification: string;
}

export type ReplayEvent = StreamEvent | LockEvent;

/* ── Replay script ──────────────────────────────────────────────── */
export const DELIBERATION_REPLAY: ReplayEvent[] = [
  {
    kind: 'stream', phase: 'opening', faction: 'pro', agent: 'Agent-1',
    text: 'Microservices allow independent deployment cycles. Each service can be scaled, updated, and maintained without touching the others — critical when your engineering velocity depends on parallel workstreams.',
    thinkingBefore: 400,
  },
  {
    kind: 'stream', phase: 'opening', faction: 'opp', agent: 'Agent-2',
    text: 'A monolith is the right call because coordination overhead destroys small teams. With 3 engineers, distributed systems mean distributed debugging, distributed config drift, and distributed on-call pain.',
    thinkingBefore: 1500,
  },
  {
    kind: 'stream', phase: 'opening', faction: 'pro', agent: 'Agent-3',
    text: 'With only 3 engineers, service boundaries map to people — one owns infra, one owns product core, one owns integrations. That\'s a clean decomposition that reduces merge conflicts.',
    thinkingBefore: 1100,
  },
  {
    kind: 'stream', phase: 'cross-exam', faction: 'da', agent: "Devil's Advocate",
    text: "The proponents haven't addressed deployment complexity. How do 3 engineers maintain service meshes, inter-service auth, distributed tracing, and a service registry — while shipping features?",
    thinkingBefore: 1200,
  },
  {
    kind: 'stream', phase: 'rebuttal', faction: 'opp', agent: 'Agent-4',
    text: 'The DA is right — three engineers cannot maintain >4 services without significant operational overhead. A well-structured monolith with clear module boundaries gives you the benefits without the cost.',
    thinkingBefore: 1400,
  },
  {
    kind: 'lock', phase: 'lock',
    claim: 'Three engineers cannot maintain >4 services',
    verification: 'heuristic (team size analysis)',
  },
];

/* ── Thinking doodle ────────────────────────────────────────────── */
function ThinkingDots({ faction }: { faction: Faction }) {
  const color = faction === 'pro' ? 'var(--accent-emerald)'
    : faction === 'opp' ? 'var(--accent-rose)'
    : 'var(--accent-amber)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: "'Commit Mono', monospace", marginRight: '6px' }}>
        thinking
      </span>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            display: 'inline-block',
            width: '5px',
            height: '5px',
            borderRadius: '50%',
            background: color,
            animation: `dot-bounce 1.2s ${i * 0.15}s ease-in-out infinite`,
          }}
        />
      ))}
    </span>
  );
}

/* ── Agent card with built-in typewriter ────────────────────────── */
interface AgentCardProps {
  faction: Faction;
  agent: string;
  text: string;
  status: 'thinking' | 'streaming' | 'done';
  isDimmed: boolean;
  reducedMotion: boolean;
  onStreamComplete?: () => void;
}

function AgentCard({ faction, agent, text, status, isDimmed, reducedMotion, onStreamComplete }: AgentCardProps) {
  const [displayed, setDisplayed] = useState(status === 'done' || reducedMotion ? text : '');
  const [cursorOn, setCursorOn] = useState(true);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const completeCalled = useRef(false);
  // Stable ref so the typewriter effect never needs onStreamComplete in its deps
  const onCompleteRef = useRef(onStreamComplete);
  useLayoutEffect(() => { onCompleteRef.current = onStreamComplete; });

  const factionColor = faction === 'pro' ? 'var(--accent-emerald)'
    : faction === 'opp' ? 'var(--accent-rose)'
    : 'var(--accent-amber)';

  const factionBg = faction === 'pro' ? 'var(--accent-emerald-soft)'
    : faction === 'opp' ? 'var(--accent-rose-soft)'
    : 'var(--accent-amber-soft)';

  // Typewriter — only re-runs when status/text/reducedMotion change,
  // NOT when the onStreamComplete callback reference changes (uses ref instead).
  useEffect(() => {
    completeCalled.current = false;
    if (reducedMotion) {
      setDisplayed(text);
      if (status === 'streaming') {
        completeCalled.current = true;
        onCompleteRef.current?.();
      }
      return;
    }
    if (status === 'done') { setDisplayed(text); return; }
    if (status === 'thinking') { setDisplayed(''); return; }

    // status === 'streaming'
    setDisplayed('');
    const chars = [...text];
    let idx = 0;
    const schedule = () => {
      if (idx >= chars.length) {
        if (!completeCalled.current) {
          completeCalled.current = true;
          onCompleteRef.current?.();
        }
        return;
      }
      const base = idx > 60 ? 14 : 20;
      const jitter = (Math.random() - 0.5) * base * 0.5;
      let delay = base + jitter;
      const ch = chars[idx - 1];
      if (ch && /[ ,.:;!?]/.test(ch) && Math.random() < 0.3) delay += 20 + Math.random() * 25;
      timeoutRef.current = setTimeout(() => {
        idx++;
        setDisplayed(chars.slice(0, idx).join(''));
        schedule();
      }, Math.max(10, delay));
    };
    schedule();
    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, status, reducedMotion]);

  // Cursor blink while streaming
  useEffect(() => {
    if (status !== 'streaming' || reducedMotion) return;
    const id = setInterval(() => setCursorOn((v) => !v), 500);
    return () => clearInterval(id);
  }, [status, reducedMotion]);

  const isStreaming = status === 'streaming';

  return (
    <div
      className={`faction-${faction}${isStreaming && !reducedMotion ? ' streaming' : ''}`}
      style={{
        border: `1px solid ${isStreaming ? factionColor : 'var(--border-default)'}`,
        borderRadius: '12px',
        padding: '16px',
        background: 'var(--bg-elevated)',
        opacity: isDimmed ? 0.55 : 1,
        transition: 'opacity 0.35s, border-color 0.3s',
        flex: faction === 'da' ? '0 0 100%' : '1',
        position: 'relative',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        <span className="pill" style={{
          background: factionBg,
          color: factionColor,
          border: `1px solid ${factionColor}33`,
        }}>
          {faction === 'pro' ? 'PRO' : faction === 'opp' ? 'OPP' : 'DA'}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: "'Commit Mono', monospace" }}>
          {agent}
        </span>
      </div>

      <p style={{
        fontSize: '13px',
        lineHeight: '1.6',
        color: 'var(--text-secondary)',
        margin: 0,
        fontFamily: "'Hanken Grotesk', sans-serif",
        minHeight: '60px',
      }}>
        {status === 'thinking' && !reducedMotion ? (
          <ThinkingDots faction={faction} />
        ) : (
          <>
            {displayed}
            {isStreaming && !reducedMotion && cursorOn && (
              <span style={{ color: factionColor, fontFamily: 'monospace' }}>▋</span>
            )}
          </>
        )}
      </p>
    </div>
  );
}

/* ── Convergence meter — interpolates smoothly on advance ───────── */
function ConvergenceMeter({ turn, lockDone }: { turn: number; lockDone: boolean }) {
  // turn = number of completed stream events (0..N)
  // Entropy decays monotonically; info gain rises then plateaus
  const maxTurns = 5;
  const t = Math.min(1, turn / maxTurns);
  const entropy = 0.78 - t * 0.42;       // 0.78 → 0.36
  const infoGain = 0.08 + t * 0.32;      // 0.08 → 0.40

  return (
    <div style={{
      border: '1px solid var(--border-default)',
      borderRadius: '10px',
      padding: '14px 18px',
      background: 'var(--bg-subtle)',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
    }}>
      <div className="eyebrow" style={{ color: 'var(--text-tertiary)', marginBottom: '2px' }}>
        Convergence
      </div>

      {[
        { label: 'Entropy', value: entropy, max: 1.0, color: 'var(--accent-amber)' },
        { label: 'Info Gain', value: infoGain, max: 0.5, color: 'var(--accent-emerald)' },
      ].map(({ label, value, max, color }) => (
        <div key={label}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: "'Commit Mono', monospace" }}>{label}</span>
            <span style={{ fontSize: '11px', color, fontFamily: "'Commit Mono', monospace" }}>{value.toFixed(2)}</span>
          </div>
          <div style={{ background: 'var(--border-default)', borderRadius: '4px', height: '5px', overflow: 'hidden' }}>
            <div style={{
              width: `${(value / max) * 100}%`,
              height: '100%',
              background: color,
              borderRadius: '4px',
              transition: 'width 0.8s cubic-bezier(0.16, 1, 0.3, 1)',
            }}/>
          </div>
        </div>
      ))}

      <div style={{ fontSize: '11px', color: 'var(--accent-emerald)', fontFamily: "'Commit Mono', monospace" }}>
        {lockDone ? '🔒 1 claim verified' : turn > 0 ? 'Analyzing…' : 'Awaiting first argument…'}
      </div>
    </div>
  );
}

/* ── Main component ─────────────────────────────────────────────── */
interface LiveDeliberationPreviewProps {
  reducedMotion?: boolean;
}

interface ShownEvent {
  event: ReplayEvent;
  index: number;
  status: 'thinking' | 'streaming' | 'done';
}

export function LiveDeliberationPreview({ reducedMotion = false }: LiveDeliberationPreviewProps) {
  const [events, setEvents] = useState<ShownEvent[]>([]);
  const [completeCount, setCompleteCount] = useState(0);
  const [showReplay, setShowReplay] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const runIdRef = useRef(0);
  // Use a ref (not state) so changing it never re-triggers the observer effect
  const startedRef = useRef(false);

  const clearTimeouts = useCallback(() => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
  }, []);

  const advanceTo = useCallback((idx: number, runId: number) => {
    if (runIdRef.current !== runId) return;
    if (idx >= DELIBERATION_REPLAY.length) {
      const t = setTimeout(() => {
        if (runIdRef.current === runId) setShowReplay(true);
      }, 2400);
      timeoutsRef.current.push(t);
      return;
    }
    const ev = DELIBERATION_REPLAY[idx];

    if (ev.kind === 'lock') {
      // Mark locked claim as a completed non-streaming event
      setEvents((prev) => [...prev, { event: ev, index: idx, status: 'done' }]);
      setCompleteCount((c) => c + 1);
      const t = setTimeout(() => advanceTo(idx + 1, runId), 600);
      timeoutsRef.current.push(t);
      return;
    }

    if (reducedMotion) {
      // Show immediately as done
      setEvents((prev) => [...prev, { event: ev, index: idx, status: 'done' }]);
      setCompleteCount((c) => c + 1);
      const t = setTimeout(() => advanceTo(idx + 1, runId), 200);
      timeoutsRef.current.push(t);
      return;
    }

    // Insert with 'thinking' status
    setEvents((prev) => [...prev, { event: ev, index: idx, status: 'thinking' }]);

    // After thinkingBefore → flip to 'streaming'
    const t = setTimeout(() => {
      if (runIdRef.current !== runId) return;
      setEvents((prev) => prev.map((e) =>
        e.index === idx ? { ...e, status: 'streaming' } : e,
      ));
    }, Math.max(300, ev.thinkingBefore));
    timeoutsRef.current.push(t);
  }, [reducedMotion]);

  const handleStreamComplete = useCallback((idx: number, runId: number) => {
    if (runIdRef.current !== runId) return;
    setEvents((prev) => prev.map((e) =>
      e.index === idx ? { ...e, status: 'done' } : e,
    ));
    setCompleteCount((c) => c + 1);
    // Short beat between speakers
    const t = setTimeout(() => advanceTo(idx + 1, runId), 600);
    timeoutsRef.current.push(t);
  }, [advanceTo]);

  const startReplay = useCallback(() => {
    clearTimeouts();
    runIdRef.current += 1;
    const runId = runIdRef.current;
    setEvents([]);
    setCompleteCount(0);
    setShowReplay(false);

    const t = setTimeout(() => advanceTo(0, runId), 500);
    timeoutsRef.current.push(t);
  }, [advanceTo, clearTimeouts]);

  // Start when section enters viewport — effect runs once on mount.
  // Using a ref for the started guard means changing it never re-triggers
  // this effect (which would cancel the in-flight advanceTo timeout).
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !startedRef.current) {
          startedRef.current = true;
          startReplay();
        }
      },
      { threshold: 0.1 },
    );
    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => {
      observer.disconnect();
      clearTimeouts();
    };
  // startReplay and clearTimeouts are stable useCallback refs — safe to omit
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Group events by faction
  const streamEvents = events.filter((e) => e.event.kind === 'stream') as Array<ShownEvent & { event: StreamEvent }>;
  const proEvents = streamEvents.filter((e) => e.event.faction === 'pro');
  const oppEvents = streamEvents.filter((e) => e.event.faction === 'opp');
  const daEvents = streamEvents.filter((e) => e.event.faction === 'da');
  const lockEvents = events.filter((e) => e.event.kind === 'lock') as Array<ShownEvent & { event: LockEvent }>;

  const isDACrossExam = daEvents.some((e) => e.status === 'streaming' || e.status === 'thinking');
  const lockDone = lockEvents.length > 0;

  // Round derived from which phase we're in
  const hasRebuttal = streamEvents.some((e) => e.event.phase === 'rebuttal');
  const hasCrossExam = streamEvents.some((e) => e.event.phase === 'cross-exam');
  const round = hasRebuttal ? 3 : hasCrossExam ? 2 : 1;

  return (
    <section
      ref={sectionRef}
      className="live-deliberation section-padding"
      style={{ background: 'var(--bg-subtle)' }}
    >
      <div className="content-rail">
        {/* Section heading */}
        <div style={{ textAlign: 'center', marginBottom: '64px' }}>
          <div className="eyebrow" style={{ color: 'var(--accent-emerald)', marginBottom: '16px' }}>
            Live Deliberation
          </div>
          <h2 style={{ textTransform: 'uppercase', marginBottom: '16px' }}>
            Watch the machine think.
          </h2>
          <p className="lead" style={{ maxWidth: '520px', margin: '0 auto' }}>
            A startup with 3 engineers. Should they use microservices or a monolith?
          </p>
        </div>

        {/* Mock card */}
        <div className="mock-container" style={{ maxWidth: '900px', margin: '0 auto' }}>

          {/* Task header */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '20px',
            paddingBottom: '16px',
            borderBottom: '1px solid var(--border-default)',
            flexWrap: 'wrap',
            gap: '8px',
          }}>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', fontFamily: "'Commit Mono', monospace" }}>
              Task: <span style={{ color: 'var(--text-primary)' }}>"microservices vs monolith for 3-engineer team"</span>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <span className="pill pill-pro">DEBATE</span>
              <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: "'Commit Mono', monospace" }}>
                Round {round}/3
              </span>
            </div>
          </div>

          {/* Faction columns */}
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>

            {/* PRO column */}
            <div style={{ flex: 1, minWidth: '260px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {proEvents.length === 0 ? (
                <div style={{ border: '1px dashed var(--border-default)', borderRadius: '12px', padding: '16px', minHeight: '80px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ color: 'var(--text-tertiary)', fontSize: '12px', fontFamily: "'Commit Mono', monospace" }}>Awaiting PRO arguments…</span>
                </div>
              ) : (
                proEvents.map((e) => (
                  <AgentCard
                    key={e.index}
                    faction="pro"
                    agent={e.event.agent}
                    text={e.event.text}
                    status={e.status}
                    isDimmed={isDACrossExam}
                    reducedMotion={reducedMotion}
                    onStreamComplete={() => handleStreamComplete(e.index, runIdRef.current)}
                  />
                ))
              )}
            </div>

            {/* OPP column */}
            <div style={{ flex: 1, minWidth: '260px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {oppEvents.length === 0 ? (
                <div style={{ border: '1px dashed var(--border-default)', borderRadius: '12px', padding: '16px', minHeight: '80px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ color: 'var(--text-tertiary)', fontSize: '12px', fontFamily: "'Commit Mono', monospace" }}>Awaiting OPP arguments…</span>
                </div>
              ) : (
                oppEvents.map((e) => (
                  <AgentCard
                    key={e.index}
                    faction="opp"
                    agent={e.event.agent}
                    text={e.event.text}
                    status={e.status}
                    isDimmed={isDACrossExam}
                    reducedMotion={reducedMotion}
                    onStreamComplete={() => handleStreamComplete(e.index, runIdRef.current)}
                  />
                ))
              )}
            </div>
          </div>

          {/* DA row — full width */}
          {daEvents.length > 0 && (
            <div style={{ marginBottom: '16px' }}>
              {daEvents.map((e) => (
                <AgentCard
                  key={e.index}
                  faction="da"
                  agent={e.event.agent}
                  text={e.event.text}
                  status={e.status}
                  isDimmed={false}
                  reducedMotion={reducedMotion}
                  onStreamComplete={() => handleStreamComplete(e.index, runIdRef.current)}
                />
              ))}
            </div>
          )}

          {/* Locked claims */}
          {lockEvents.map((le) => (
            <div key={le.index} style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '10px 14px',
              background: 'var(--accent-emerald-soft)',
              border: '1px solid var(--accent-emerald)',
              borderRadius: '8px',
              marginBottom: '12px',
              fontSize: '12px',
              fontFamily: "'Commit Mono', monospace",
              animation: reducedMotion ? 'none' : 'slide-in-up 0.4s ease',
              flexWrap: 'wrap',
            }}>
              <span style={{ color: 'var(--accent-emerald)' }}>🔒</span>
              <span style={{ color: 'var(--accent-emerald)' }}>Locked:</span>
              <span style={{ color: 'var(--text-primary)' }}>{le.event.claim}</span>
              <span style={{ color: 'var(--text-tertiary)', marginLeft: 'auto' }}>via {le.event.verification}</span>
            </div>
          ))}

          {/* Convergence meter */}
          <ConvergenceMeter turn={completeCount} lockDone={lockDone} />

          {/* Replay button */}
          {showReplay && (
            <div style={{ textAlign: 'center', marginTop: '24px', animation: 'phase-fade-in 0.4s ease' }}>
              <button
                onClick={startReplay}
                className="btn-secondary"
                style={{ fontSize: '12px', padding: '8px 20px' }}
              >
                ↺ Replay Deliberation
              </button>
            </div>
          )}
        </div>

        {/* aria-live region */}
        <div aria-live="polite" style={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
          {lockDone ? 'Deliberation complete. Quorum reached.' : `Turn ${completeCount}`}
        </div>
      </div>
    </section>
  );
}
