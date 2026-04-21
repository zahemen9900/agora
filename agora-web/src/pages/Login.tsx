import { ArrowRight } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/useAuth';
import { Button } from '../components/ui/Button';
import { motion } from 'framer-motion';
import { HeroDiagram } from '../components/landing/HeroDiagram';
import { StepCard } from '../components/landing/StepCard';
import { InteractiveCodeBlock } from '../components/landing/InteractiveCodeBlock';
import { MartingaleViz } from '../components/landing/MartingaleViz';
import { AgoraFixViz } from '../components/landing/AgoraFixViz';
import { PaperSection, type PaperCardProps } from '../components/landing/PaperCard';
import { ThemeToggle } from '../components/ui/ThemeToggle';

// Scroll-reveal wrapper — applies to all below-fold sections
function Reveal({ children, delay = 0, className = '' }: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-50px' }}
      transition={{ duration: 0.6, delay, ease: [0.16, 1, 0.3, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// Research papers data
const PAPERS: PaperCardProps[] = [
  {
    authors: 'Li et al.',
    year: 2025,
    title: 'Debate or Vote? The Martingale Structure of Multi-Agent Reasoning',
    venue: 'NeurIPS Spotlight',
    claim:
      'Unguided AI debate does not inherently improve correctness. The gains typically attributed to debate are often just majority voting in disguise — agents with a wrong prior debate themselves deeper into it.',
    keyInsight:
      'Debate induces a martingale over agent beliefs. When agents start with a majority wrong prior, debate acts as a convergence mechanism toward that wrong answer rather than toward the truth. Majority voting accounts for most observed accuracy gains.',
    agoraUse:
      'Our mechanism selector learns when debate helps (high disagreement, high stakes) vs. when voting is sufficient (low complexity, clear factual questions). The debate protocol is designed to structurally prevent sycophantic convergence.',
  },
  {
    authors: 'Thompson (1933) · Russo et al. (2018)',
    year: 2018,
    title: 'Thompson Sampling for Contextual Bandits',
    venue: 'JMLR / Tutorial Survey',
    claim:
      'Thompson Sampling provides provably efficient exploration-exploitation tradeoffs in contextual bandit settings, outperforming ε-greedy and UCB strategies in practice across a wide range of tasks.',
    keyInsight:
      'By maintaining a posterior distribution over reward probabilities and sampling from it, Thompson Sampling naturally balances trying new mechanisms and exploiting known-good ones — without hand-tuning exploration rates.',
    agoraUse:
      'The AgoraSelector uses a (mechanism × topic_category) Thompson Sampling bandit. After each arbitration, it updates the arm posterior based on outcome quality, enabling the system to continuously improve its mechanism selection over time.',
  },
  {
    authors: 'Merkle (1987) · Nakamoto (2008)',
    year: 2008,
    title: 'Cryptographic Hash Trees and Blockchain Auditability',
    venue: 'IEEE / Bitcoin Whitepaper',
    claim:
      'Merkle trees enable efficient, tamper-evident verification of large datasets: any leaf can be proven authentic by providing only O(log n) sibling hashes rather than the entire dataset.',
    keyInsight:
      'By hashing each argument, vote, and mechanism decision into a Merkle tree, the complete deliberation process can be summarized in a single 32-byte root hash. Any party can independently recompute and verify the full transcript.',
    agoraUse:
      'Every Agora deliberation produces a Merkle root committed to Solana. The full transcript — arguments, votes, mechanism switches, convergence metrics — is recoverable from leaf hashes stored off-chain, while the root provides on-chain proof of integrity.',
  },
];

export function LoginPage() {
  const { signIn, signUp, isLoading } = useAuth();
  const [searchParams] = useSearchParams();
  const wasRedirected = searchParams.get('redirect') === '1';

  return (
    <div className="flex flex-col relative">

      {/* Redirect notice — outside the padded section so it spans edge-to-edge */}
      {wasRedirected && (
        <div className="w-full z-50 bg-accent/10 border-b border-accent/20 text-center py-2.5 text-sm text-accent sticky top-0">
          Sign in to continue to your destination.
        </div>
      )}

      {/* ── HERO SECTION ──────────────────────────────────────── */}
      <section className="relative min-h-screen flex flex-col px-6 md:px-10 overflow-hidden">

        {/* Ambient glow — top-center */}
        <div className="absolute top-[-10%] left-[10%] right-[10%] md:left-[20%] md:right-[20%] h-[30vh] bg-accent-muted blur-[100px] opacity-40 pointer-events-none" />
        {/* Glow accent — behind right diagram column */}
        <div className="hero-glow-right" />

        {/* NAV */}
        <header className="flex justify-between items-center max-w-[1200px] mx-auto w-full z-20 py-6">
          <div className="wordmark text-2xl tracking-widest">AGORA</div>
          <div className="flex items-center gap-4">
            <ThemeToggle />
            <button onClick={() => signIn()} disabled={isLoading} className="btn-secondary text-sm px-4 py-2">
              {isLoading ? 'Connecting...' : 'Sign In'}
            </button>
          </div>
        </header>

        <div className="flex-1 flex items-center max-w-[1200px] mx-auto w-full relative z-10 py-16">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-12 lg:gap-20 items-center w-full">

            {/* Left: text + CTAs */}
            <div className="flex flex-col items-start">
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="badge mb-6"
              >
                Proof of Deliberation
              </motion.div>

              <motion.h1
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, ease: 'easeOut' }}
                className="mb-6 tracking-tight font-bold text-left"
                style={{ lineHeight: 1.05 }}
              >
                AI agents<br />debate,<br />vote &amp;<br />prove it.
              </motion.h1>

              <motion.p
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 0.2, ease: 'easeOut' }}
                className="mb-10 text-text-secondary text-left"
                style={{ fontSize: 'var(--text-base)', lineHeight: 1.7, maxWidth: '420px' }}
              >
                An on-chain orchestration primitive where AI agents debate, vote, and reach consensus — with every step cryptographically verified on Solana.
              </motion.p>

              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.5, delay: 0.4, ease: 'easeOut' }}
                className="flex flex-col sm:flex-row gap-4"
              >
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => signIn()}
                  disabled={isLoading}
                  rightIcon={<ArrowRight size={18} />}
                  className="shadow-[0_0_20px_rgba(0,212,170,0.3)] hover:shadow-[0_0_30px_rgba(0,212,170,0.5)] transition-shadow duration-300"
                >
                  {isLoading ? 'Connecting...' : 'Sign In'}
                </Button>
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => signUp()}
                  disabled={isLoading}
                  rightIcon={<ArrowRight size={18} />}
                >
                  {isLoading ? 'Loading...' : 'Create Account'}
                </Button>
              </motion.div>

              {/* Mobile-only diagram (shown below CTAs on small screens) */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 0.6, ease: 'easeOut' }}
                className="mt-12 w-full md:hidden"
              >
                <HeroDiagram />
              </motion.div>
            </div>

            {/* Right: animated system diagram (desktop only) */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 1, delay: 0.3, ease: 'easeOut' }}
              className="hidden md:flex items-center justify-center relative"
            >
              <HeroDiagram />
            </motion.div>
          </div>
        </div>
      </section>

      {/* ── BELOW-THE-FOLD ───────────────────────────────────── */}
      <main className="flex flex-col items-center max-w-[1300px] mx-auto w-full px-6 md:px-10 z-10">

        {/* ── HOW IT WORKS ────── */}
        <Reveal className="w-full py-24">
          <div className="mono text-accent text-sm mb-3 tracking-widest font-bold text-center">HOW IT WORKS</div>
          <h2 className="text-center mb-16" style={{ fontSize: 'var(--text-3xl)' }}>
            Three steps.<br />Infinite verifiability.
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 w-full">
            <StepCard
              step={1}
              delay={0.1}
              vizType="selector"
              accentColor="var(--text-muted)"
              title="The AI Decides How to Decide"
              description="A Thompson Sampling bandit + LLM reasoning agent analyzes your task and selects the optimal supported mechanism for now: debate or vote."
            />
            <StepCard
              step={2}
              delay={0.25}
              vizType="debate"
              accentColor="var(--accent)"
              title={<span className="text-accent">Agents Deliberate with Structure</span>}
              description="Factional adversarial debate with Devil's Advocate cross-examination. Or confidence-calibrated voting with surprising-popularity weighting."
            />
            <StepCard
              step={3}
              delay={0.4}
              vizType="merkle"
              accentColor="var(--border-accent)"
              title="Every Step Verified On-Chain"
              description="Arguments, votes, and mechanism switches are Merkle-hashed and committed to Solana. Anyone can recompute the proof."
            />
          </div>
        </Reveal>

        {/* ── SECTION DIVIDER ── */}
        <div className="section-divider w-full" />

        {/* ── PROBLEM / FIX ────── */}
        <Reveal className="w-full py-24">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 text-left">

            {/* Problem */}
            <div className="flex flex-col gap-6">
              <div>
                <div className="mono text-accent text-sm mb-4 tracking-widest font-bold">THE PROBLEM</div>
                <h4 className="mb-4 font-semibold">Multi-agent debate is a martingale.</h4>
                <p className="text-text-secondary leading-relaxed" style={{ fontSize: '15px' }}>
                  The most cited multi-agent debate paper of 2025 — Li et al., NeurIPS Spotlight — proved that unguided AI debate doesn't inherently improve correctness. The gains attributed to debate are often just majority voting in disguise. If agents start with a wrong prior, they'll debate themselves deeper into it.
                </p>
              </div>
              <MartingaleViz />
            </div>

            {/* Fix */}
            <div className="flex flex-col gap-6">
              <div>
                <div className="mono text-accent text-sm mb-4 tracking-widest font-bold">THE FIX</div>
                <h4 className="mb-4 font-semibold">An orchestrator that reasons, learns, and proves.</h4>
                <p className="text-text-secondary leading-relaxed" style={{ fontSize: '15px' }}>
                  Agora breaks the martingale with three structural innovations: a mechanism selector that learns from outcomes, debate protocols that make sycophantic convergence architecturally impossible, and on-chain verification of every step of the governance process.
                </p>
              </div>
              <AgoraFixViz />
            </div>

          </div>
        </Reveal>

        {/* ── SECTION DIVIDER ── */}
        <div className="section-divider w-full" />

        {/* ── INTEGRATION CODE BLOCK ────── */}
        <Reveal className="w-full py-24">
          <div className="mono text-accent text-sm mb-3 tracking-widest font-bold text-center">INTEGRATION</div>
          <h2 className="text-center mb-4" style={{ fontSize: 'var(--text-3xl)' }}>
            Two lines to arbitrate anything.
          </h2>
          <p className="text-text-secondary text-center mb-12" style={{ maxWidth: '520px', margin: '0 auto 3rem' }}>
            Install the SDK, pass your question, get a cryptographically verified answer with a full deliberation receipt.
          </p>
          <div className="flex justify-center">
            <InteractiveCodeBlock />
          </div>
        </Reveal>

        {/* ── SECTION DIVIDER ── */}
        <div className="section-divider w-full" />

        {/* ── RESEARCH FOUNDATION ────── */}
        <Reveal className="w-full py-24">
          <div className="mono text-accent text-sm mb-3 tracking-widest font-bold text-center">RESEARCH FOUNDATION</div>
          <h2 className="text-center mb-4" style={{ fontSize: 'var(--text-3xl)' }}>
            Built on peer-reviewed science.
          </h2>
          <p className="text-text-secondary text-center mb-12" style={{ maxWidth: '520px', margin: '0 auto 3rem' }}>
            Every design decision in Agora traces to published research. Click to expand.
          </p>
          <div className="max-w-2xl mx-auto w-full">
            <PaperSection papers={PAPERS} />
          </div>
        </Reveal>

      </main>

      {/* ── FOOTER ────── */}
      <footer className="py-16 mt-12 text-center text-text-muted relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-bg-elevated/20 pointer-events-none" />
        <p className="wordmark mb-2 text-text-secondary tracking-widest relative z-10">AGORA PROTOCOL</p>
        <p className="text-sm relative z-10">
          Built for Colosseum Frontier × SWARM · Team: Dave, Josh, Joshua Ddf
        </p>
      </footer>
    </div>
  );
}
