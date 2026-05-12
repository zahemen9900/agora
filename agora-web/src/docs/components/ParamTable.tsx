export interface Param {
    name: string;
    type: string;
    required: boolean;
    default?: string;
    description: string;
}

export interface ParamTableProps {
    params: Param[];
}

export function ParamTable({ params }: ParamTableProps) {
    return (
        <div className="overflow-x-auto my-5 rounded-lg border border-(--border-default)">
            <table className="w-full text-sm border-collapse">
                <thead>
                    <tr style={{ background: "var(--bg-elevated)" }}>
                        {(
                            [
                                "Parameter",
                                "Type",
                                "Required",
                                "Description",
                            ] as const
                        ).map((heading) => (
                            <th
                                key={heading}
                                className="text-left px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.07em]"
                                style={{ color: "var(--text-tertiary)" }}
                            >
                                {heading}
                            </th>
                        ))}
                    </tr>
                </thead>

                <tbody>
                    {params.map((p) => (
                        <tr
                            key={p.name}
                            className="border-t border-(--border-default) transition-colors"
                            onMouseEnter={(e) => {
                                (
                                    e.currentTarget as HTMLTableRowElement
                                ).style.background = "var(--bg-elevated)";
                            }}
                            onMouseLeave={(e) => {
                                (
                                    e.currentTarget as HTMLTableRowElement
                                ).style.background = "";
                            }}
                        >
                            {/* Name */}
                            <td
                                className="px-4 py-3 font-mono text-[13px]"
                                style={{ color: "var(--accent-emerald)" }}
                            >
                                {p.name}
                            </td>

                            {/* Type + optional default */}
                            <td
                                className="px-4 py-3 font-mono text-[12px]"
                                style={{ color: "var(--text-secondary)" }}
                            >
                                {p.type}
                                {p.default !== undefined && (
                                    <span
                                        className="ml-1"
                                        style={{
                                            color: "var(--text-tertiary)",
                                        }}
                                    >
                                        = {p.default}
                                    </span>
                                )}
                            </td>

                            {/* Required / Optional badge */}
                            <td className="px-4 py-3">
                                {p.required ? (
                                    <span
                                        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider"
                                        style={{
                                            background:
                                                "var(--accent-emerald-soft)",
                                            color: "var(--accent-emerald)",
                                            border: "1px solid rgba(34, 211, 138, 0.3)",
                                        }}
                                    >
                                        Required
                                    </span>
                                ) : (
                                    <span
                                        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider"
                                        style={{
                                            background: "var(--bg-subtle)",
                                            color: "var(--text-tertiary)",
                                            border: "1px solid var(--border-default)",
                                        }}
                                    >
                                        Optional
                                    </span>
                                )}
                            </td>

                            {/* Description */}
                            <td
                                className="px-4 py-3 text-[13px]"
                                style={{ color: "var(--text-secondary)" }}
                            >
                                {p.description}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
