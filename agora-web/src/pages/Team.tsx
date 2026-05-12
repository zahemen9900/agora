import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
// lucide-react v1.x dropped brand icons — use inline SVGs instead
import { ThemeToggle } from "../components/ui/ThemeToggle";
import { Button } from "../components/ui/Button";
import { useAuth } from "../lib/useAuth";

/* ── Scroll-reveal wrapper (same pattern as Login.tsx) ───────────── */
function Reveal({
    children,
    delay = 0,
    className = "",
    x = 0,
}: {
    children: React.ReactNode;
    delay?: number;
    className?: string;
    x?: number;
}) {
    return (
        <motion.div
            initial={{ opacity: 0, y: x === 0 ? 24 : 0, x }}
            whileInView={{ opacity: 1, y: 0, x: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.55, delay, ease: [0.16, 1, 0.3, 1] }}
            className={className}
        >
            {children}
        </motion.div>
    );
}

/* ── Social brand icons (all inline SVG — lucide-react v1.x has no brand icons) */
function GitHubIcon({ size = 16 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
        >
            <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
        </svg>
    );
}

function LinkedInIcon({ size = 16 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
        >
            <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
        </svg>
    );
}

function XIcon({ size = 16 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
        >
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.259 5.631L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
        </svg>
    );
}

/* ── Social link ─────────────────────────────────────────────────── */
function SocialLink({
    href,
    label,
    children,
}: {
    href: string;
    label: string;
    children: React.ReactNode;
}) {
    const [hovered, setHovered] = useState(false);
    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={label}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 36,
                height: 36,
                borderRadius: 8,
                border: `1px solid ${hovered ? "var(--accent-emerald)" : "var(--border-default)"}`,
                background: hovered
                    ? "var(--accent-emerald-soft)"
                    : "transparent",
                color: hovered
                    ? "var(--accent-emerald)"
                    : "var(--text-tertiary)",
                transition: "all 0.15s ease",
                textDecoration: "none",
            }}
        >
            {children}
        </a>
    );
}

/* ── Portrait with glow effect ───────────────────────────────────── */
function Portrait({
    src,
    alt,
    flip,
}: {
    src: string;
    alt: string;
    flip?: boolean;
}) {
    const [hovered, setHovered] = useState(false);
    return (
        <motion.div
            initial={{ opacity: 0, x: flip ? 40 : -40 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
                flexShrink: 0,
                width: "100%",
                maxWidth: 380,
                borderRadius: 10,
                overflow: "hidden",
                position: "relative",
                border: `1px solid ${hovered ? "var(--accent-emerald)" : "rgba(34,211,138,0.2)"}`,
                boxShadow: hovered
                    ? "0 0 0 1px var(--accent-emerald), 0 0 56px rgba(34,211,138,0.18)"
                    : "0 0 32px rgba(0,0,0,0.4)",
                transition: "box-shadow 0.4s ease, border-color 0.4s ease",
                aspectRatio: "3 / 4",
            }}
        >
            <img
                src={src}
                alt={alt}
                style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    objectPosition: "center top",
                    display: "block",
                    filter: hovered
                        ? "grayscale(0%) brightness(1.02)"
                        : "grayscale(12%) brightness(0.96)",
                    transition: "filter 0.45s ease",
                }}
            />
            {/* Subtle corner accent */}
            <div
                style={{
                    position: "absolute",
                    bottom: 0,
                    left: 0,
                    right: 0,
                    height: 80,
                    background:
                        "linear-gradient(to top, rgba(34,211,138,0.08), transparent)",
                    pointerEvents: "none",
                    opacity: hovered ? 1 : 0,
                    transition: "opacity 0.4s ease",
                }}
            />
        </motion.div>
    );
}

/* ── Team member data ────────────────────────────────────────────── */
interface TeamMember {
    index: string;
    name: string;
    role: string;
    blurb: string;
    image: string;
    github: string;
    linkedin: string;
    twitter: string;
    flip?: boolean;
    bg?: string;
}

const TEAM: TeamMember[] = [
    {
        index: "01",
        name: "Dave Zahemen",
        role: "ML / LLM Lead",
        blurb: "Built the deliberation engines from scratch: Thompson Sampling mechanism selector, factional debate with Devil's Advocate cross-examination, ISP-weighted voting, Delphi consensus, and the tool-calling layer that lets agents search the web, analyze files, and run sandboxed code before reaching consensus.",
        image: "/team/dave.jpg",
        github: "https://github.com/zahemen9900",
        linkedin: "https://www.linkedin.com/in/david-yeboah-498245246/",
        twitter: "https://x.com/zahemen9900",
        flip: false,
        bg: "var(--bg-base)",
    },
    {
        index: "02",
        name: "Joshua Dodofoli",
        role: "UI / Frontend Lead",
        blurb: "Built the live canvas that makes agent deliberation visible in real time — faction arguments streaming inline, entropy meters updating as rounds progress, mechanism switches animating live, and the full benchmark analytics dashboard.",
        image: "/team/josh_ddf.jpeg",
        github: "https://github.com/JoshuaDodofoli",
        linkedin: "https://www.linkedin.com/in/joshua-dodofoli-a6a203314/",
        twitter: "https://x.com/JoshFoli",
        flip: true,
        bg: "var(--bg-subtle)",
    },
    {
        index: "03",
        name: "Josh Opare-Boateng",
        role: "Infra / Blockchain Lead",
        blurb: "Built the Anchor smart contract on Solana, the FastAPI backend deployed on Google Cloud Run, the Solana bridge that commits Merkle receipts on-chain, and the full CI/CD pipeline that holds everything together.",
        image: "/team/josh_opare.png",
        github: "https://github.com/jnopareboateng",
        linkedin: "https://www.linkedin.com/in/jnopareboateng/",
        twitter: "https://x.com/ahanotherdev",
        flip: false,
        bg: "var(--bg-base)",
    },
];

/* ── Member section ──────────────────────────────────────────────── */
function MemberSection({ member }: { member: TeamMember }) {
    const textDelay = 0.05;
    return (
        <section
            style={{
                background: member.bg,
                borderTop: "1px solid var(--border-default)",
                padding: "clamp(64px, 10vw, 120px) clamp(20px, 6vw, 72px)",
                position: "relative",
                overflow: "hidden",
            }}
        >
            {/* Faint background index number */}
            <div
                aria-hidden="true"
                style={{
                    position: "absolute",
                    top: "50%",
                    [member.flip ? "left" : "right"]: "-0.05em",
                    transform: "translateY(-50%)",
                    fontSize: "clamp(160px, 20vw, 280px)",
                    fontFamily: "'Commit Mono', monospace",
                    fontWeight: 700,
                    color: "transparent",
                    WebkitTextStroke: "1px var(--border-default)",
                    lineHeight: 1,
                    userSelect: "none",
                    pointerEvents: "none",
                    letterSpacing: "-0.04em",
                }}
            >
                {member.index}
            </div>

            <div
                style={{
                    maxWidth: 1200,
                    margin: "0 auto",
                    display: "flex",
                    flexDirection: member.flip ? "row-reverse" : "row",
                    alignItems: "center",
                    gap: "clamp(40px, 6vw, 96px)",
                }}
                className="team-member-row"
            >
                {/* Portrait */}
                <Portrait
                    src={member.image}
                    alt={`Photo of ${member.name}`}
                    flip={member.flip}
                />

                {/* Text block */}
                <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Index */}
                    <Reveal delay={textDelay * 0}>
                        <div
                            style={{
                                fontFamily: "'Commit Mono', monospace",
                                fontSize: 11,
                                letterSpacing: "0.12em",
                                textTransform: "uppercase",
                                color: "var(--accent-emerald)",
                                marginBottom: 16,
                            }}
                        >
                            {member.index}
                        </div>
                    </Reveal>

                    {/* Name */}
                    <Reveal delay={textDelay * 1}>
                        <h2
                            style={{
                                fontFamily: "'Commit Mono', monospace",
                                fontSize: "clamp(36px, 5vw, 66px)",
                                fontWeight: 700,
                                textTransform: "uppercase",
                                letterSpacing: "-0.025em",
                                lineHeight: 1,
                                color: "var(--text-primary)",
                                margin: "0 0 14px",
                            }}
                        >
                            {member.name}
                        </h2>
                    </Reveal>

                    {/* Role */}
                    <Reveal delay={textDelay * 2}>
                        <div
                            style={{
                                fontFamily: "'Commit Mono', monospace",
                                fontSize: 12,
                                letterSpacing: "0.1em",
                                textTransform: "uppercase",
                                color: "var(--accent-emerald)",
                                marginBottom: 24,
                                display: "flex",
                                alignItems: "center",
                                gap: 12,
                            }}
                        >
                            <span
                                style={{
                                    display: "inline-block",
                                    width: 28,
                                    height: 1,
                                    background: "var(--accent-emerald)",
                                    opacity: 0.6,
                                    flexShrink: 0,
                                }}
                            />
                            {member.role}
                        </div>
                    </Reveal>

                    {/* Blurb */}
                    <Reveal delay={textDelay * 3}>
                        <p
                            style={{
                                fontFamily: "'Hanken Grotesk', sans-serif",
                                fontSize: 15,
                                lineHeight: 1.7,
                                color: "var(--text-secondary)",
                                margin: "0 0 32px",
                                maxWidth: 540,
                            }}
                        >
                            {member.blurb}
                        </p>
                    </Reveal>

                    {/* Social icons */}
                    <Reveal delay={textDelay * 4}>
                        <div style={{ display: "flex", gap: 10 }}>
                            <SocialLink
                                href={member.github}
                                label={`${member.name} on GitHub`}
                            >
                                <GitHubIcon size={15} />
                            </SocialLink>
                            <SocialLink
                                href={member.linkedin}
                                label={`${member.name} on LinkedIn`}
                            >
                                <LinkedInIcon size={15} />
                            </SocialLink>
                            <SocialLink
                                href={member.twitter}
                                label={`${member.name} on X`}
                            >
                                <XIcon size={15} />
                            </SocialLink>
                        </div>
                    </Reveal>
                </div>
            </div>
        </section>
    );
}

/* ══════════════════════════════════════════════════════════════════
   TEAM PAGE
══════════════════════════════════════════════════════════════════ */
export function Team() {
    const { signIn, isLoading, authStatus } = useAuth();
    const navigate = useNavigate();
    const isAuthenticated = authStatus === "authenticated";

    return (
        <>
            <title>The Team — Agora</title>
            <meta
                name="description"
                content="Meet the three people behind Agora — the on-chain multi-agent deliberation primitive built for Colosseum Frontier × SWARM."
            />

            {/* ── Sticky nav (matches landing page exactly) ─────────────── */}
            <header
                style={{
                    position: "sticky",
                    top: 0,
                    zIndex: 100,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "14px clamp(16px, 5vw, 72px)",
                    background: "var(--bg-base)",
                    borderBottom: "1px solid var(--border-default)",
                    backdropFilter: "blur(12px)",
                }}
            >
                <Link
                    to="/"
                    className="wordmark"
                    style={{
                        fontSize: 18,
                        letterSpacing: "0.1em",
                        color: "var(--text-primary)",
                        textDecoration: "none",
                    }}
                >
                    AGORA
                </Link>

                <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
                    {/* Ghost nav links */}
                    <Link
                        to="/team"
                        style={{
                            fontFamily: "'Commit Mono', monospace",
                            fontSize: 13,
                            color: "var(--accent-emerald)",
                            textDecoration: "none",
                            letterSpacing: "0.02em",
                        }}
                    >
                        Team
                    </Link>
                    <Link
                        to="/docs"
                        style={{
                            fontFamily: "'Commit Mono', monospace",
                            fontSize: 13,
                            color: "var(--text-secondary)",
                            textDecoration: "none",
                            letterSpacing: "0.02em",
                            transition: "color 0.12s ease",
                        }}
                        onMouseEnter={(e) =>
                            (e.currentTarget.style.color =
                                "var(--text-primary)")
                        }
                        onMouseLeave={(e) =>
                            (e.currentTarget.style.color =
                                "var(--text-secondary)")
                        }
                    >
                        Docs
                    </Link>

                    <ThemeToggle />

                    {isAuthenticated ? (
                        <Button
                            onClick={() => navigate("/tasks")}
                            variant="primary"
                            style={{
                                fontSize: 13,
                                padding: "8px 18px",
                                background: "var(--accent)",
                                color: "var(--text-inverse)",
                                border: "none",
                            }}
                        >
                            Go to Dashboard
                        </Button>
                    ) : (
                        <Button
                            onClick={() => signIn()}
                            disabled={isLoading}
                            variant="secondary"
                            style={{
                                fontSize: 13,
                                padding: "8px 18px",
                                border: "1.5px solid var(--border-strong)",
                                background: "transparent",
                                color: "var(--text-primary)",
                            }}
                        >
                            {isLoading ? "Connecting…" : "Sign In"}
                        </Button>
                    )}
                </div>
            </header>

            <div style={{ display: "flex", flexDirection: "column" }}>
                {/* ── Page header ──────────────────────────────────────────── */}
                <section
                    style={{
                        background: "var(--bg-base)",
                        padding:
                            "clamp(80px, 12vw, 140px) clamp(20px, 6vw, 72px) clamp(64px, 9vw, 112px)",
                        textAlign: "center",
                        position: "relative",
                        overflow: "hidden",
                    }}
                >
                    {/* Dot-grid accent (matches landing page body::before) */}
                    <div
                        aria-hidden="true"
                        style={{
                            position: "absolute",
                            inset: 0,
                            backgroundImage:
                                "radial-gradient(var(--text-tertiary) 1px, transparent 0)",
                            backgroundSize: "24px 24px",
                            opacity: 0.06,
                            pointerEvents: "none",
                        }}
                    />

                    {/* Radial spotlight */}
                    <div
                        aria-hidden="true"
                        style={{
                            position: "absolute",
                            inset: 0,
                            background:
                                "radial-gradient(ellipse 60% 50% at 50% 0%, rgba(34,211,138,0.1) 0%, transparent 70%)",
                            pointerEvents: "none",
                        }}
                    />

                    <Reveal>
                        <div
                            className="eyebrow"
                            style={{
                                color: "var(--accent-emerald)",
                                marginBottom: 20,
                            }}
                        >
                            The Team
                        </div>
                    </Reveal>

                    <Reveal delay={0.07}>
                        <h1
                            style={{
                                fontFamily: "'Commit Mono', monospace",
                                fontSize: "clamp(32px, 5.5vw, 72px)",
                                fontWeight: 700,
                                textTransform: "uppercase",
                                letterSpacing: "-0.025em",
                                lineHeight: 1.05,
                                color: "var(--text-primary)",
                                margin: "0 0 20px",
                            }}
                        >
                            Three people.
                            <br />
                            Five weeks.
                            <br />
                            <span style={{ color: "var(--accent-emerald)" }}>
                                One verifiable
                            </span>
                            <br />
                            deliberation primitive.
                        </h1>
                    </Reveal>

                    <Reveal delay={0.14}>
                        <p
                            style={{
                                fontFamily: "'Hanken Grotesk', sans-serif",
                                fontSize: 16,
                                lineHeight: 1.6,
                                color: "var(--text-secondary)",
                                maxWidth: 480,
                                margin: "0 auto",
                            }}
                        >
                            Built for the Colosseum Frontier × Canteen SWARM
                            hackathon. Shipped in production. Deployed on Solana
                            devnet.
                        </p>
                    </Reveal>

                    {/* Thin accent rule */}
                    <Reveal delay={0.2}>
                        <div
                            style={{
                                width: 48,
                                height: 2,
                                background: "var(--accent-emerald)",
                                margin: "40px auto 0",
                                borderRadius: 2,
                                opacity: 0.7,
                            }}
                        />
                    </Reveal>
                </section>

                {/* ── Team member sections ─────────────────────────────────── */}
                {TEAM.map((member) => (
                    <MemberSection key={member.index} member={member} />
                ))}

                {/* ── Footer strip ─────────────────────────────────────────── */}
                <footer
                    style={{
                        borderTop: "1px solid var(--border-default)",
                        padding: "32px clamp(20px, 6vw, 72px)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        background: "var(--bg-base)",
                        gap: 16,
                        flexWrap: "wrap",
                    }}
                >
                    <Link
                        to="/"
                        className="wordmark"
                        style={{
                            fontSize: 14,
                            letterSpacing: "0.1em",
                            color: "var(--text-muted)",
                            textDecoration: "none",
                        }}
                    >
                        AGORA
                    </Link>
                    <p
                        style={{
                            fontFamily: "'Commit Mono', monospace",
                            fontSize: 11,
                            color: "var(--text-tertiary)",
                            margin: 0,
                            letterSpacing: "0.05em",
                        }}
                    >
                        Colosseum Frontier × SWARM · 2025
                    </p>
                    <Link
                        to="/"
                        style={{
                            fontFamily: "'Commit Mono', monospace",
                            fontSize: 12,
                            color: "var(--text-secondary)",
                            textDecoration: "none",
                            letterSpacing: "0.04em",
                            transition: "color 0.12s ease",
                        }}
                        onMouseEnter={(e) =>
                            (e.currentTarget.style.color =
                                "var(--accent-emerald)")
                        }
                        onMouseLeave={(e) =>
                            (e.currentTarget.style.color =
                                "var(--text-secondary)")
                        }
                    >
                        ← Back to landing
                    </Link>
                </footer>
            </div>

            {/* ── Mobile responsive styles ─────────────────────────────── */}
            <style>{`
        @media (max-width: 767px) {
          .team-member-row {
            flex-direction: column !important;
          }
          .team-member-row > div:first-child,
          .team-member-row > div:last-child {
            max-width: 100% !important;
            width: 100% !important;
          }
        }
        @media (max-width: 1023px) {
          .team-member-row {
            gap: 40px !important;
          }
        }
      `}</style>
        </>
    );
}
