import { useState, useEffect, useRef } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { Menu, ChevronLeft, ChevronRight } from "lucide-react";
import { NavBar } from "../components/NavBar";
import {
    docsNavigation,
    getAdjacentPages,
    type NavItem,
} from "../docs/navigation";

/* ─── Table of Contents ─────────────────────────────────────────── */
interface TocItem {
    id: string;
    text: string;
    level: 2 | 3;
}

function TableOfContents({ headings }: { headings: TocItem[] }) {
    const [activeId, setActiveId] = useState<string>("");

    useEffect(() => {
        if (headings.length === 0) return;
        const observer = new IntersectionObserver(
            (entries) => {
                // find the topmost visible heading
                const visible = entries.filter((e) => e.isIntersecting);
                if (visible.length > 0) {
                    setActiveId(visible[0].target.id);
                }
            },
            { rootMargin: "0px 0px -60% 0px", threshold: 0 },
        );
        headings.forEach(({ id }) => {
            const el = document.getElementById(id);
            if (el) observer.observe(el);
        });
        return () => observer.disconnect();
    }, [headings]);

    if (headings.length === 0) return null;

    return (
        <aside className="hidden xl:block w-[200px] flex-shrink-0">
            <div className="sticky top-[56px] pt-10 pr-4 max-h-[calc(100vh-56px)] overflow-y-auto">
                <p className="mono text-[11px] uppercase tracking-[0.08em] text-text-muted mb-3">
                    On this page
                </p>
                <nav className="flex flex-col gap-1">
                    {headings.map(({ id, text, level }) => (
                        <a
                            key={id}
                            href={`#${id}`}
                            onClick={(e) => {
                                e.preventDefault();
                                document
                                    .getElementById(id)
                                    ?.scrollIntoView({ behavior: "smooth" });
                                setActiveId(id);
                            }}
                            className={`text-[13px] transition-colors duration-150 border-l-2 py-0.5 ${
                                level === 3 ? "pl-6" : "pl-3"
                            } ${
                                activeId === id
                                    ? "border-accent text-accent"
                                    : "border-transparent text-text-muted hover:text-text-secondary"
                            }`}
                        >
                            {text}
                        </a>
                    ))}
                </nav>
            </div>
        </aside>
    );
}

/* ─── Prev / Next bar ───────────────────────────────────────────── */
function PrevNextBar({
    prev,
    next,
}: {
    prev: NavItem | null;
    next: NavItem | null;
}) {
    if (!prev && !next) return null;
    return (
        <div className="mt-16 pt-6 border-t border-border-subtle flex items-center justify-between gap-4">
            {prev ? (
                <Link
                    to={prev.href}
                    className="group flex items-center gap-2 flex-1 p-4 rounded-lg border border-border-subtle hover:bg-elevated hover:border-border-muted transition-all duration-150 min-w-0"
                >
                    <ChevronLeft
                        size={16}
                        className="text-text-muted group-hover:text-text-primary flex-shrink-0 transition-colors"
                    />
                    <div className="min-w-0">
                        <div className="mono text-[11px] uppercase tracking-[0.06em] text-text-muted mb-0.5">
                            Previous
                        </div>
                        <div className="text-sm text-text-secondary group-hover:text-text-primary truncate transition-colors">
                            {prev.title}
                        </div>
                    </div>
                </Link>
            ) : (
                <div className="flex-1" />
            )}
            {next ? (
                <Link
                    to={next.href}
                    className="group flex items-center gap-2 flex-1 p-4 rounded-lg border border-border-subtle hover:bg-elevated hover:border-border-muted transition-all duration-150 text-right min-w-0 justify-end"
                >
                    <div className="min-w-0">
                        <div className="mono text-[11px] uppercase tracking-[0.06em] text-text-muted mb-0.5">
                            Next
                        </div>
                        <div className="text-sm text-text-secondary group-hover:text-text-primary truncate transition-colors">
                            {next.title}
                        </div>
                    </div>
                    <ChevronRight
                        size={16}
                        className="text-text-muted group-hover:text-text-primary flex-shrink-0 transition-colors"
                    />
                </Link>
            ) : (
                <div className="flex-1" />
            )}
        </div>
    );
}

/* ─── Docs Sidebar ──────────────────────────────────────────────── */
function DocsSidebar({
    isOpen,
    onClose,
}: {
    isOpen: boolean;
    onClose: () => void;
}) {
    const location = useLocation();

    const isActive = (href: string) =>
        href === "/docs"
            ? location.pathname === "/docs" || location.pathname === "/docs/"
            : location.pathname === href ||
              location.pathname.startsWith(href + "/");

    return (
        <>
            {/* Mobile overlay backdrop */}
            {isOpen && (
                <div
                    className="fixed inset-0 bg-black/60 z-40 md:hidden"
                    onClick={onClose}
                />
            )}

            {/* Sidebar panel */}
            <aside
                className={`
          fixed top-[56px] left-0 z-50 w-[240px] h-[calc(100vh-56px)]
          bg-void border-r border-border-subtle
          overflow-y-auto flex-shrink-0
          transform transition-transform duration-200
          md:sticky md:translate-x-0 md:block md:transition-none
          ${isOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
        `}
            >
                <nav className="py-6 px-4">
                    {docsNavigation.map((section) => (
                        <div key={section.title} className="mb-6">
                            <div className="mono text-[11px] uppercase tracking-[0.08em] text-text-muted mb-2 px-2">
                                {section.title}
                            </div>
                            <ul className="flex flex-col gap-0.5">
                                {section.items.map((item) => {
                                    const active = isActive(item.href);
                                    return (
                                        <li key={item.href}>
                                            <Link
                                                to={item.href}
                                                onClick={onClose}
                                                className={`flex items-center text-sm px-2 py-1.5 rounded transition-colors duration-150 border-l-2 ${
                                                    active
                                                        ? "text-accent border-accent bg-accent/5"
                                                        : "text-text-secondary hover:text-text-primary border-transparent hover:border-border-muted hover:bg-elevated"
                                                }`}
                                            >
                                                {item.title}
                                            </Link>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    ))}
                </nav>
            </aside>
        </>
    );
}

/* ─── DocsLayout ────────────────────────────────────────────────── */
export function DocsLayout() {
    const location = useLocation();
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [headings, setHeadings] = useState<TocItem[]>([]);
    const contentRef = useRef<HTMLDivElement>(null);
    const { prev, next } = getAdjacentPages(location.pathname);

    // Close sidebar on route change (defer setState out of effect body to avoid
    // the "cascading renders" lint rule while keeping the behaviour correct)
    useEffect(() => {
        queueMicrotask(() => setSidebarOpen(false));
        window.scrollTo(0, 0);
    }, [location.pathname]);

    // Scan content area for headings after render
    useEffect(() => {
        const timer = setTimeout(() => {
            if (!contentRef.current) return;
            const els = contentRef.current.querySelectorAll("h2[id], h3[id]");
            const found: TocItem[] = [];
            els.forEach((el) => {
                const level = el.tagName === "H2" ? 2 : 3;
                found.push({
                    id: el.id,
                    text: el.textContent ?? "",
                    level: level as 2 | 3,
                });
            });
            setHeadings(found);
        }, 50);
        return () => clearTimeout(timer);
    }, [location.pathname]);

    return (
        <div className="min-h-screen flex flex-col">
            <NavBar />

            <div className="flex flex-1 relative">
                {/* Left sidebar */}
                <DocsSidebar
                    isOpen={sidebarOpen}
                    onClose={() => setSidebarOpen(false)}
                />

                {/* Main content */}
                <main className="flex-1 min-w-0 flex gap-8 justify-start xl:justify-center">
                    <div
                        ref={contentRef}
                        className="flex-1 min-w-0 max-w-[720px] px-6 md:px-10 pt-10 pb-20"
                    >
                        {/* Mobile hamburger */}
                        <button
                            onClick={() => setSidebarOpen(true)}
                            className="md:hidden flex items-center gap-2 text-text-muted hover:text-text-primary transition-colors mb-6 text-sm"
                        >
                            <Menu size={16} />
                            <span className="mono text-xs uppercase tracking-[0.06em]">
                                Menu
                            </span>
                        </button>

                        <Outlet />

                        <PrevNextBar prev={prev} next={next} />
                    </div>

                    {/* Right TOC */}
                    <TableOfContents headings={headings} />
                </main>
            </div>
        </div>
    );
}
