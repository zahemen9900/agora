export interface NavItem {
  title: string;
  href: string;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const docsNavigation: NavSection[] = [
  {
    title: "Getting Started",
    items: [
      { title: "Overview", href: "/docs" },
      { title: "Quickstart", href: "/docs/quickstart" },
      { title: "Installation", href: "/docs/installation" },
      { title: "Core Concepts", href: "/docs/concepts" },
    ],
  },
  {
    title: "SDK Reference",
    items: [
      { title: "Python SDK", href: "/docs/sdk/python" },
      { title: "LangGraph Integration", href: "/docs/sdk/langgraph" },
      { title: "CrewAI Integration", href: "/docs/sdk/crewai" },
      { title: "API Reference", href: "/docs/sdk/api-reference" },
    ],
  },
  {
    title: "Research",
    items: [
      { title: "Proof of Deliberation", href: "/docs/research/proof-of-deliberation" },
      { title: "Mechanism Selector", href: "/docs/research/mechanism-selector" },
      { title: "Factional Debate", href: "/docs/research/factional-debate" },
      { title: "ISP Voting", href: "/docs/research/isp-voting" },
      { title: "Delphi Consensus", href: "/docs/research/delphi-consensus" },
    ],
  },
  {
    title: "On-Chain",
    items: [
      { title: "Architecture", href: "/docs/on-chain/architecture" },
      { title: "Merkle Verification", href: "/docs/on-chain/verification" },
      { title: "Anchor Contract", href: "/docs/on-chain/anchor-contract" },
    ],
  },
];

/** Flat ordered list of all pages — used by prev/next navigation bar */
export const flatPages: NavItem[] = docsNavigation.flatMap((s) => s.items);

/** Given a pathname, returns { prev, next } NavItems (or null) */
export function getAdjacentPages(pathname: string): {
  prev: NavItem | null;
  next: NavItem | null;
} {
  const idx = flatPages.findIndex((p) => p.href === pathname);
  if (idx === -1) return { prev: null, next: null };
  return {
    prev: idx > 0 ? flatPages[idx - 1] : null,
    next: idx < flatPages.length - 1 ? flatPages[idx + 1] : null,
  };
}
