import { ArrowRight, Brain, Link as LinkIcon, Swords } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { SystemFlowMock } from '../components/SystemFlowMock';
import { InteractiveCard } from '../components/InteractiveCard';
import { Button } from '../components/ui/Button';
import { motion } from 'framer-motion';

export function LoginPage() {
  const { signIn, isLoading } = useAuth();

  return (
    <div className="flex flex-col">

      {/* ── HERO SECTION (full viewport) ── */}
      <section className="relative min-h-screen flex flex-col px-6 md:px-10 overflow-hidden">

        {/* Ambient glow */}
        <div className="absolute top-[-10%] left-[10%] right-[10%] md:left-[20%] md:right-[20%] h-[30vh] bg-accent-muted blur-[100px] opacity-50 pointer-events-none" />

        {/* NAV — with bottom border as section divider */}
        <header className="flex justify-between items-center max-w-[1200px] mx-auto w-full z-20 py-6">
          <div className="wordmark text-2xl tracking-widest">AGORA</div>
          <button onClick={signIn} disabled={isLoading} className="btn-secondary text-sm px-4 py-2">
            {isLoading ? 'Connecting...' : 'Sign In'}
          </button>
        </header>

        {/* HERO Background Animation (SystemFlowMock) */}
        <SystemFlowMock />

        {/* HERO CONTENT — centered in remaining space */}
        <div className="flex-1 flex flex-col items-center justify-center text-center max-w-[1000px] mx-auto w-full relative z-10 pb-16">
          <motion.h1 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            className="mb-6 tracking-tight font-bold mix-blend-plus-lighter drop-shadow-2xl"
          >
            Proof of Deliberation
          </motion.h1>
          
          <motion.p 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.2, ease: "easeOut" }}
            className="max-w-[700px] mx-auto mb-10 text-text-secondary md:text-lg backdrop-blur-sm bg-background/30 p-4 rounded-2xl"
          >
            An on-chain orchestration primitive where AI agents debate, vote, and reach consensus — with every step cryptographically verified on Solana.
          </motion.p>
          
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, delay: 0.4, ease: "easeOut" }}
            className="flex flex-col sm:flex-row gap-4 justify-center"
          >
            <Button
              variant="primary"
              size="md"
              onClick={signIn}
              disabled={isLoading}
              rightIcon={<ArrowRight size={18} />}
              className="shadow-[0_0_20px_rgba(0,212,170,0.3)] hover:shadow-[0_0_30px_rgba(0,212,170,0.5)] transition-shadow duration-300"
            >
              {isLoading ? 'Connecting...' : 'Launch App'}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => window.open('https://github.com', '_blank')}
              rightIcon={<ArrowRight size={18} />}
            >
              Read the Docs
            </Button>
          </motion.div>
        </div>
      </section>

      {/* ── BELOW-THE-FOLD CONTENT ── */}
      <main className="flex flex-col items-center max-w-[1300px] mx-auto w-full px-6 md:px-10 z-10">

        {/* 3-STEP SECTION */}
        <div className="w-full py-32">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 w-full">
            <InteractiveCard
              delay={0.1}
              colorVar="var(--color-text-muted)"
              icon={
                <Brain 
                  className="w-20 h-20 text-text-muted opacity-80" 
                  strokeWidth={1.5}
                />
              }
              title={
                <span>The AI Decides<br />How to Decide</span>
              }
              description="A Thompson Sampling bandit + LLM reasoning agent analyzes your task and selects the optimal mechanism — debate, vote, or Delphi consensus."
            />
            
            <InteractiveCard
              delay={0.3}
              colorVar="var(--color-accent)"
              icon={
                <Swords 
                  className="w-20 h-20 text-accent opacity-90" 
                  strokeWidth={1.5} 
                />
              }
              title={
                <span className="text-accent">Agents Deliberate<br />with Structure</span>
              }
              description="Factional adversarial debate with Devil's Advocate cross-examination. Or confidence-calibrated voting with surprising-popularity weighting."
            />
            
            <InteractiveCard
              delay={0.5}
              colorVar="var(--color-border-accent)"
              icon={
                <LinkIcon 
                  className="w-20 h-20 text-border-accent opacity-80" 
                  strokeWidth={1.5}
                />
              }
              title={
                <span>Every Step<br />Verified On-Chain</span>
              }
              description="Arguments, votes, and mechanism switches are Merkle-hashed and committed to Solana. Anyone can recompute the proof."
            />
          </div>
        </div>

        {/* PROBLEM / FIX — bordered section */}
        <motion.div 
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.8 }}
          className="w-full pb-32 pt-16 grid grid-cols-1 lg:grid-cols-2 gap-16 text-left relative"
        >
          {/* Subtle separator line above */}
          <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-border-muted to-transparent" />
          
          <div>
            <div className="mono text-accent text-sm mb-4 tracking-widest font-bold">THE PROBLEM</div>
            <h4 className="mb-6 font-semibold">Multi-agent debate is a martingale.</h4>
            <p className="text-text-secondary leading-relaxed text-lg">
              The most cited multi-agent debate paper of 2025 — Li et al., NeurIPS Spotlight — proved that unguided AI debate doesn't inherently improve correctness. The gains attributed to debate are often just majority voting in disguise. If agents start with a wrong prior, they'll debate themselves deeper into it.
            </p>
          </div>
          <div>
            <div className="mono text-accent text-sm mb-4 tracking-widest font-bold">THE FIX</div>
            <h4 className="mb-6 font-semibold">An orchestrator that reasons, learns, and proves.</h4>
            <p className="text-text-secondary leading-relaxed text-lg">
              Agora breaks the martingale with three structural innovations: a mechanism selector that learns from outcomes, debate protocols that make sycophantic convergence architecturally impossible, and on-chain verification of every step of the governance process.
            </p>
          </div>
        </motion.div>

      </main>

      <footer className="py-16 mt-12 text-center text-text-muted relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-background-elevated/20 pointer-events-none" />
        <p className="wordmark mb-2 text-text-secondary tracking-widest relative z-10">AGORA PROTOCOL</p>
        <p className="text-sm relative z-10">Built for Colosseum Frontier × SWARM • Team: Dave, Josh, Joshua Ddf</p>
      </footer>
    </div>
  );
}
