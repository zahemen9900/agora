import { ArrowRight, Brain, Link as LinkIcon, Swords } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { FloatingElements } from '../components/FloatingElements';
import { Button } from '../components/ui/Button';

export function LoginPage() {
  const { signIn, isLoading } = useAuth();

  return (
    <div className="flex flex-col">

      {/* ── HERO SECTION (full viewport) ── */}
      <section className="relative min-h-screen flex flex-col px-6 md:px-10">

        {/* Ambient glow */}
        <div className="absolute top-[-10%] left-[10%] right-[10%] md:left-[20%] md:right-[20%] h-[30vh] bg-accent-muted blur-[100px] opacity-50 pointer-events-none" />

        {/* NAV — with bottom border as section divider */}
        <header className="flex justify-between items-center max-w-[1200px] mx-auto w-full z-10 py-6">
          <div className="wordmark text-2xl tracking-widest">AGORA</div>
          <button onClick={signIn} disabled={isLoading} className="btn-secondary text-sm px-4 py-2">
            {isLoading ? 'Connecting...' : 'Sign In'}
          </button>
        </header>

        {/* HERO CONTENT — centered in remaining space, with vertical rails */}
        <div className="flex-1 flex flex-col items-center justify-center text-center max-w-[1000px] mx-auto w-full relative pb-16">
          <FloatingElements />
          <h1 className="mb-6 tracking-tight relative z-10 font-bold">Proof of Deliberation</h1>
          <p className="max-w-[700px] mx-auto mb-10 text-text-secondary relative z-10">
            An on-chain orchestration primitive where AI agents debate, vote, and reach consensus — with every step cryptographically verified on Solana.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center relative z-10">
            <Button
              variant="primary"
              size="md"
              onClick={signIn}
              disabled={isLoading}
              rightIcon={<ArrowRight size={18} />}
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
          </div>
        </div>


      </section>

      {/* ── BELOW-THE-FOLD CONTENT ── */}
      <main className="flex flex-col items-center max-w-[1300px] mx-auto w-full px-6 md:px-10 z-10">

        {/* 3-STEP — with top/bottom bordered section */}
        <div className="w-full py-32">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full">

            {/* Card 1 — muted surface */}
            <div className="relative flex flex-col rounded-2xl overflow-hidden" style={{ background: 'var(--bg-elevated)', minHeight: '420px' }}>
              {/* Icon zone */}
              <div className="flex-1 flex items-center justify-center p-10" style={{ background: 'var(--bg-overlay)' }}>
                <Brain size={80} style={{ color: 'var(--text-muted)', opacity: 0.6 }} strokeWidth={1} />
              </div>
              {/* Text zone */}
              <div className="p-8">
                <h4 className="mb-3 font-semibold uppercase tracking-wide">The AI Decides<br />How to Decide</h4>
                <p className="text-text-secondary">A Thompson Sampling bandit + LLM reasoning agent analyzes your task and selects the optimal mechanism — debate, vote, or Delphi consensus.</p>
              </div>
            </div>

            {/* Card 2 — accent highlight */}
            <div className="relative flex flex-col rounded-2xl overflow-hidden" style={{ background: 'var(--accent)', minHeight: '420px' }}>
              {/* Icon zone */}
              <div className="flex-1 flex items-center justify-center p-10" style={{ background: 'rgba(0,0,0,0.12)' }}>
                <Swords size={80} style={{ color: 'var(--text-inverse)', opacity: 0.5 }} strokeWidth={1} />
              </div>
              {/* Text zone */}
              <div className="p-8">
                <h4 className="mb-3 font-semibold uppercase tracking-wide" style={{ color: 'var(--text-inverse)' }}>Agents Deliberate<br />with Structure</h4>
                <p style={{ color: 'rgba(0,0,0,0.65)', fontSize: 'var(--text-sm)' }}>Factional adversarial debate with Devil's Advocate cross-examination. Or confidence-calibrated voting with surprising-popularity weighting.</p>
              </div>
            </div>

            {/* Card 3 — light surface */}
            <div className="relative flex flex-col rounded-2xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-muted)', minHeight: '420px' }}>
              {/* Icon zone */}
              <div className="flex-1 flex items-center justify-center p-10" style={{ background: 'var(--bg-elevated)' }}>
                <LinkIcon size={80} style={{ color: 'var(--border-accent)', opacity: 0.5 }} strokeWidth={1} />
              </div>
              {/* Text zone */}
              <div className="p-8">
                <h4 className="mb-3 font-semibold uppercase tracking-wide">Every Step<br />Verified On-Chain</h4>
                <p className="text-text-secondary">Arguments, votes, and mechanism switches are Merkle-hashed and committed to Solana. Anyone can recompute the proof.</p>
              </div>
            </div>

          </div>
        </div>

        {/* PROBLEM / FIX — bordered section */}
        <div className="w-full pb-32 pt-16 grid grid-cols-1 lg:grid-cols-2 gap-16 text-left">
          <div>
            <div className="mono text-accent text-sm mb-4">THE PROBLEM</div>
            <h4 className="mb-6">Multi-agent debate is a martingale.</h4>
            <p className="text-text-secondary leading-relaxed">
              The most cited multi-agent debate paper of 2025 — Li et al., NeurIPS Spotlight — proved that unguided AI debate doesn't inherently improve correctness. The gains attributed to debate are often just majority voting in disguise. If agents start with a wrong prior, they'll debate themselves deeper into it.
            </p>
          </div>
          <div>
            <div className="mono text-accent text-sm mb-4">THE FIX</div>
            <h4 className="mb-6">An orchestrator that reasons, learns, and proves.</h4>
            <p className="text-text-secondary leading-relaxed">
              Agora breaks the martingale with three structural innovations: a mechanism selector that learns from outcomes, debate protocols that make sycophantic convergence architecturally impossible, and on-chain verification of every step of the governance process.
            </p>
          </div>
        </div>

      </main>

      <footer className="py-16 mt-12 text-center text-text-muted">
        <p className="wordmark mb-2 text-text-secondary tracking-widest">AGORA PROTOCOL</p>
        <p className="text-sm">Built for Colosseum Frontier × SWARM • Team: Dave, Josh, Joshua Ddf</p>
      </footer>
    </div>
  );
}
