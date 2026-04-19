import { useEffect, useState, useRef } from 'react';

interface TypewriterTextProps {
  text: string;
  speed?: number;
  onComplete?: () => void;
  className?: string;
}

export function TypewriterText({ text, speed = 15, onComplete, className = '' }: TypewriterTextProps) {
  return (
    <TypewriterTextInner
      key={text}
      text={text}
      speed={speed}
      onComplete={onComplete}
      className={className}
    />
  );
}

function TypewriterTextInner({
  text,
  speed,
  onComplete,
  className,
}: TypewriterTextProps & { speed: number; className: string }) {
  const [displayedText, setDisplayedText] = useState('');
  const [isTyping, setIsTyping] = useState(text.length > 0);
  const indexRef = useRef(0);

  useEffect(() => {
    if (text.length === 0) {
      return;
    }

    const timer = setInterval(() => {
      if (indexRef.current < text.length) {
        setDisplayedText((prev) => prev + text.charAt(indexRef.current));
        indexRef.current += 1;
      } else {
        clearInterval(timer);
        setIsTyping(false);
        if (onComplete) onComplete();
      }
    }, speed);

    return () => clearInterval(timer);
  }, [text, speed, onComplete]);

  return (
    <span className={className}>
      {displayedText}
      {isTyping && <span className="inline-block w-2 h-3.5 bg-text-secondary ml-1 animate-[shimmer_1s_infinite]" />}
    </span>
  );
}
