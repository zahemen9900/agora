import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { RotateCcw, Copy, Check, BookOpen } from 'lucide-react';

// ─── Keyframe injection ───────────────────────────────────────────────────────
const STYLE_ID = 'sdk-demo-kf';
function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    @keyframes sdk-fade {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(s);
}

// ─── Types ────────────────────────────────────────────────────────────────────
type LineKind =
  | 'shell' | 'install-ok' | 'py' | 'py-cont'
  | 'blank' | 'spinner' | 'check' | 'result-key' | 'result-val';

interface Line { id: string; text: string; kind: LineKind; fade?: boolean; }

let _lid = 0;
const nextId = () => `sdk-${_lid++}`;

// ─── Color palette (dark terminal) ────────────────────────────────────────────
const C = {
  prompt:  '#6b7280',
  pip:     '#7dd3fc',
  pkg:     '#fbbf24',
  ver:     '#86efac',
  kw:      '#c084fc',
  mod:     '#67e8f9',
  cls:     '#fbbf24',
  str:     '#86efac',
  attr:    '#7dd3fc',
  braille: '#fbbf24',
  check:   '#34d399',
  debate:  '#34d399',
  dim:     '#6b7280',
  plain:   '#e6edf3',
} as const;

// ─── Syntax highlighter ───────────────────────────────────────────────────────
function HL({ text, kind }: { text: string; kind: LineKind }) {
  if (!text) return null;

  const sp = (color: string, t: string) => <span style={{ color }}>{t}</span>;

  switch (kind) {
    case 'shell': {
      const m = text.match(/^(\$\s*)(pip install\s+)(agora-arbitrator-sdk)(.*)$/);
      if (m) return (
        <>{sp(C.prompt, m[1])}{sp(C.pip, m[2])}{sp(C.pkg, m[3])}{m[4] ? sp(C.plain, m[4]) : null}</>
      );
      return <>{sp(C.plain, text)}</>;
    }

    case 'install-ok': {
      const m = text.match(/^(Successfully installed )(agora-arbitrator-sdk-)([\w.]+)$/);
      if (m) return <>{sp(C.ver, m[1])}{sp(C.pkg, m[2])}{sp(C.ver, m[3])}</>;
      return <>{sp(C.ver, text)}</>;
    }

    case 'py': {
      const hasPrompt = text.startsWith('>>> ');
      const body = hasPrompt ? text.slice(4) : text;
      const prompt = hasPrompt ? sp(C.prompt, '>>> ') : null;

      // from agora.sdk import AgoraArbitrator
      const fromM = body.match(/^(from )(agora)(\.)(sdk)( import )(AgoraArbitrator)(.*)$/);
      if (fromM) return (
        <>
          {prompt}
          {sp(C.kw, fromM[1])}
          {sp(C.mod, fromM[2])}
          {sp(C.dim, fromM[3])}
          {sp(C.mod, fromM[4])}
          {sp(C.kw, fromM[5])}
          {sp(C.cls, fromM[6])}
          {fromM[7] ? sp(C.plain, fromM[7]) : null}
        </>
      );

      // result = await AgoraArbitrator().arbitrate(
      const awaitM = body.match(/^(result)( = )(await )(AgoraArbitrator)(\(\))(\.arbitrate\()(.*)$/);
      if (awaitM) return (
        <>
          {prompt}
          {sp(C.plain, awaitM[1])}
          {sp(C.dim, awaitM[2])}
          {sp(C.kw, awaitM[3])}
          {sp(C.cls, awaitM[4])}
          {sp(C.dim, awaitM[5])}
          {sp(C.attr, awaitM[6])}
          {awaitM[7] ? sp(C.plain, awaitM[7]) : null}
        </>
      );

      return <>{prompt}{sp(C.plain, body)}</>;
    }

    case 'py-cont': {
      const m = text.match(/^(\.\.\.\s*)(.*)$/);
      if (!m) return <>{sp(C.plain, text)}</>;
      const rest = m[2];
      const isStr = rest.startsWith('"') || rest.startsWith("'");
      return <>{sp(C.prompt, m[1])}{isStr ? sp(C.str, rest) : sp(C.dim, rest)}</>;
    }

    case 'spinner': {
      const braille = text[0];
      const rest = text.slice(1);
      const di = rest.indexOf('DEBATE');
      if (di !== -1) return (
        <>
          {sp(C.braille, braille)}
          {sp(C.dim, rest.slice(0, di))}
          {sp(C.debate, 'DEBATE')}
          {sp(C.dim, rest.slice(di + 6))}
        </>
      );
      return <>{sp(C.braille, braille)}{sp(C.dim, rest)}</>;
    }

    case 'check': {
      const m = text.match(/^(✓)(.*)$/);
      if (m) return <>{sp(C.check, m[1])}{sp(C.ver, m[2])}</>;
      return <>{sp(C.check, text)}</>;
    }

    case 'result-key': {
      const m = text.match(/^(>>> )(result)(\.)([\w_]+)$/);
      if (m) return (
        <>
          {sp(C.prompt, m[1])}
          {sp(C.plain, m[2])}
          {sp(C.dim, m[3])}
          {sp(C.attr, m[4])}
        </>
      );
      return <>{sp(C.plain, text)}</>;
    }

    case 'result-val':
      if (text === 'True' || text === 'False') return <>{sp(C.kw, text)}</>;
      return <>{sp(C.str, text)}</>;

    default:
      return <>{sp(C.plain, text)}</>;
  }
}

// ─── Data ────────────────────────────────────────────────────────────────────
const SPINNER_STEPS = [
  { braille: '⠋', text: ' Selecting mechanism...' },
  { braille: '⠙', text: ' DEBATE selected (91% confidence)' },
  { braille: '⠹', text: ' Running deliberation... Round 1/3' },
  { braille: '⠸', text: ' Running deliberation... Round 2/3' },
  { braille: '⠼', text: ' Convergence detected. Finalizing...' },
] as const;

const RESULT_PAIRS: [string, string][] = [
  ['>>> result.mechanism_used',  "'debate'"],
  ['>>> result.final_answer',    "'Monolithic architecture is optimal for a 3-engineer team...'"],
  ['>>> result.merkle_root',     "'0x7a3f8b2e4c1d9f52...e8b2'"],
  ['>>> result.quorum_reached',  'True'],
];

// ─── Small UI helpers ─────────────────────────────────────────────────────────
function Cursor({ on }: { on: boolean }) {
  return (
    <span style={{
      display: 'inline-block', width: '2px', height: '14px',
      background: '#34d399', marginLeft: '1px',
      verticalAlign: 'text-bottom',
      opacity: on ? 1 : 0, transition: 'opacity 0.1s',
    }} />
  );
}

function IconBtn({
  title, onClick, active = false, children,
}: { title: string; onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 26, height: 26,
        color: active ? '#34d399' : '#6b7280',
        background: 'transparent',
        border: `1px solid ${active ? '#34d39966' : '#30363d'}`,
        borderRadius: '6px',
        cursor: 'pointer',
        transition: 'color 0.15s, border-color 0.15s, background 0.15s',
        flexShrink: 0,
      }}
      onMouseEnter={e => {
        if (active) return;
        const b = e.currentTarget;
        b.style.color = '#e6edf3';
        b.style.borderColor = '#6b7280';
        b.style.background = 'rgba(255,255,255,0.06)';
      }}
      onMouseLeave={e => {
        if (active) return;
        const b = e.currentTarget;
        b.style.color = '#6b7280';
        b.style.borderColor = '#30363d';
        b.style.background = 'transparent';
      }}
    >
      {children}
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export function InteractiveSdkDemo() {
  const [lines,       setLines]       = useState<Line[]>([]);
  const [typingText,  setTypingText]  = useState('');
  const [typingKind,  setTypingKind]  = useState<LineKind>('shell');
  const [cursorOn,    setCursorOn]    = useState(true);
  const [copied,      setCopied]      = useState(false);
  const [isStarted,   setIsStarted]   = useState(false);
  // suppress idle >>> during the async thinking/spinner phase
  const [isBusy,      setIsBusy]      = useState(false);

  const isPausedRef  = useRef(false);
  const resumeRef    = useRef<(() => void) | null>(null);
  const startedRef   = useRef(false);
  const timeoutsRef  = useRef<ReturnType<typeof setTimeout>[]>([]);
  const sectionRef   = useRef<HTMLElement>(null);
  const bodyRef      = useRef<HTMLDivElement>(null);

  useEffect(() => { injectStyles(); }, []);

  // Cursor blink
  useEffect(() => {
    const id = setInterval(() => setCursorOn(v => !v), 530);
    return () => clearInterval(id);
  }, []);

  // Auto-scroll terminal body as content grows
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [lines, typingText]);

  // ── Helpers ─────────────────────────────────────────────────────────────────

  const clearAll = useCallback(() => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
  }, []);

  // Schedule `fn` after `ms` ms, honouring pause state
  const after = useCallback((ms: number, fn: () => void) => {
    if (isPausedRef.current) {
      resumeRef.current = () => after(ms, fn);
      return;
    }
    const id = setTimeout(() => {
      timeoutsRef.current = timeoutsRef.current.filter(t => t !== id);
      if (isPausedRef.current) { resumeRef.current = fn; return; }
      fn();
    }, ms);
    timeoutsRef.current.push(id);
  }, []);

  // Push a completed line to the display list
  const push = useCallback((text: string, kind: LineKind, fade = false) => {
    setLines(prev => [...prev, { id: nextId(), text, kind, fade }]);
  }, []);

  // Type `text` char-by-char then call `onDone`
  const typewrite = useCallback((
    text: string, kind: LineKind, msPerChar: number, onDone: () => void,
  ) => {
    setTypingKind(kind);
    setTypingText('');
    const chars = [...text];
    let idx = 0;

    const go = () => {
      if (isPausedRef.current) { resumeRef.current = go; return; }
      if (idx >= chars.length) {
        push(text, kind);
        setTypingText('');
        onDone();
        return;
      }
      const base  = idx > 60 ? 14 : msPerChar;
      const jitter = (Math.random() - 0.5) * base * 0.5;
      let delay = base + jitter;
      const prev = chars[idx - 1];
      if (prev && /[.,():'"]/.test(prev) && Math.random() < 0.3) delay += 15 + Math.random() * 20;

      const id = setTimeout(() => {
        timeoutsRef.current = timeoutsRef.current.filter(t => t !== id);
        if (isPausedRef.current) { resumeRef.current = go; return; }
        idx++;
        setTypingText(chars.slice(0, idx).join(''));
        go();
      }, Math.max(8, delay));
      timeoutsRef.current.push(id);
    };

    go();
  }, [push]);

  // ── Main sequence ────────────────────────────────────────────────────────────

  const startAnimation = useCallback(() => {
    clearAll();
    setLines([]);
    setTypingText('');
    setIsBusy(false);
    setIsStarted(true);
    isPausedRef.current = false;
    resumeRef.current = null;

    // 1. pip install
    typewrite('$ pip install agora-arbitrator-sdk', 'shell', 30, () => {
      after(300, () => {
        push('Successfully installed agora-arbitrator-sdk-0.1.0a17', 'install-ok');
        after(220, () => {
          push('', 'blank');
          // 2. import
          typewrite('>>> from agora.sdk import AgoraArbitrator', 'py', 20, () => {
            // 3. call — 3 lines
            typewrite('>>> result = await AgoraArbitrator().arbitrate(', 'py', 20, () => {
              typewrite('...     "Should we use microservices or a monolith?"', 'py-cont', 18, () => {
                typewrite('... )', 'py-cont', 20, () => {
                  // 4. thinking phase — suppress idle cursor
                  setIsBusy(true);
                  after(800, () => {
                    let step = 0;
                    const nextSpinner = () => {
                      if (isPausedRef.current) { resumeRef.current = nextSpinner; return; }
                      if (step < SPINNER_STEPS.length) {
                        const s = SPINNER_STEPS[step++];
                        push(`${s.braille}${s.text}`, 'spinner', true);
                        after(360, nextSpinner);
                      } else {
                        // 5. check line
                        push('✓ Quorum reached.', 'check', true);
                        push('', 'blank');
                        // 6. result pairs
                        let ri = 0;
                        const nextResult = () => {
                          if (isPausedRef.current) { resumeRef.current = nextResult; return; }
                          if (ri >= RESULT_PAIRS.length) {
                            setIsBusy(false); // re-enable idle cursor at the end
                            return;
                          }
                          const [key, val] = RESULT_PAIRS[ri++];
                          push(key, 'result-key', true);
                          after(130, () => {
                            push(val, 'result-val', true);
                            after(360, nextResult);
                          });
                        };
                        after(200, nextResult);
                      }
                    };
                    nextSpinner();
                  });
                });
              });
            });
          });
        });
      });
    });
  }, [typewrite, after, push, clearAll]);

  // ── Scroll trigger ────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !startedRef.current) {
        startedRef.current = true;
        startAnimation();
      }
    }, { threshold: 0.15 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [startAnimation]);

  // ── Cleanup ───────────────────────────────────────────────────────────────────
  useEffect(() => () => clearAll(), [clearAll]);

  // ── Interaction handlers ──────────────────────────────────────────────────────
  const onEnter = () => { isPausedRef.current = true; };
  const onLeave = () => {
    isPausedRef.current = false;
    const r = resumeRef.current;
    resumeRef.current = null;
    r?.();
  };

  const onCopy = () => {
    const code = lines
      .filter(l => l.kind === 'shell' || l.kind === 'py' || l.kind === 'py-cont')
      .map(l => l.text)
      .join('\n');
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {/* clipboard blocked */});
  };

  const onReset = () => {
    isPausedRef.current = false;
    resumeRef.current = null;
    startedRef.current = false;
    startAnimation();
    startedRef.current = true;
  };

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <section
      ref={sectionRef}
      className="section-padding"
      style={{ background: 'var(--bg-subtle)' }}
    >
      <div className="content-rail">

        {/* Heading */}
        <div style={{ textAlign: 'center', marginBottom: '56px' }}>
          <div className="eyebrow" style={{ color: 'var(--accent-emerald)', marginBottom: '16px' }}>
            Integration
          </div>
          <h2 style={{ textTransform: 'uppercase', marginBottom: '16px' }}>
            Ship in minutes.
          </h2>
          <p className="lead" style={{ maxWidth: '480px', margin: '0 auto' }}>
            One{' '}
            <code style={{
              fontFamily: "'Commit Mono', monospace",
              fontSize: '14px',
              color: 'var(--accent-emerald)',
              background: 'var(--accent-emerald-soft)',
              padding: '1px 7px',
              borderRadius: '4px',
            }}>
              await
            </code>
            {' '}call. Full verifiable deliberation.
          </p>
        </div>

        {/* Terminal card */}
        <div
          style={{ maxWidth: '680px', margin: '0 auto' }}
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
        >
          <div style={{
            background: '#0d1117',
            border: '1px solid #30363d',
            borderRadius: '14px',
            overflow: 'hidden',
            boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
            position: 'relative',
          }}>

            {/* Scanline overlay */}
            <div
              aria-hidden
              style={{
                position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none',
                background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.014) 2px, rgba(255,255,255,0.014) 4px)',
                borderRadius: '14px',
              }}
            />

            {/* Title bar */}
            <div style={{
              display: 'flex', alignItems: 'center',
              padding: '12px 16px',
              borderBottom: '1px solid #21262d',
              background: '#161b22',
              position: 'relative', zIndex: 3,
            }}>
              {/* macOS traffic lights */}
              <div style={{ display: 'flex', gap: '7px', flexShrink: 0 }}>
                {(['#ff5f57', '#ffbd2e', '#28c841'] as const).map((c, i) => (
                  <div key={i} style={{ width: 12, height: 12, borderRadius: '50%', background: c }} />
                ))}
              </div>
              {/* Filename label */}
              <span style={{
                fontFamily: "'Commit Mono', monospace",
                fontSize: '12px',
                color: '#6b7280',
                flex: 1,
                textAlign: 'center',
                letterSpacing: '0.02em',
              }}>
                agora-sdk — python3
              </span>
              {/* Action buttons */}
              <div style={{
                display: 'flex', gap: '8px', flexShrink: 0,
                opacity: isStarted ? 1 : 0,
                transition: 'opacity 0.4s',
                pointerEvents: isStarted ? 'auto' : 'none',
              }}>
                <IconBtn title="Reset" onClick={onReset}>
                  <RotateCcw size={13} />
                </IconBtn>
                <IconBtn title={copied ? 'Copied!' : 'Copy code'} onClick={onCopy} active={copied}>
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                </IconBtn>
              </div>
            </div>

            {/* Terminal body */}
            <div
              ref={bodyRef}
              style={{
                padding: '20px 24px',
                minHeight: '240px',
                maxHeight: '400px',
                overflowY: 'auto',
                scrollbarWidth: 'none',
                position: 'relative', zIndex: 1,
              }}
            >
              {/* Committed lines */}
              {lines.map(line =>
                line.kind === 'blank'
                  ? <div key={line.id} style={{ height: '0.55em' }} />
                  : (
                    <div
                      key={line.id}
                      style={{
                        fontFamily: "'Commit Mono', monospace",
                        fontSize: '13px',
                        lineHeight: 1.65,
                        animation: line.fade ? 'sdk-fade 0.28s ease both' : undefined,
                      }}
                    >
                      <HL text={line.text} kind={line.kind} />
                    </div>
                  )
              )}

              {/* Active typewriter line */}
              {typingText && (
                <div style={{
                  fontFamily: "'Commit Mono', monospace",
                  fontSize: '13px',
                  lineHeight: 1.65,
                }}>
                  <HL text={typingText} kind={typingKind} />
                  <Cursor on={cursorOn} />
                </div>
              )}

              {/* Idle prompt — shown between phases and when done, hidden while busy */}
              {!typingText && isStarted && !isBusy && (
                <div style={{
                  fontFamily: "'Commit Mono', monospace",
                  fontSize: '13px',
                  lineHeight: 1.65,
                }}>
                  <span style={{ color: C.prompt }}>{'>>> '}</span>
                  <Cursor on={cursorOn} />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Docs link */}
        <div style={{ textAlign: 'center', marginTop: '28px' }}>
          <Link
            to="/docs"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '7px',
              fontFamily: "'Commit Mono', monospace",
              fontSize: '12px',
              letterSpacing: '0.04em',
              color: 'var(--text-secondary)',
              textDecoration: 'none',
              padding: '8px 16px',
              borderRadius: '999px',
              border: '1px solid var(--border-strong)',
              background: 'transparent',
              transition: 'color 0.18s ease, border-color 0.18s ease',
            }}
            onMouseEnter={e => {
              const el = e.currentTarget;
              el.style.color = 'var(--accent-emerald)';
              el.style.borderColor = 'var(--accent-emerald)';
            }}
            onMouseLeave={e => {
              const el = e.currentTarget;
              el.style.color = 'var(--text-secondary)';
              el.style.borderColor = 'var(--border-strong)';
            }}
          >
            <BookOpen size={13} />
            View our docs
          </Link>
        </div>

      </div>
    </section>
  );
}