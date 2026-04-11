import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { streamDeliberation } from '../lib/api';
import { TypewriterText } from '../components/TypewriterText';
import { ConvergenceMeter } from '../components/ConvergenceMeter';
import { CheckCircle2, Zap } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export function LiveDeliberation() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  
  const [events, setEvents] = useState<any[]>([]);
  const [convergence, setConvergence] = useState({ entropy: 1.0, infoGain: 0.0, lockedClaims: [] as any[]});
  const [prevEntropy, setPrevEntropy] = useState(1.0);
  const [isQuorum, setIsQuorum] = useState(false);
  const [finalAnswer, setFinalAnswer] = useState<{text: string, confidence: number} | null>(null);

  useEffect(() => {
    let stream: any;
    streamDeliberation(taskId || '', (event) => {
      if (event.type === 'agent_output') {
        setEvents(prev => [...prev, event]);
      } else if (event.type === 'convergence') {
        setPrevEntropy(convergence.entropy);
        setConvergence({
          entropy: event.entropy,
          infoGain: event.infoGain,
          lockedClaims: event.lockedClaims || []
        });
      } else if (event.type === 'receipt' && event.status === 'quorum_reached') {
        setIsQuorum(true);
        setFinalAnswer({ text: event.finalAnswer, confidence: event.confidence });
      }
    }).then(s => stream = s);

    return () => {
      if (stream) stream.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const proponents = events.filter(e => e.faction === 'proponent');
  const opponents = events.filter(e => e.faction === 'opponent');
  const devilAdvocates = events.filter(e => e.faction === 'devil_advocate');

  return (
    <div className="relative">
      {/* Scanline overlay */}
      <div 
        className="fixed inset-0 pointer-events-none z-[100] opacity-5"
        style={{ 
          background: 'linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.25) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.06), rgba(0, 255, 0, 0.02), rgba(0, 0, 255, 0.06))',
          backgroundSize: '100% 4px, 6px 100%'
        }} 
      />

      <header className="flex flex-col md:flex-row md:items-center justify-between pb-6 border-b border-border-subtle mb-8 gap-4 md:gap-0">
        <div>
          <div className="mono text-text-muted text-sm mb-2">TASK {taskId}</div>
          <h2 className="text-xl md:text-2xl max-w-[800px]">Should a startup with 3 engineers use microservices or a monolith?</h2>
        </div>
        <div className="flex items-center gap-4">
          <span className="badge">DEBATE (91%)</span>
          <div className={`mono flex items-center gap-2 ${isQuorum ? 'text-accent' : 'text-text-secondary'}`}>
             ROUND {Math.floor(events.length / 3) + 1}
             <div className={`w-2 h-2 rounded-full ${isQuorum ? 'bg-accent' : 'bg-danger animate-[shimmer_1.5s_infinite]'}`} />
             {isQuorum ? 'COMPLETED' : 'LIVE'}
          </div>
        </div>
      </header>

      {/* Quorum Banner */}
      <AnimatePresence>
        {isQuorum && finalAnswer && (
          <motion.div 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-6 bg-accent-muted border border-accent rounded-xl mb-8 shadow-[var(--shadow-glow)]"
          >
            <div className="flex items-center gap-3 mb-3 text-accent">
              <CheckCircle2 size={24} />
              <h3 className="text-accent text-lg">QUORUM REACHED</h3>
            </div>
            <p className="text-lg text-text-primary mb-4">{finalAnswer.text}</p>
            <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 sm:gap-0">
               <div className="mono text-accent">Confidence: {(finalAnswer.confidence * 100).toFixed(1)}%</div>
               <button className="btn-primary flex items-center justify-center gap-2" onClick={() => navigate(`/task/${taskId}/receipt`)}>View On-Chain Receipt &rarr;</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ConvergenceMeter 
        entropy={convergence.entropy} 
        prevEntropy={prevEntropy} 
        infoGain={convergence.infoGain} 
        lockedClaims={convergence.lockedClaims.length} 
      />

      {/* Debate Factions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        
        {/* Proponents */}
        <div className="border-l-2 border-proponent pl-6">
          <h3 className="mono text-proponent text-sm mb-6 tracking-widest">PROPONENTS</h3>
          {proponents.map((e, idx) => (
            <motion.div key={idx} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} className="mb-6">
              <div className="mono text-text-muted text-xs mb-2">{e.agentId}</div>
              <div className="card p-4 bg-void">
                <TypewriterText text={e.text} speed={10} />
              </div>
            </motion.div>
          ))}
        </div>

        {/* Opponents */}
        <div className="border-l-2 border-opponent pl-6">
          <h3 className="mono text-opponent text-sm mb-6 tracking-widest">OPPONENTS</h3>
          {opponents.map((e, idx) => (
            <motion.div key={idx} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} className="mb-6">
              <div className="mono text-text-muted text-xs mb-2">{e.agentId}</div>
              <div className="card p-4 bg-void">
                <TypewriterText text={e.text} speed={10} />
              </div>
            </motion.div>
          ))}
        </div>
      </div>

      {/* Devil's Advocate */}
      {devilAdvocates.length > 0 && (
         <div className="border-l-2 border-devil-advocate pl-6 mb-10">
           <h3 className="mono text-devil-advocate text-sm mb-6 tracking-widest flex items-center gap-2">
             <Zap size={14} /> DEVIL'S ADVOCATE
           </h3>
           <div className="grid grid-cols-1 gap-6">
               {devilAdvocates.map((e, idx) => (
                 <motion.div key={idx} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
                   <div className="mono text-text-muted text-xs mb-2">{e.agentId}</div>
                   <div className="card p-4 bg-void">
                     <TypewriterText text={e.text} speed={15} />
                   </div>
                 </motion.div>
               ))}
           </div>
         </div>
      )}

      {/* Verified Claims */}
      {convergence.lockedClaims.length > 0 && (
         <div className="p-6 border border-border-subtle rounded-xl bg-surface">
           <h3 className="mono text-sm mb-4 text-accent">VERIFIED CLAIMS</h3>
           {convergence.lockedClaims.map((claim, idx) => (
             <motion.div key={idx} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="flex gap-3 items-start mb-4">
               <CheckCircle2 className="text-accent flex-shrink-0 mt-0.5" size={18} />
               <div>
                  <p className="text-text-primary mb-1">"{claim.text}"</p>
                  <p className="mono text-xs text-text-muted">Verified by: {claim.method}</p>
               </div>
             </motion.div>
           ))}
         </div>
      )}
      
    </div>
  );
}
