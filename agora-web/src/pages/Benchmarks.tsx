import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LineChart, Line } from 'recharts';
import { MOCK_TASKS } from '../lib/mock';
import { useNavigate } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';

const accuracyData = [
  { category: 'Math', debate: 42, vote: 68, selector: 71 },
  { category: 'Reasoning', debate: 81, vote: 45, selector: 80 },
  { category: 'Factual', debate: 52, vote: 92, selector: 91 },
  { category: 'Code', debate: 88, vote: 60, selector: 85 },
  { category: 'Creative', debate: 75, vote: 65, selector: 73 }
];

const learningCurveData = [
  { tasks: 0, accuracy: 55 },
  { tasks: 10, accuracy: 62 },
  { tasks: 20, accuracy: 70 },
  { tasks: 30, accuracy: 74 },
  { tasks: 40, accuracy: 78 },
  { tasks: 50, accuracy: 82 }
];

const costData = [
  { mechanism: 'Vote', avgTokens: 1250 },
  { mechanism: 'Debate', avgTokens: 6800 },
];

export function Benchmarks() {
  const navigate = useNavigate();

  return (
    <div className="max-w-[1000px] mx-auto pb-20 w-full">
      
      <header className="mb-10">
        <h1 className="text-3xl md:text-4xl mb-4">Benchmarks</h1>
        <p className="text-text-secondary text-lg max-w-[600px]">
          How Agora performs across task types, mechanisms, and over time.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8 w-full">
          
        {/* CHART 1 */}
        <div className="card p-4 sm:p-8 col-span-1 lg:col-span-2">
          <h3 className="mb-2 text-lg font-semibold">Accuracy by Task Category × Mechanism</h3>
          <p className="text-sm text-text-secondary mb-8">
            Debate excels on complex reasoning. Voting wins on factual aggregation. The selector learns which to use.
          </p>
          <div className="w-full h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={accuracyData} margin={{ top: 20, right: 10, left: -20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" vertical={false} />
                <XAxis dataKey="category" stroke="var(--color-text-muted)" tick={{ fill: 'var(--color-text-muted)', fontSize: 12, fontFamily: 'JetBrains Mono' }} />
                <YAxis stroke="var(--color-text-muted)" tick={{ fill: 'var(--color-text-muted)', fontSize: 12, fontFamily: 'JetBrains Mono' }} />
                <Tooltip cursor={{ fill: 'var(--color-elevated)' }} />
                <Legend iconType="circle" wrapperStyle={{ fontFamily: 'JetBrains Mono', fontSize: '12px' }} />
                <Bar dataKey="debate" name="Debate Only" fill="var(--color-border-muted)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="vote" name="Vote Only" fill="var(--color-text-muted)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="selector" name="Agora Selector" fill="var(--color-accent)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* CHART 2 */}
        <div className="card p-4 sm:p-8">
          <h3 className="mb-2 text-lg font-semibold">Selector Learning Curve</h3>
          <p className="text-sm text-text-secondary mb-8">
            Thompson Sampling accuracy improves as the system processes more tasks.
          </p>
          <div className="w-full h-[250px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={learningCurveData} margin={{ top: 20, right: 10, left: -20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" vertical={false} />
                <XAxis dataKey="tasks" stroke="var(--color-text-muted)" tick={{ fill: 'var(--color-text-muted)', fontSize: 12, fontFamily: 'JetBrains Mono' }} />
                <YAxis stroke="var(--color-text-muted)" tick={{ fill: 'var(--color-text-muted)', fontSize: 12, fontFamily: 'JetBrains Mono' }} domain={[40, 100]} />
                <Tooltip />
                <Line type="monotone" dataKey="accuracy" stroke="var(--color-accent)" strokeWidth={3} dot={{ fill: 'var(--color-void)', stroke: 'var(--color-accent)', strokeWidth: 2, r: 4 }} activeDot={{ r: 6, fill: 'var(--color-accent)' }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* CHART 3 */}
        <div className="card p-4 sm:p-8">
          <h3 className="mb-2 text-lg font-semibold">Cost Efficiency</h3>
          <p className="text-sm text-text-secondary mb-8">
            Average token cost per mechanism. Debate costs more but produces higher confidence.
          </p>
          <div className="w-full h-[250px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={costData} margin={{ top: 20, right: 10, left: -10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" vertical={false} />
                <XAxis dataKey="mechanism" stroke="var(--color-text-muted)" tick={{ fill: 'var(--color-text-muted)', fontSize: 12, fontFamily: 'JetBrains Mono' }} />
                <YAxis stroke="var(--color-text-muted)" tick={{ fill: 'var(--color-text-muted)', fontSize: 12, fontFamily: 'JetBrains Mono' }} />
                <Tooltip cursor={{ fill: 'var(--color-elevated)' }} />
                <Bar dataKey="avgTokens" name="Avg Tokens" fill="var(--color-text-primary)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* TABLE */}
      <div className="card p-4 sm:p-8 w-full overflow-x-auto">
        <h3 className="mb-6 text-lg font-semibold">Task History</h3>
        
        <table className="w-full min-w-[600px] border-collapse text-left">
          <thead>
            <tr className="border-b border-border-subtle mono text-text-muted text-sm">
              <th className="py-3 px-4 font-medium text-xs tracking-wider">TASK</th>
              <th className="py-3 px-4 font-medium text-xs tracking-wider">MECHANISM</th>
              <th className="py-3 px-4 font-medium text-xs tracking-wider">LATENCY</th>
              <th className="py-3 px-4 font-medium text-xs tracking-wider">ON-CHAIN</th>
            </tr>
          </thead>
          <tbody>
            {MOCK_TASKS.map(task => (
              <tr 
                key={task.id} 
                onClick={() => navigate(`/task/${task.id}/receipt`)}
                className="border-b border-border-subtle cursor-pointer transition-colors hover:bg-elevated"
              >
                <td className="py-4 px-4 w-1/2">
                   <div className="line-clamp-1">{task.title}</div>
                </td>
                <td className="py-4 px-4"><span className="badge">{task.mechanism}</span></td>
                <td className="py-4 px-4 mono text-sm">{task.latency}</td>
                <td className="py-4 px-4">
                  <span className="mono text-accent inline-flex items-center gap-2 text-sm">
                     {task.merkleRoot} <ExternalLink size={14} />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  );
}
