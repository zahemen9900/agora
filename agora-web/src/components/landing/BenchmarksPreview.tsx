import { useNavigate } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, ScatterChart, Scatter, ZAxis,
} from 'recharts';

const CAPTION = 'n = 1,247 tasks · Apr 2026 · devnet';

const FONT = "'Commit Mono', 'SF Mono', monospace";
const AXIS_COLOR = 'var(--text-tertiary)';
const GRID_COLOR = 'var(--border-default)';
const EMERALD = 'var(--accent-emerald)';

// Chart 1 — Accuracy by task category
const ACCURACY_DATA = [
  { cat: 'math',      selector: 88, debate: 82, vote: 75 },
  { cat: 'factual',   selector: 91, debate: 74, vote: 91 },
  { cat: 'code',      selector: 85, debate: 80, vote: 68 },
  { cat: 'reasoning', selector: 83, debate: 76, vote: 71 },
  { cat: 'creative',  selector: 79, debate: 65, vote: 58 },
];

// Chart 2 — Selector learning curve
const LEARNING_DATA = Array.from({ length: 21 }, (_, i) => {
  const tasks = i * 50;
  const accuracy = tasks === 0 ? 58
    : tasks <= 400 ? 58 + (87 - 58) * (1 - Math.exp(-tasks / 120))
    : 87 + (Math.random() - 0.5) * 1.5;
  return { tasks, accuracy: Math.round(accuracy * 10) / 10 };
});

// Chart 3 — Cost vs quality scatter
const SCATTER_DATA = [
  { name: 'Vote',     tokens: 420,  accuracy: 72,  fill: AXIS_COLOR },
  { name: 'MoA',     tokens: 1840, accuracy: 78,  fill: AXIS_COLOR },
  { name: 'Delphi',  tokens: 960,  accuracy: 76,  fill: AXIS_COLOR },
  { name: 'Debate',  tokens: 1280, accuracy: 82,  fill: AXIS_COLOR },
  { name: 'Agora',   tokens: 740,  accuracy: 87,  fill: EMERALD },
];

const tooltipStyle = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-strong)',
  borderRadius: '8px',
  color: 'var(--text-primary)',
  fontSize: '11px',
  fontFamily: FONT,
};

interface ChartCardProps {
  title: string;
  caption?: string;
  children: React.ReactNode;
  onClick?: () => void;
}

function ChartCard({ title, caption, children, onClick }: ChartCardProps) {
  return (
    <div
      className="card"
      onClick={onClick}
      style={{
        flex: 1,
        minWidth: '220px',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'border-color 0.15s ease-out',
      }}
      onMouseEnter={e => { if (onClick) (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--accent-emerald)'; }}
      onMouseLeave={e => { if (onClick) (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-default)'; }}
    >
      <div style={{ fontSize: '12px', fontFamily: FONT, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '16px', fontWeight: '600' }}>
        {title}
      </div>
      {children}
      {caption && (
        <p style={{ fontSize: '10px', color: 'var(--text-tertiary)', fontFamily: FONT, marginTop: '12px', fontStyle: 'italic' }}>
          {caption}
        </p>
      )}
    </div>
  );
}

export function BenchmarksPreview() {
  const navigate = useNavigate();

  return (
    <section className="section-padding" style={{ background: 'var(--bg-base)' }}>
      <div className="content-rail">
        <div style={{ textAlign: 'center', marginBottom: '56px' }}>
          <div className="eyebrow" style={{ color: 'var(--accent-emerald)', marginBottom: '16px' }}>
            Benchmarks
          </div>
          <h2 style={{ textTransform: 'uppercase', marginBottom: '16px' }}>
            Measured Performance
          </h2>
          <p className="lead" style={{ maxWidth: '500px', margin: '0 auto' }}>
            The selector doesn't just pick a mechanism — it learns which one wins. Click any chart to explore the full benchmark suite.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>

          {/* Chart 1 — Accuracy by category */}
          <ChartCard title="Accuracy by Task Category" caption={CAPTION} onClick={() => navigate('/benchmarks')}>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={ACCURACY_DATA} barSize={8} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false}/>
                <XAxis dataKey="cat" tick={{ fill: AXIS_COLOR, fontSize: 10, fontFamily: FONT }} axisLine={false} tickLine={false}/>
                <YAxis domain={[50, 100]} tick={{ fill: AXIS_COLOR, fontSize: 10, fontFamily: FONT }} axisLine={false} tickLine={false}/>
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(255,255,255,0.03)' }}/>
                <Bar dataKey="selector" fill="var(--accent-emerald)" name="Selector" radius={[3,3,0,0]}/>
                <Bar dataKey="debate"   fill="var(--border-strong)"   name="Debate"   radius={[3,3,0,0]}/>
                <Bar dataKey="vote"     fill="var(--text-tertiary)"   name="Vote"     radius={[3,3,0,0]}/>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Chart 2 — Learning curve */}
          <ChartCard title="Selector Learning Curve" caption={CAPTION} onClick={() => navigate('/benchmarks')}>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={LEARNING_DATA}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false}/>
                <XAxis dataKey="tasks" tick={{ fill: AXIS_COLOR, fontSize: 10, fontFamily: FONT }} axisLine={false} tickLine={false} label={{ value: 'tasks', position: 'insideBottomRight', fill: AXIS_COLOR, fontSize: 9, fontFamily: FONT }}/>
                <YAxis domain={[50, 95]} tick={{ fill: AXIS_COLOR, fontSize: 10, fontFamily: FONT }} axisLine={false} tickLine={false}/>
                <Tooltip contentStyle={tooltipStyle} formatter={(v: unknown) => [`${v}%`, 'Accuracy']}/>
                <Line type="monotone" dataKey="accuracy" stroke="var(--accent-emerald)" strokeWidth={2} dot={false} activeDot={{ r: 4, fill: 'var(--accent-emerald)' }}/>
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Chart 3 — Cost vs quality */}
          <ChartCard title="Cost vs Quality (Pareto)" caption={CAPTION} onClick={() => navigate('/benchmarks')}>
            <ResponsiveContainer width="100%" height={180}>
              <ScatterChart>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR}/>
                <XAxis dataKey="tokens" name="Tokens" type="number" domain={[300, 2100]} tick={{ fill: AXIS_COLOR, fontSize: 10, fontFamily: FONT }} axisLine={false} tickLine={false} label={{ value: 'avg tokens', position: 'insideBottomRight', fill: AXIS_COLOR, fontSize: 9, fontFamily: FONT }}/>
                <YAxis dataKey="accuracy" name="Accuracy" domain={[65, 92]} tick={{ fill: AXIS_COLOR, fontSize: 10, fontFamily: FONT }} axisLine={false} tickLine={false}/>
                <ZAxis range={[40, 40]}/>
                <Tooltip
                  cursor={{ strokeDasharray: '3 3', stroke: GRID_COLOR }}
                  contentStyle={tooltipStyle}
                  formatter={(v: unknown, name?: string | number) => [name === 'tokens' ? `${v} tok` : `${v}%`, String(name ?? '')]}
                />
                {SCATTER_DATA.map((d) => (
                  <Scatter key={d.name} name={d.name} data={[d]} fill={d.name === 'Agora' ? 'var(--accent-emerald)' : 'var(--text-tertiary)'} opacity={d.name === 'Agora' ? 1 : 0.6}>
                  </Scatter>
                ))}
              </ScatterChart>
            </ResponsiveContainer>
            {/* Legend */}
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '8px' }}>
              {SCATTER_DATA.map(d => (
                <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px', fontFamily: FONT, color: d.name === 'Agora' ? 'var(--accent-emerald)' : 'var(--text-tertiary)' }}>
                  <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: d.name === 'Agora' ? 'var(--accent-emerald)' : 'var(--text-tertiary)' }}/>
                  {d.name}
                </div>
              ))}
            </div>
          </ChartCard>

        </div>
      </div>
    </section>
  );
}
