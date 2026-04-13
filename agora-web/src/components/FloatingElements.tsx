import { motion } from 'framer-motion';
import { Brain, Swords, Database, Fingerprint, Cpu, Network } from 'lucide-react';

export function FloatingElements() {
  const elements = [
    {
      id: 1,
      Icon: Brain,
      size: 48,
      initial: { top: '10%', left: '20%' },
      animate: { y: [0, -20, 0], x: [0, 10, 0], rotate: [0, 10, 0] },
      transition: { duration: 8, repeat: Infinity, ease: 'easeInOut' as const },
      blur: 'blur-[3px]',
      opacity: 'opacity-60',
      color: 'var(--color-accent)'
    },
    {
      id: 2,
      Icon: Swords,
      size: 64,
      initial: { top: '55%', left: '15%' },
      animate: { y: [0, 30, 0], rotate: [-15, 10, -15] },
      transition: { duration: 12, repeat: Infinity, ease: 'easeInOut' as const },
      blur: 'blur-[1px]',
      opacity: 'opacity-80',
      color: 'var(--color-proponent)'
    },
    {
      id: 3,
      Icon: Database,
      size: 40,
      initial: { top: '18%', right: '20%' },
      animate: { y: [0, -15, 0], x: [0, -20, 0], rotate: [0, -25, 0] },
      transition: { duration: 10, repeat: Infinity, ease: 'easeInOut' as const, delay: 1 },
      blur: 'blur-[4px]',
      opacity: 'opacity-50',
      color: 'var(--color-text-secondary)'
    },
    {
      id: 4,
      Icon: Fingerprint,
      size: 80,
      initial: { top: '50%', right: '12%' },
      animate: { y: [0, -25, 0], rotate: [10, -10, 10] },
      transition: { duration: 15, repeat: Infinity, ease: 'easeInOut' as const, delay: 2 },
      blur: 'blur-[0px]',
      opacity: 'opacity-90',
      color: 'var(--color-accent)'
    },
    {
      id: 5,
      Icon: Cpu,
      size: 56,
      initial: { top: '5%', left: '50%' },
      animate: { y: [0, 20, 0], x: [0, 15, 0], rotate: [-20, 20, -20] },
      transition: { duration: 11, repeat: Infinity, ease: 'easeInOut' as const, delay: 0.5 },
      blur: 'blur-[2px]',
      opacity: 'opacity-70',
      color: 'var(--color-devil-advocate)'
    },
    {
      id: 6,
      Icon: Network,
      size: 44,
      initial: { bottom: '10%', right: '28%' },
      animate: { y: [0, -20, 0], rotate: [0, 45, 0] },
      transition: { duration: 9, repeat: Infinity, ease: 'easeInOut' as const, delay: 1.5 },
      blur: 'blur-[5px]',
      opacity: 'opacity-40',
      color: 'var(--color-opponent)'
    }
  ];

  return (
    <div className="absolute inset-0 pointer-events-none z-0 overflow-visible">
      {/* Central stylized 3D block */}
      <motion.div
        className="absolute top-[30%] left-1/2 -translate-x-1/2 -translate-y-1/2 w-[260px] h-[260px] bg-surface/40 border border-accent/20 rounded-3xl flex items-center justify-center shadow-[0_0_80px_rgba(0,212,170,0.1),inset_0_0_40px_rgba(0,212,170,0.05)] z-[1]"
        initial={{ rotateX: 30, rotateY: -20, rotateZ: 10 }}
        animate={{ 
          y: [0, 15, 0], 
          rotateX: [30, 40, 30], 
          rotateY: [-20, -10, -20],
          rotateZ: [10, 15, 10]
        }}
        transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut' }}
      >
        <div className="wordmark text-accent/25 text-5xl tracking-widest drop-shadow-[0_0_30px_var(--color-accent)]">AGORA</div>
      </motion.div>

      {/* Floating Icons */}
      {elements.map((el) => {
        const { Icon } = el;
        return (
          <motion.div
            key={el.id}
            className={`absolute flex items-center justify-center rounded-full bg-elevated border border-border-muted shadow-[0_4px_20px_rgba(0,0,0,0.5)] ${el.blur} ${el.opacity}`}
            style={{
              ...el.initial,
              width: el.size,
              height: el.size,
            }}
            animate={el.animate}
            transition={el.transition}
          >
            <Icon size={el.size * 0.5} color={el.color} />
          </motion.div>
        );
      })}
    </div>
  );
}
