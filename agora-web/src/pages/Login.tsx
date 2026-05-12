import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/useAuth';
import { HeroReel } from '../components/landing/HeroReel';
import { StepCard } from '../components/landing/StepCard';
import { MartingaleViz } from '../components/landing/MartingaleViz';
import { AgoraFixViz } from '../components/landing/AgoraFixViz';
import { PaperSection, type PaperCardProps } from '../components/landing/PaperCard';
import { InteractiveSdkDemo } from '../components/landing/InteractiveSdkDemo';
import { LiveDeliberationPreview } from '../components/landing/LiveDeliberationPreview';
import { OnChainReceiptPreview } from '../components/landing/OnChainReceiptPreview';
import { BenchmarksPreview } from '../components/landing/BenchmarksPreview';
import { FooterGraph } from '../components/landing/FooterGraph';
import { ThemeToggle } from '../components/ui/ThemeToggle';
import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';
import { Button } from "../components/ui/Button";

/* ── Reduced-motion hook ─────────────────────────────────────────── */
function useReducedMotion() {
  const [v, setV] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const h = (e: MediaQueryListEvent) => setV(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return v;
}

/* ── Scroll reveal wrapper ──────────────────────────────────────── */
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
      transition={{ duration: 0.4, delay, ease: [0.16, 1, 0.3, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/* ── Research papers ─────────────────────────────────────────────── */
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

/* ══════════════════════════════════════════════════════════════════
   MAIN LANDING PAGE — section order per §8
══════════════════════════════════════════════════════════════════ */
export function LoginPage() {
  const { signIn, isLoading, authStatus } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const reducedMotion = useReducedMotion();
  const isAuthenticated = authStatus === 'authenticated';
  const fromPage = searchParams.get('from');

  return (
    <>
      <title>Agora — Proof of Deliberation</title>
      <meta
        name="description"
        content="Multi-agent AI deliberation platform. Submit a task, watch agents debate, vote, or iterate through Delphi, and receive a cryptographic proof ready for on-chain submission."
      />
    <div style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}>

      {/* ── §8.1 NAV (+ optional redirect banner, both sticky as one unit) ── */}
      <div style={{ position: 'sticky', top: 0, zIndex: 100 }}>
        {fromPage && (
          <div style={{
            width: '100%',
            background: 'var(--accent-emerald)',
            color: 'var(--text-inverse)',
            textAlign: 'center',
            padding: '10px 16px',
            fontSize: '13px',
            fontFamily: 'var(--font-sans)',
            letterSpacing: '0.01em',
          }}>
            Sign in again to access {fromPage}.
          </div>
        )}
      <header style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '14px clamp(16px, 5vw, 72px)',
        background: 'var(--bg-base)',
        borderBottom: '1px solid var(--border-default)',
        backdropFilter: 'blur(12px)',
      }}>
        <div className="wordmark" style={{ fontSize: '18px', letterSpacing: '0.1em', color: 'var(--text-primary)' }}>
          AGORA
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <ThemeToggle />
          {isAuthenticated ? (
            <Button
              onClick={() => navigate('/tasks')}
              variant="primary"
              style={{ fontSize: '13px', padding: '8px 18px', background: 'var(--accent)', color: 'var(--text-inverse)', border: 'none' }}
            >
              Go to Dashboard
            </Button>
          ) : (
            <Button
              onClick={() => signIn()}
              disabled={isLoading}
              variant="secondary"
              style={{ fontSize: '13px', padding: '8px 18px', border: '1.5px solid var(--border-strong)', background: 'transparent', color: 'var(--text-primary)' }}
            >
              {isLoading ? 'Connecting…' : 'Sign In'}
            </Button>
          )}
        </div>
      </header>
      </div>{/* end sticky nav+banner wrapper */}

      {/* ── §8.2 HERO WITH SCROLL-TIED DELIBERATION REEL ─────────── */}
      <HeroReel />

      {/* ── §8.3 HOW IT WORKS ─────────────────────────────────────── */}
      <section className="section-padding" style={{ background: 'var(--bg-base)' }}>
        <div className="content-rail">
          <Reveal>
            <div className="eyebrow" style={{ color: 'var(--accent-emerald)', marginBottom: '16px', textAlign: 'center' }}>
              How It Works
            </div>
            <h2 style={{ textAlign: 'center', textTransform: 'uppercase', marginBottom: '16px' }}>
              Three steps.<br />Infinite verifiability.
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '24px', marginTop: '48px' }}>
              <StepCard step={1} delay={0.1} vizType="selector" accentColor="var(--text-tertiary)"
                title="The AI Decides How to Decide"
                description="A Thompson Sampling bandit + LLM reasoning agent analyzes your task and selects the optimal mechanism: debate, vote, or Delphi." />
              <StepCard step={2} delay={0.25} vizType="debate" accentColor="var(--accent-emerald)"
                title="Agents Deliberate with Structure"
                description="Factional adversarial debate with Devil's Advocate cross-examination. Or confidence-calibrated voting with surprising-popularity weighting." />
              <StepCard step={3} delay={0.4} vizType="merkle" accentColor="var(--border-strong)"
                title="Every Step Verified On-Chain"
                description="Arguments, votes, and mechanism switches are Merkle-hashed and committed to Solana. Anyone can recompute the proof." />
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── §8.4 PROBLEM / FIX ────────────────────────────────────── */}
      <section className="section-padding" style={{ background: 'var(--bg-subtle)', borderTop: '1px solid var(--border-default)', borderBottom: '1px solid var(--border-default)' }}>
        <div className="content-rail">
          <Reveal>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '64px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                <div>
                  <div className="eyebrow" style={{ color: 'var(--accent-emerald)', marginBottom: '12px' }}>The Problem</div>
                  <h2 style={{ textTransform: 'uppercase', marginBottom: '16px' }}>Multi-agent debate is a martingale.</h2>
                  <p style={{ fontSize: '15px', lineHeight: '1.6' }}>
                    The most cited multi-agent debate paper of 2025 — Li et al., NeurIPS Spotlight — proved that unguided AI debate doesn't inherently improve correctness. The gains attributed to debate are often just majority voting in disguise. If agents start with a wrong prior, they'll debate themselves deeper into it.
                  </p>
                </div>
                <MartingaleViz />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                <div>
                  <div className="eyebrow" style={{ color: 'var(--accent-emerald)', marginBottom: '12px' }}>The Fix</div>
                  <h2 style={{ textTransform: 'uppercase', marginBottom: '16px' }}>An orchestrator that reasons, learns, and proves.</h2>
                  <p style={{ fontSize: '15px', lineHeight: '1.6' }}>
                    Agora breaks the martingale with three structural innovations: a mechanism selector that learns from outcomes, debate protocols that make sycophantic convergence architecturally impossible, and on-chain verification of every step of the governance process.
                  </p>
                </div>
                <AgoraFixViz />
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── §8.5 SDK INTEGRATION DEMO ────────────────────────────── */}
      <InteractiveSdkDemo />

      {/* ── §8.6 LIVE DELIBERATION PREVIEW ───────────────────────── */}
      <LiveDeliberationPreview reducedMotion={reducedMotion} />

      {/* ── §8.7 ON-CHAIN RECEIPT PREVIEW ────────────────────────── */}
      <OnChainReceiptPreview />

      {/* ── §8.8 BENCHMARKS PREVIEW ──────────────────────────────── */}
      <BenchmarksPreview />

      {/* ── RESEARCH FOUNDATION ──────────────────────────────────── */}
      <section className="section-padding" style={{ background: 'var(--bg-subtle)', borderTop: '1px solid var(--border-default)' }}>
        <div className="content-rail">
          <Reveal>
            <div className="eyebrow" style={{ color: 'var(--accent-emerald)', textAlign: 'center', marginBottom: '16px' }}>
              Research Foundation
            </div>
            <h2 style={{ textAlign: 'center', textTransform: 'uppercase', marginBottom: '16px' }}>
              Built on peer-reviewed science.
            </h2>
            <p className="lead" style={{ textAlign: 'center', maxWidth: '520px', margin: '0 auto 48px' }}>
              Every design decision in Agora traces to published research.
            </p>
            <div style={{ maxWidth: '720px', margin: '0 auto' }}>
              <PaperSection papers={PAPERS} />
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── §8.9 CURSOR-REACTIVE FOOTER GRAPH + §8.10 FOOTER TEXT ─ */}
      <FooterGraph />

    </div>
    </>
  );
}
