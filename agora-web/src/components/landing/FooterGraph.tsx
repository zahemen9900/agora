import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import * as d3Force from 'd3-force';

const LABELS = [
  'claim_a1', 'rebuttal_opp_02', 'DA_crossx', 'locked',
  'merkle_root', 'vote_weight_0.82', 'quorum_reached',
  'info_gain_delta', 'round_2/3', 'verified', 'PRO→OPP',
  'stake', 'entropy_0.41', 'hash_7f3a', 'threshold_0.9',
  'convergence', 'argument_b3', 'solana_tx', 'claim_locked',
];

interface GraphNode extends d3Force.SimulationNodeDatum {
  id: number;
  group: number;
  label: string;
}

interface GraphLink extends d3Force.SimulationLinkDatum<GraphNode> {
  source: GraphNode | number;
  target: GraphNode | number;
}

function generateNodes(count: number, width: number, height: number): GraphNode[] {
  return Array.from({ length: count }, (_, i) => {
    const group = Math.floor(i / Math.ceil(count / 8));
    return {
      id: i,
      group,
      label: LABELS[i % LABELS.length],
      x: (width / 8) * (group + 0.5) + (Math.random() - 0.5) * 60,
      y: height / 2 + (Math.random() - 0.5) * height * 0.7,
      vx: 0,
      vy: 0,
    };
  });
}

function generateLinks(nodes: GraphNode[]): GraphLink[] {
  const links: GraphLink[] = [];
  const seen = new Set<string>();
  nodes.forEach((n) => {
    const sameGroup = nodes.filter((m) => m.id !== n.id && m.group === n.group);
    const adjGroup = nodes.filter((m) => m.id !== n.id && Math.abs(m.group - n.group) === 1);
    const pool = [...sameGroup, ...adjGroup];
    const count = 2 + Math.floor(Math.random() * 2);
    const shuffled = pool.sort(() => Math.random() - 0.5).slice(0, count);
    shuffled.forEach((t) => {
      const key = `${Math.min(n.id, t.id)}-${Math.max(n.id, t.id)}`;
      if (!seen.has(key)) {
        seen.add(key);
        links.push({ source: n, target: t });
      }
    });
  });
  return links;
}

function traceWinningPath(nodes: GraphNode[], links: GraphLink[]): { nodes: Set<number>; edges: Set<string> } {
  const adjMap = new Map<number, number[]>();
  nodes.forEach((n) => adjMap.set(n.id, []));
  links.forEach((l) => {
    const s = typeof l.source === 'object' ? (l.source as GraphNode).id : l.source;
    const t = typeof l.target === 'object' ? (l.target as GraphNode).id : l.target;
    adjMap.get(s as number)!.push(t as number);
    adjMap.get(t as number)!.push(s as number);
  });

  const startId = nodes.find((n) => (adjMap.get(n.id)?.length ?? 0) <= 2)?.id ?? nodes[nodes.length - 1].id;
  const targetId = 0;

  const visited = new Map<number, number | null>();
  const queue = [startId];
  visited.set(startId, null);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === targetId) break;
    for (const nb of (adjMap.get(cur) ?? [])) {
      if (!visited.has(nb)) { visited.set(nb, cur); queue.push(nb); }
    }
  }

  const pathNodes = new Set<number>();
  const pathEdges = new Set<string>();
  let cur: number | null = targetId;
  while (cur !== null && cur !== undefined && visited.has(cur)) {
    pathNodes.add(cur);
    const prev = visited.get(cur);
    if (prev !== null && prev !== undefined) {
      pathEdges.add(`${Math.min(cur, prev)}-${Math.max(cur, prev)}`);
    }
    cur = prev ?? null;
  }

  return { nodes: pathNodes, edges: pathEdges };
}

function useReducedMotion() {
  const [v] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  return v;
}

const NODE_COUNT = 120;

export function FooterGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef({ x: -1e4, y: -1e4 });
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const isMobile = window.innerWidth < 768;
    let width = canvas.offsetWidth;
    let height = canvas.offsetHeight;

    const setCanvasSize = () => {
      const dpr = window.devicePixelRatio || 1;
      width = canvas.offsetWidth;
      height = canvas.offsetHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      // Reset transform before applying scale — prevents compounding on resize
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    setCanvasSize();

    // Build graph
    const nodes = generateNodes(NODE_COUNT, width, height);
    const links = generateLinks(nodes);
    const winning = traceWinningPath(nodes, links);

    const sim = d3Force
      .forceSimulation<GraphNode>(nodes)
      .force('link', d3Force.forceLink<GraphNode, GraphLink>(links).id((n) => n.id).distance(40).strength(0.4))
      .force('charge', d3Force.forceManyBody<GraphNode>().strength(-80))
      .force('x', d3Force.forceX<GraphNode>((n) => (width / 8) * (n.group + 0.5)).strength(0.06))
      .force('y', d3Force.forceY<GraphNode>(() => height / 2).strength(0.04))
      .force('collide', d3Force.forceCollide<GraphNode>(12))
      .alphaDecay(0.01)
      .alphaTarget(reducedMotion ? 0 : 0.02); // keep simulation warm so it never freezes

    const resize = () => {
      setCanvasSize();
      sim.force('x', d3Force.forceX<GraphNode>((n) => (width / 8) * (n.group + 0.5)).strength(0.06));
      sim.force('y', d3Force.forceY<GraphNode>(() => height / 2).strength(0.04));
      sim.alpha(0.3).restart();
    };
    window.addEventListener('resize', resize);

    const onMouseMove = (e: MouseEvent) => {
      if (reducedMotion || isMobile) return;
      const rect = canvas.getBoundingClientRect();
      mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      // Warm up simulation so cursor repulsion stays lively
      if (sim.alpha() < 0.08) sim.alpha(0.15).restart();
    };
    const onMouseLeave = () => {
      mouseRef.current = { x: -1e4, y: -1e4 };
    };
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeave);

    // Mobile: periodic center-pulse
    let pulseT: ReturnType<typeof setInterval> | null = null;
    if (isMobile && !reducedMotion) {
      pulseT = setInterval(() => {
        const cx = width / 2;
        const cy = height / 2;
        nodes.forEach((n) => {
          const dx = (n.x ?? 0) - cx;
          const dy = (n.y ?? 0) - cy;
          const dist = Math.hypot(dx, dy) || 1;
          if (dist < 150) {
            n.vx = (n.vx ?? 0) + (dx / dist) * 0.8;
            n.vy = (n.vy ?? 0) + (dy / dist) * 0.8;
          }
        });
        sim.alpha(0.3).restart();
      }, 9000);
    }

    const render = () => {
      ctx.clearRect(0, 0, width, height);

      // Apply cursor repulsion as a per-frame velocity injection
      if (!reducedMotion && !isMobile) {
        const mx = mouseRef.current.x;
        const my = mouseRef.current.y;
        nodes.forEach((n) => {
          const dx = (n.x ?? 0) - mx;
          const dy = (n.y ?? 0) - my;
          const dist = Math.hypot(dx, dy);
          if (dist < 120 && dist > 0) {
            const force = ((120 - dist) / 120) * 0.3;
            n.vx = (n.vx ?? 0) + (dx / dist) * force;
            n.vy = (n.vy ?? 0) + (dy / dist) * force;
          }
        });
      }

      // Draw edges
      links.forEach((l) => {
        const s = l.source as GraphNode;
        const t = l.target as GraphNode;
        if (typeof s !== 'object' || typeof t !== 'object') return;
        const edgeKey = `${Math.min(s.id, t.id)}-${Math.max(s.id, t.id)}`;
        const onPath = winning.edges.has(edgeKey);
        ctx.strokeStyle = onPath ? 'rgba(34,211,138,0.9)' : 'rgba(180,185,192,0.18)';
        ctx.lineWidth = onPath ? 1.4 : 0.6;
        ctx.beginPath();
        ctx.moveTo(s.x ?? 0, s.y ?? 0);
        ctx.lineTo(t.x ?? 0, t.y ?? 0);
        ctx.stroke();
      });

      // Draw nodes + labels
      const mx = mouseRef.current.x;
      const my = mouseRef.current.y;
      nodes.forEach((n) => {
        const nx = n.x ?? 0;
        const ny = n.y ?? 0;
        const onPath = winning.nodes.has(n.id);
        const dist = Math.hypot(nx - mx, ny - my);
        const proximity = reducedMotion ? 0 : Math.max(0, (120 - dist) / 120);

        ctx.fillStyle = onPath
          ? 'rgba(34,211,138,1)'
          : `rgba(180,185,192,${0.35 + proximity * 0.5})`;
        ctx.beginPath();
        ctx.arc(nx, ny, onPath ? 3 : 1.5, 0, Math.PI * 2);
        ctx.fill();

        if (onPath || proximity > 0.2) {
          ctx.font = `10px 'Commit Mono', 'SF Mono', monospace`;
          ctx.fillStyle = onPath ? 'rgba(34,211,138,1)' : `rgba(180,185,192,${proximity * 0.85})`;
          ctx.fillText(n.label, nx + 6, ny + 3);
        }
      });
    };

    // Drive render off rAF independently of sim ticks — sim may settle, but
    // we still need to redraw when the cursor moves.
    let raf = 0;
    let running = true;
    const loop = () => {
      if (!running) return;
      render();
      raf = requestAnimationFrame(loop);
    };

    if (reducedMotion) {
      sim.stop();
      for (let i = 0; i < 300; i++) sim.tick();
      render();
    } else {
      raf = requestAnimationFrame(loop);
    }

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      sim.stop();
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseleave', onMouseLeave);
      if (pulseT) clearInterval(pulseT);
    };
  }, [reducedMotion]);

  return (
    <footer style={{ background: 'var(--bg-base)', borderTop: '1px solid var(--border-default)', overflow: 'hidden' }}>
      {/* Above-graph text */}
      <div style={{ textAlign: 'center', paddingTop: '48px', paddingBottom: '24px' }}>
        <div style={{
          fontFamily: "'Commit Mono', monospace",
          fontSize: '28px',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: 'var(--text-primary)',
          marginBottom: '12px',
        }}>
          PROOF OF DELIBERATION.
        </div>
        <p style={{
          fontSize: '14px',
          color: 'var(--text-tertiary)',
          maxWidth: '520px',
          margin: '0 auto',
          fontFamily: "'Hanken Grotesk', sans-serif",
        }}>
          Every argument, every vote, every mechanism switch — hashed, committed, verifiable by anyone.
        </p>
      </div>

      {/* Canvas */}
      <div style={{ position: 'relative', width: '100%', height: '480px' }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: '100%', display: 'block' }}
          aria-label="A network visualization of debate arguments converging to a cryptographic root."
          role="img"
        />
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: '80px',
          background: 'linear-gradient(to bottom, var(--bg-base), transparent)',
          pointerEvents: 'none',
        }}/>
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, height: '80px',
          background: 'linear-gradient(to top, var(--bg-base), transparent)',
          pointerEvents: 'none',
        }}/>
      </div>

      {/* Footer links — trimmed to essentials */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '48px',
        padding: '48px 72px',
        maxWidth: '1240px',
        margin: '0 auto',
        borderTop: '1px solid var(--border-default)',
      }}>
        <div>
          <div className="eyebrow" style={{ color: 'var(--text-tertiary)', marginBottom: '16px' }}>Build</div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <li>
              <a
                href="https://pypi.org/project/agora-arbitrator-sdk/"
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: '13px', color: 'var(--text-secondary)', fontFamily: "'Hanken Grotesk', sans-serif", transition: 'color 0.12s ease-out' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent-emerald)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
              >
                SDK ↗
              </a>
            </li>
            <li>
              <Link
                to="/docs"
                style={{ fontSize: '13px', color: 'var(--text-secondary)', fontFamily: "'Hanken Grotesk', sans-serif", transition: 'color 0.12s ease-out', textDecoration: 'none' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent-emerald)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
              >
                Docs
              </Link>
            </li>
            <li>
              <a
                href="https://github.com/zahemen9900/agora"
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: '13px', color: 'var(--text-secondary)', fontFamily: "'Hanken Grotesk', sans-serif", transition: 'color 0.12s ease-out' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent-emerald)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
              >
                GitHub ↗
              </a>
            </li>
          </ul>
        </div>

        <div>
          <div className="eyebrow" style={{ color: 'var(--text-tertiary)', marginBottom: '16px' }}>Community</div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <li>
              <a
                href="https://arena.colosseum.org/"
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: '13px', color: 'var(--text-secondary)', fontFamily: "'Hanken Grotesk', sans-serif", transition: 'color 0.12s ease-out' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent-emerald)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
              >
                Colosseum ↗
              </a>
            </li>
            <li>
              <a
                href="https://swarm.thecanteenapp.com/"
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: '13px', color: 'var(--text-secondary)', fontFamily: "'Hanken Grotesk', sans-serif", transition: 'color 0.12s ease-out' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent-emerald)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
              >
                SWARM ↗
              </a>
            </li>
          </ul>
        </div>

        <div>
          <div className="eyebrow" style={{ color: 'var(--text-tertiary)', marginBottom: '16px' }}>Legal</div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <li><span style={{ fontSize: '13px', color: 'var(--text-tertiary)', fontFamily: "'Hanken Grotesk', sans-serif" }}>Terms</span></li>
            <li><span style={{ fontSize: '13px', color: 'var(--text-tertiary)', fontFamily: "'Hanken Grotesk', sans-serif" }}>Privacy</span></li>
          </ul>
        </div>
      </div>

      <div style={{ textAlign: 'center', paddingBottom: '32px', color: 'var(--text-tertiary)', fontSize: '12px', fontFamily: "'Commit Mono', monospace" }}>
        Built for Colosseum Frontier × SWARM · Team: Dave, Josh, Joshua Ddf
      </div>
    </footer>
  );
}
