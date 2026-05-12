import { ArrowRight } from "lucide-react";

export interface LinkCardProps {
    title: string;
    description: string;
    href: string;
}

export function LinkCard({ title, description, href }: LinkCardProps) {
    return (
        <a
            href={href}
            className="group flex flex-col gap-1.5 rounded-lg border p-4 transition-all duration-150 no-underline"
            style={{
                borderColor: "var(--border-default)",
                background: "var(--bg-elevated)",
            }}
            onMouseEnter={(e) => {
                const el = e.currentTarget as HTMLAnchorElement;
                el.style.borderColor = "var(--accent-emerald)";
                el.style.background = "var(--accent-emerald-soft)";
            }}
            onMouseLeave={(e) => {
                const el = e.currentTarget as HTMLAnchorElement;
                el.style.borderColor = "var(--border-default)";
                el.style.background = "var(--bg-elevated)";
            }}
        >
            <div className="flex items-center justify-between">
                <span
                    className="font-mono text-sm font-semibold"
                    style={{ color: "var(--text-primary)" }}
                >
                    {title}
                </span>
                <ArrowRight
                    size={14}
                    className="transition-transform duration-150 group-hover:translate-x-0.5"
                    style={{ color: "var(--accent-emerald)" }}
                />
            </div>
            <span
                className="text-[13px] leading-relaxed"
                style={{
                    color: "var(--text-secondary)",
                    fontFamily: "'Hanken Grotesk', sans-serif",
                }}
            >
                {description}
            </span>
        </a>
    );
}
