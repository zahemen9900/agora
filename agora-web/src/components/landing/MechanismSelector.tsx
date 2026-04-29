import { useState } from 'react';
import { usePostHog } from "@posthog/react";

const TASKS = ['Code review', 'Factual Q&A', 'Creative syn.', 'Values judgment'] as const;
type Task = typeof TASKS[number];

const MECHANISMS = ['Debate', 'Vote', 'Delphi'] as const;
type Mechanism = typeof MECHANISMS[number];

const DATA: Record<Task, Record<Mechanism, number>> = {
  'Code review':     { Debate: 78, Vote: 12, Delphi: 10 },
  'Factual Q&A':     { Debate: 14, Vote: 72, Delphi: 14 },
  'Creative syn.':   { Debate: 19, Vote: 10, Delphi: 71 },
  'Values judgment': { Debate: 24, Vote: 11, Delphi: 65 },
};

const MECH_COLORS: Record<Mechanism, string> = {
  Debate: 'var(--accent-emerald)',
  Vote:   'var(--text-tertiary)',
  Delphi: '#a78bfa',
};

export function MechanismSelector() {
    const posthog = usePostHog();
  const [active, setActive] = useState<Task>('Code review');
  const values = DATA[active];

  return (
    <section className="section-padding" style={{ background: 'var(--bg-subtle)' }}>
      <div className="content-rail">
        <div style={{ textAlign: 'center', marginBottom: '56px' }}>
          <div className="eyebrow" style={{ color: 'var(--accent-emerald)', marginBottom: '16px' }}>
            Adaptive Selection
          </div>
          <h2 style={{ textTransform: 'uppercase', marginBottom: '16px' }}>
            Mechanism Selector
          </h2>
          <p className="lead" style={{ maxWidth: '500px', margin: '0 auto' }}>
            The selector learns which mechanism wins for each task type.
            Tap a task to see the learned posterior.
          </p>
        </div>

        <div style={{ maxWidth: '700px', margin: '0 auto' }}>
          {/* Task chips */}
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center', marginBottom: '40px' }}>
            {TASKS.map(task => (
              <button
                key={task}
                onClick={(e: any) => { posthog?.capture('mechanismselector_action_clicked'); const handler = () => setActive(task); if (typeof handler === 'function') (handler as any)(e); }}
                style={{
                  padding: '8px 18px',
                  borderRadius: '9999px',
                  fontFamily: "'Commit Mono', monospace",
                  fontSize: '12px',
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  fontWeight: '600',
                  border: `1px solid ${active === task ? 'var(--accent-emerald)' : 'var(--border-strong)'}`,
                  background: active === task ? 'var(--accent-emerald-soft)' : 'transparent',
                  color: active === task ? 'var(--accent-emerald)' : 'var(--text-secondary)',
                  cursor: 'pointer',
                  transition: 'all 0.18s ease-out',
                }}
              >
                {task}
              </button>
            ))}
          </div>

          {/* Bar chart */}
          <div className="card" style={{ padding: '28px 32px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
              {MECHANISMS.map((mech, i) => (
                <div key={mech}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span style={{ fontSize: '12px', fontFamily: "'Commit Mono', monospace", color: MECH_COLORS[mech], fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      {mech}
                    </span>
                    <span style={{ fontSize: '12px', fontFamily: "'Commit Mono', monospace", color: 'var(--text-secondary)' }}>
                      {values[mech]}%
                    </span>
                  </div>
                  <div style={{ background: 'var(--border-default)', borderRadius: '4px', height: '8px', overflow: 'hidden' }}>
                    <div style={{
                      width: `${values[mech]}%`,
                      height: '100%',
                      background: MECH_COLORS[mech],
                      borderRadius: '4px',
                      transition: `width 0.48s cubic-bezier(0.22, 1, 0.36, 1) ${i * 40}ms`,
                      opacity: mech === 'Debate' ? 1 : 0.75,
                    }}/>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Caption */}
          <p style={{ textAlign: 'center', marginTop: '20px', fontSize: '12px', color: 'var(--text-tertiary)', fontFamily: "'Commit Mono', monospace", fontStyle: 'italic' }}>
            Thompson Sampling posteriors learned across 1,247 tasks in the Agora live network.
          </p>
        </div>
      </div>
    </section>
  );
}
