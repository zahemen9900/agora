import type { ReactNode } from "react";

export interface StepsProps {
    children: ReactNode;
}

export function Steps({ children }: StepsProps) {
    return <div className="flex flex-col my-6">{children}</div>;
}

export interface StepProps {
    number: number;
    title: string;
    children: ReactNode;
}

export function Step({ number, title, children }: StepProps) {
    return (
        <div className="flex gap-5 relative">
            {/* Left column: number circle + vertical connector */}
            <div className="flex flex-col items-center shrink-0">
                {/* Number circle */}
                <div
                    className="w-8 h-8 rounded-full flex items-center justify-center font-mono text-sm font-bold shrink-0 z-10"
                    style={{
                        border: "2px solid var(--accent-emerald)",
                        color: "var(--accent-emerald)",
                        background: "var(--bg-base)",
                    }}
                >
                    {number}
                </div>

                {/* Vertical connector line — grows to fill remaining height */}
                <div
                    className="w-px flex-1 mt-1"
                    style={{
                        background: "var(--border-default)",
                        minHeight: "24px",
                    }}
                />
            </div>

            {/* Right column: title + body */}
            <div className="flex-1 pb-8 min-w-0">
                <h3
                    className="text-[18px] font-semibold mb-3 mt-1 leading-snug"
                    style={{
                        color: "var(--text-primary)",
                        fontFamily: "'Commit Mono', ui-monospace, monospace",
                        letterSpacing: "-0.01em",
                    }}
                >
                    {title}
                </h3>

                <div style={{ color: "var(--text-secondary)" }}>{children}</div>
            </div>
        </div>
    );
}
