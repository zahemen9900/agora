import { motion } from 'framer-motion';
import { Brain, Swords, Users, Cpu, FileText, Database } from 'lucide-react';

// Node configurations
const nodes = [
  { id: 'task', label: 'User Task', type: 'input', x: 50, y: 250, icon: FileText, color: 'text-text-secondary' },
  { id: 'orchestrator', label: 'Orchestrator', type: 'core', x: 280, y: 250, icon: Brain, color: 'text-accent' },
  { id: 'debate', label: 'Debate', type: 'mechanism', x: 550, y: 120, icon: Swords, color: 'text-proponent' },
  { id: 'delphi', label: 'Delphi', type: 'mechanism', x: 550, y: 250, icon: Database, color: 'text-opponent' },
  { id: 'vote', label: 'Vote', type: 'mechanism', x: 550, y: 380, icon: Users, color: 'text-devil-advocate' },
  { id: 'solana', label: 'Verified Proof', type: 'output', x: 820, y: 250, icon: Cpu, color: 'text-accent' },
];

// SVG straight lines between nodes, but we can make them curved for that 'mermaid' look
const createPath = (x1: number, y1: number, x2: number, y2: number) => {
  const midX = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
};

const paths = [
  { id: 't-o', d: createPath(180, 250, 280, 250), delay: 0 },
  { id: 'o-d', d: createPath(410, 250, 550, 120), delay: 1 },
  { id: 'o-dl', d: createPath(410, 250, 550, 250), delay: 1.2 },
  { id: 'o-v', d: createPath(410, 250, 550, 380), delay: 1.4 },
  { id: 'd-s', d: createPath(680, 120, 820, 250), delay: 2 },
  { id: 'dl-s', d: createPath(680, 250, 820, 250), delay: 2.2 },
  { id: 'v-s', d: createPath(680, 380, 820, 250), delay: 2.4 },
];

export function SystemFlowMock() {
  return (
    <div className="absolute inset-0 pointer-events-none z-0 overflow-hidden flex items-center justify-center opacity-40 md:opacity-80">
      <svg 
        viewBox="0 0 1000 500" 
        className="w-full max-w-[1200px]" 
        style={{ filter: 'drop-shadow(0 0 20px rgba(0, 212, 170, 0.1))' }}
      >
        <defs>
          {/* Animated Gradient for Paths */}
          <linearGradient id="flow-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--border-accent)" stopOpacity="0" />
            <stop offset="50%" stopColor="var(--color-accent)" stopOpacity="1" />
            <stop offset="100%" stopColor="var(--border-accent)" stopOpacity="0" />
          </linearGradient>

          {/* Glow filter */}
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
            <feMerge>
              <feMergeNode in="coloredBlur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
        </defs>

        {/* Base edges (dark) */}
        {paths.map((path) => (
          <path
            key={`base-${path.id}`}
            d={path.d}
            fill="none"
            stroke="var(--border-muted)"
            strokeWidth="2"
            opacity="0.3"
          />
        ))}

        {/* Animated edges */}
        {paths.map((path) => (
          <motion.path
            key={`anim-${path.id}`}
            d={path.d}
            fill="none"
            stroke="url(#flow-gradient)"
            strokeWidth="3"
            filter="url(#glow)"
            strokeDasharray="200"
            animate={{
              strokeDashoffset: [200, -200],
            }}
            transition={{
              duration: 3,
              ease: "linear",
              repeat: Infinity,
              delay: path.delay,
            }}
          />
        ))}

        {/* Nodes using foreignObject mapped to HTML chunks */}
        {nodes.map((node) => {
          const Icon = node.icon;
          return (
            <foreignObject
              key={node.id}
              x={node.x - 65} // center horizontally (130px width)
              y={node.y - 40} // center vertically (80px height)
              width="130"
              height="80"
              className="overflow-visible"
            >
              <motion.div
                className="flex flex-col items-center justify-center p-3 rounded-xl bg-elevated border border-border-muted shadow-lg"
                style={{ backdropFilter: 'blur(10px)' }}
                whileHover={{ scale: 1.05 }}
                animate={{ y: [0, -5, 0] }}
                transition={{
                  duration: 4,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: node.x * 0.005,
                }}
              >
                <Icon size={24} className={`mb-1 ${node.color}`} />
                <span className="text-[11px] font-semibold tracking-wider uppercase text-text-primary whitespace-nowrap">
                  {node.label}
                </span>
              </motion.div>
            </foreignObject>
          );
        })}

        {/* Data Packets (Pulsing Dots) */}
        {paths.map((path) => (
           <motion.circle
             key={`dot-${path.id}`}
             r="4"
             fill="var(--color-accent)"
             filter="url(#glow)"
           >
             <animateMotion
               dur="3s"
               repeatCount="indefinite"
               path={path.d}
               begin={`${path.delay}s`}
             />
           </motion.circle>
        ))}

      </svg>
    </div>
  );
}
