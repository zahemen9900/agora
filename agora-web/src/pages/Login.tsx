import { ArrowRight, Brain, Link as LinkIcon, Swords } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { FloatingElements } from '../components/FloatingElements';

export function LoginPage() {
  const { signIn, isLoading } = useAuth();

  return (
    <div className="min-h-screen flex flex-col p-6 md:p-10">
      <div 
        className="absolute top-[-10%] left-[10%] right-[10%] md:left-[20%] md:right-[20%] h-[30vh] bg-accent-muted blur-[100px] opacity-50 pointer-events-none"
      />

      <header className="flex justify-between items-center max-w-[1200px] mx-auto w-full z-10">
        <div className="wordmark text-2xl tracking-widest">AGORA</div>
        <button onClick={signIn} disabled={isLoading} className="btn-secondary text-sm px-4 py-2">
          {isLoading ? 'Connecting...' : 'Sign In'}
        </button>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center max-w-[1000px] mx-auto mt-20 mb-10 z-10 w-full">
        
        {/* HERO */}
        <div className="text-center mb-20 relative w-full py-10">
          <FloatingElements />
          <h1 className="text-5xl md:text-7xl mb-6 tracking-tight relative z-10 font-bold">Proof of Deliberation</h1>
          <p className="text-lg md:text-xl max-w-[700px] mx-auto mb-10 text-text-secondary relative z-10">
            An on-chain orchestration primitive where AI agents debate, vote, and reach consensus — with every step cryptographically verified on Solana.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center relative z-10">
            <button onClick={signIn} disabled={isLoading} className="btn-primary text-base px-8 py-4">
              Launch App <ArrowRight size={18} />
            </button>
            <a href="https://github.com" target="_blank" rel="noopener noreferrer" className="btn-secondary inline-flex items-center justify-center text-base px-8 py-4">
              Read the Docs ↗
            </a>
          </div>
        </div>

        {/* 3-STEP */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full mb-24">
          
          <div className="card p-8">
            <div className="l-corners" />
            <Brain size={32} className="text-text-muted mb-6" />
            <h3 className="mb-3 text-xl font-semibold">The AI Decides How to Decide</h3>
            <p className="text-[0.95rem] text-text-secondary">A Thompson Sampling bandit + LLM reasoning agent analyzes your task and selects the optimal mechanism — debate, vote, or Delphi consensus.</p>
          </div>

          <div className="card p-8">
            <div className="l-corners" />
            <Swords size={32} className="text-text-muted mb-6" />
            <h3 className="mb-3 text-xl font-semibold">Agents Deliberate with Structure</h3>
            <p className="text-[0.95rem] text-text-secondary">Factional adversarial debate with Devil's Advocate cross-examination. Or confidence-calibrated voting with surprising-popularity weighting.</p>
          </div>

          <div className="card p-8">
            <div className="l-corners" />
            <LinkIcon size={32} className="text-text-muted mb-6" />
            <h3 className="mb-3 text-xl font-semibold">Every Step Verified On-Chain</h3>
            <p className="text-[0.95rem] text-text-secondary">Arguments, votes, and mechanism switches are Merkle-hashed and committed to Solana. Anyone can recompute the proof.</p>
          </div>

        </div>

        {/* PROBLEM FIX */}
        <div className="text-left w-full mb-24 grid grid-cols-1 lg:grid-cols-2 gap-16">
          <div>
            <div className="mono text-accent text-sm mb-4">THE PROBLEM</div>
            <h2 className="text-3xl md:text-4xl mb-6">Multi-agent debate is a martingale.</h2>
            <p className="text-lg text-text-secondary leading-relaxed">
              The most cited multi-agent debate paper of 2025 — Li et al., NeurIPS Spotlight — proved that unguided AI debate doesn't inherently improve correctness. The gains attributed to debate are often just majority voting in disguise. If agents start with a wrong prior, they'll debate themselves deeper into it.
            </p>
          </div>
          <div>
            <div className="mono text-accent text-sm mb-4">THE FIX</div>
            <h2 className="text-3xl md:text-4xl mb-6">An orchestrator that reasons, learns, and proves.</h2>
            <p className="text-lg text-text-secondary leading-relaxed">
              Agora breaks the martingale with three structural innovations: a mechanism selector that learns from outcomes, debate protocols that make sycophantic convergence architecturally impossible, and on-chain verification of every step of the governance process.
            </p>
          </div>
        </div>
      </main>

      <footer className="border-t border-border-subtle py-8 text-center text-text-muted">
        <p className="wordmark mb-2 text-text-secondary tracking-widest">AGORA PROTOCOL</p>
        <p className="text-sm">Built for Colosseum Frontier × SWARM • Team: Dave, Josh, Joshua Ddf</p>
      </footer>
    </div>
  );
}
