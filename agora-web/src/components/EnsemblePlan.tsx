import { ProviderGlyph } from "./ProviderGlyph";
import { providerTone } from "../lib/modelProviders";
import type { EnsembleRosterItem, ProviderTier } from "../lib/deliberationConfig";

interface EnsemblePlanProps {
  title: string;
  label: string;
  items: EnsembleRosterItem[];
  countBadges: Array<{
    key: ProviderTier;
    provider: "gemini" | "claude" | "kimi" | "other";
    label: string;
    count: number;
  }>;
  footer?: string;
}

export function EnsemblePlan({
  title,
  label,
  items,
  countBadges,
  footer,
}: EnsemblePlanProps) {
  return (
    <div className="p-1">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="mono text-xs text-text-muted">{title}</div>
        <span className="badge">{label}</span>
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        {countBadges.map((badge) => (
          <span
            key={badge.key}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 mono text-[11px] ${providerTone(badge.provider)}`}
          >
            <ProviderGlyph provider={badge.provider} size={12} />
            <span>{badge.label}</span>
            <span>{badge.count}x</span>
          </span>
        ))}
      </div>

      <div className="space-y-3 max-h-60 overflow-auto pr-1 pb-1">
        {items.map((item) => (
          <div
            key={item.id}
            className={`border border-border-subtle rounded-xl p-4 transition-colors hover:border-[rgba(255,255,255,0.3)] ${providerTone(item.provider).replace(/border-[^\s]+/, '')}`}
          >
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-2 min-w-0">
                <ProviderGlyph provider={item.provider} size={14} />
                <span className="mono text-xs font-medium truncate">{item.model}</span>
              </div>
              <span className="mono text-[10px] text-text-primary tracking-widest">{item.badge}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="mono text-[11px] text-text-muted">{item.role}</span>
              <span className="mono text-[10px] text-text-muted uppercase">{item.reasoningLabel}</span>
            </div>
          </div>
        ))}
      </div>

      {footer ? <div className="mt-3 text-xs text-text-secondary">{footer}</div> : null}
    </div>
  );
}
