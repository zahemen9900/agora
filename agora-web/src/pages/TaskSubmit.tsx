import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { submitTask } from '../lib/api';
import { MOCK_TASKS } from '../lib/mock';
import { ChevronRight, Loader2, Play } from 'lucide-react';

export function TaskSubmit() {
  const navigate = useNavigate();
  const [taskText, setTaskText] = useState('');
  const [agentCount, setAgentCount] = useState(3);
  const [stakes, setStakes] = useState('0.00');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mechanismReveal, setMechanismReveal] = useState<{mechanism: string, confidence: number, reasoning: string} | null>(null);

  const handleSubmit = async () => {
    if (!taskText.trim()) return;
    
    setIsSubmitting(true);
    setMechanismReveal(null);
    try {
      const res = await submitTask(taskText, agentCount, parseFloat(stakes) || 0);
      setMechanismReveal({ mechanism: res.mechanism, confidence: res.confidence, reasoning: res.reasoning });
      
      // Auto-navigate after a brief reveal pause
      setTimeout(() => {
        navigate(`/task/${res.taskId}`);
      }, 3000);
    } catch (e) {
      console.error(e);
      setIsSubmitting(false);
    }
  };

  const setExampleTask = (task: string) => {
    setTaskText(task);
  };

  return (
    <div className="max-w-[800px] mx-auto mt-10">
      <div className="text-center mb-10">
        <h1 className="mb-4 text-3xl md:text-5xl">What should your agents deliberate on?</h1>
        <p className="text-text-secondary text-lg">
          Agora will analyze your task, select the optimal mechanism, and execute with full transparency.
        </p>
      </div>

      <div className="card p-8 mb-16">
        <div className="l-corners" />
        
        <textarea 
          className="mono w-full min-h-[120px] bg-void text-text-primary border border-border-subtle rounded-lg p-4 text-base resize-none outline-none mb-6 focus:border-accent transition-colors"
          placeholder="Enter a question, decision, or problem for multi-agent deliberation..."
          value={taskText}
          onChange={(e) => {
            setTaskText(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = e.target.scrollHeight + 'px';
          }}
        />

        <div className="flex flex-col md:flex-row justify-between items-start md:items-end flex-wrap gap-6">
          <div className="flex flex-col sm:flex-row gap-6 w-full md:w-auto">
            <div>
              <div className="mono text-text-muted text-xs mb-2">AGENTS</div>
              <div className="flex gap-2">
                {[3, 5, 7].map(num => (
                  <button 
                    key={num}
                    onClick={() => setAgentCount(num)}
                    className={`mono px-4 py-1.5 rounded-full text-sm border transition-colors ${
                      agentCount === num 
                        ? 'bg-accent-muted text-accent border-accent' 
                        : 'bg-void text-text-secondary border-border-muted hover:border-text-muted'
                    }`}
                  >
                    {num}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="mono text-text-muted text-xs mb-2">STAKES (SOL)</div>
              <input 
                type="text"
                value={stakes}
                onChange={(e) => setStakes(e.target.value)}
                className="mono bg-void text-text-primary border border-border-muted py-1.5 px-3 rounded-md w-[100px] outline-none focus:border-accent transition-colors"
              />
            </div>
          </div>

          <button 
            className="btn-primary w-full md:w-auto" 
            onClick={handleSubmit} 
            disabled={isSubmitting || !taskText.trim()}
          >
            {isSubmitting && !mechanismReveal ? (
              <><Loader2 className="animate-spin" size={18} /> Analyzing task features...</>
            ) : mechanismReveal ? (
              <><Loader2 className="animate-spin" size={18} /> Routing to {mechanismReveal.mechanism}...</>
            ) : (
              <>Submit to Agora <ChevronRight size={18} /></>
            )}
          </button>
        </div>

        {/* INLINE REVEAL */}
        {mechanismReveal && (
           <div className="mt-8 p-4 bg-accent-muted border-l-4 border-accent rounded-r-lg animate-[shimmer_2s_ease-out]">
             <div className="flex items-center gap-2 mb-2">
                <span className="badge">ROUTED</span>
                <span className="font-medium">Agora selected {mechanismReveal.mechanism} with {(mechanismReveal.confidence * 100).toFixed(0)}% confidence</span>
             </div>
             <p className="text-sm m-0 text-text-secondary">{mechanismReveal.reasoning}</p>
           </div>
        )}
      </div>

      <div className="mt-16">
        <h2 className="text-xl mb-6">Recent Deliberations</h2>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {MOCK_TASKS.map(task => (
            <div key={task.id} className="card p-5 flex flex-col">
              <div className="l-corners" />
              <p className="text-[0.95rem] mb-4 flex-1 text-text-primary">
                "{task.title.length > 60 ? task.title.substring(0, 60) + '...' : task.title}"
              </p>
              
              <div className="flex justify-between items-center mb-4">
                <span className="badge">{task.mechanism}</span>
                {task.quorum ? 
                  <span className="text-accent text-sm">✓ Quorum</span> : 
                  <span className="text-text-muted text-sm">⨯ Failed</span>
                }
              </div>

              <div className="mono text-text-muted text-xs flex justify-between">
                <span>{task.latency} • {task.tokens} tok</span>
                <span>{task.merkleRoot}</span>
              </div>
              
              <button 
                onClick={() => setExampleTask(task.title)}
                className="btn-secondary w-full mt-4 p-2 text-sm flex justify-center gap-2"
              >
                <Play size={14} /> Try this task
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
