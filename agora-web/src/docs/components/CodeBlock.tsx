import { useState } from "react";
import { Highlight, themes } from "prism-react-renderer";
import { Copy, Check } from "lucide-react";

export interface CodeBlockProps {
    code: string;
    language?: string;
    filename?: string;
}

export function CodeBlock({
    code,
    language = "text",
    filename,
}: CodeBlockProps) {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const label = filename ?? language;

    return (
        <div
            className="relative rounded-lg border border-(--border-default) overflow-hidden my-5"
            style={{ background: "var(--bg-subtle)" }}
        >
            {/* Top bar */}
            <div
                className="flex items-center justify-between px-4 py-2 border-b border-(--border-default)"
                style={{ background: "var(--bg-elevated)" }}
            >
                <span
                    className="font-mono text-[11px] uppercase tracking-[0.08em]"
                    style={{ color: "var(--text-tertiary)" }}
                >
                    {label}
                </span>

                <button
                    onClick={handleCopy}
                    className="flex items-center gap-1.5 transition-colors p-1 rounded"
                    style={{
                        color: copied
                            ? "var(--accent-emerald)"
                            : "var(--text-tertiary)",
                    }}
                    onMouseEnter={(e) => {
                        if (!copied)
                            (e.currentTarget as HTMLButtonElement).style.color =
                                "var(--text-primary)";
                    }}
                    onMouseLeave={(e) => {
                        if (!copied)
                            (e.currentTarget as HTMLButtonElement).style.color =
                                "var(--text-tertiary)";
                    }}
                    title="Copy code"
                    aria-label="Copy code to clipboard"
                >
                    {copied ? (
                        <Check
                            size={13}
                            style={{ color: "var(--accent-emerald)" }}
                        />
                    ) : (
                        <Copy size={13} />
                    )}
                    <span className="font-mono text-[11px]">
                        {copied ? "Copied" : "Copy"}
                    </span>
                </button>
            </div>

            {/* Highlighted code */}
            <Highlight
                theme={{
                    ...themes.oneDark,
                    plain: {
                        ...themes.oneDark.plain,
                        backgroundColor: "var(--bg-subtle)",
                    },
                }}
                code={code.trim()}
                language={
                    language as Parameters<typeof Highlight>[0]["language"]
                }
            >
                {({
                    className,
                    style,
                    tokens,
                    getLineProps,
                    getTokenProps,
                }) => (
                    <pre
                        className={`${className} p-5 overflow-x-auto text-[13px] leading-relaxed m-0`}
                        style={{
                            ...style,
                            background: "var(--bg-subtle)",
                            fontFamily:
                                "'Commit Mono', ui-monospace, SFMono-Regular, monospace",
                        }}
                    >
                        {tokens.map((line, i) => (
                            <div key={i} {...getLineProps({ line })}>
                                {line.map((token, key) => (
                                    <span
                                        key={key}
                                        {...getTokenProps({ token })}
                                    />
                                ))}
                            </div>
                        ))}
                    </pre>
                )}
            </Highlight>
        </div>
    );
}
