import { useEffect, useRef, useState } from 'react';

interface AnimatedCounterProps {
  target: number;
  label: string;
  suffix?: string;
  duration?: number;
  delay?: number;
}

export function AnimatedCounter({ target, label, suffix = '', duration = 1500, delay = 0 }: AnimatedCounterProps) {
  const [count, setCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || target === 0) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          observer.disconnect();

          setTimeout(() => {
            const start = Date.now();
            const tick = () => {
              const elapsed = Date.now() - start;
              const progress = Math.min(elapsed / duration, 1);
              // ease-out cubic
              const eased = 1 - Math.pow(1 - progress, 3);
              setCount(Math.floor(eased * target));
              if (progress < 1) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }, delay);
        }
      },
      { threshold: 0.3 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [target, duration, delay]);

  // Don't render if there's no real data
  if (target === 0) return null;

  return (
    <div ref={ref} className="flex flex-col items-center gap-1">
      <span
        className="mono font-bold"
        style={{ fontSize: 'var(--text-3xl)', color: 'var(--accent)', letterSpacing: '-0.02em' }}
      >
        {count.toLocaleString()}{suffix}
      </span>
      <span
        className="mono text-text-muted uppercase tracking-widest"
        style={{ fontSize: '10px' }}
      >
        {label}
      </span>
    </div>
  );
}
