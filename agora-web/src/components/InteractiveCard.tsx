import { ReactNode } from 'react';
import { motion } from 'framer-motion';

interface InteractiveCardProps {
  title: ReactNode;
  description: ReactNode;
  icon: ReactNode;
  delay?: number;
  colorVar: string;
}

export function InteractiveCard({ title, description, icon, delay = 0, colorVar }: InteractiveCardProps) {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-50px" }}
      transition={{ duration: 0.6, delay, ease: 'easeOut' }}
      whileHover="hover"
      className="relative flex flex-col rounded-2xl overflow-hidden cursor-pointer group"
      style={{ 
        background: 'var(--bg-elevated)', 
        border: '1px solid var(--border-muted)',
        minHeight: '420px' 
      }}
    >
      {/* Dynamic Glow Background on Hover */}
      <motion.div 
        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 ease-out pointer-events-none"
        style={{
          background: `radial-gradient(circle at 50% 0%, ${colorVar}20 0%, transparent 60%)`
        }}
      />

      {/* Icon Zone with Interactive Animation */}
      <div 
        className="flex-1 flex items-center justify-center p-10 relative overflow-hidden" 
        style={{ background: 'var(--bg-overlay)' }}
      >
        <motion.div
          variants={{
             hover: { scale: 1.1, y: -5, filter: 'drop-shadow(0px 10px 10px rgba(0,0,0,0.2))' }
          }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
          className="z-10"
        >
          {icon}
        </motion.div>
        
        {/* Subtle grid pattern behind the icon */}
        <div className="absolute inset-0 opacity-10" 
             style={{ backgroundImage: 'radial-gradient(var(--text-muted) 1px, transparent 0)', backgroundSize: '20px 20px' }} />
      </div>

      {/* Text Zone */}
      <div className="p-8 relative z-10 bg-elevated/50 backdrop-blur-md border-t border-border-muted/50">
        <h4 className="mb-3 font-semibold uppercase tracking-wide transition-colors duration-300 group-hover:text-text-primary">
          {title}
        </h4>
        <p className="text-text-secondary text-sm leading-relaxed transition-colors duration-300 group-hover:text-text-primary">
          {description}
        </p>
      </div>

    </motion.div>
  );
}
