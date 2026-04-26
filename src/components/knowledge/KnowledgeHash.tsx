'use client';

import { useMemo } from 'react';

interface KnowledgeHashProps {
  /** The full hash value (with or without 0x prefix) */
  value: string;
  /** Additional CSS classes */
  className?: string;
  /** Whether to show copy-on-click behavior */
  copyable?: boolean;
}

/**
 * Truncate a hash for display: 0xaaaa...bbbb
 * Shows first 6 chars + last 4 chars
 */
function truncateHash(hash: string): string {
  const normalized = hash.startsWith('0x') ? hash : `0x${hash}`;

  if (normalized.length <= 12) {
    return normalized;
  }

  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

/**
 * Display a truncated hash value with full value on hover
 *
 * Design spec: Monospace font, 0.8125rem (13px)
 */
export function KnowledgeHash({ value, className = '', copyable = true }: KnowledgeHashProps): React.ReactElement {
  const truncated = useMemo(() => truncateHash(value), [value]);
  const fullValue = value.startsWith('0x') ? value : `0x${value}`;

  const handleClick = async () => {
    if (!copyable) return;

    try {
      await navigator.clipboard.writeText(fullValue);
    } catch {
      // Silently fail if clipboard access is denied
    }
  };

  return (
    <span
      className={`font-mono font-features-none text-[0.8125rem] leading-relaxed tracking-wider text-text-primary ${copyable ? 'cursor-pointer hover:text-ink-600 transition-colors' : ''} ${className}`}
      title={fullValue}
      onClick={() => void handleClick()}
      role={copyable ? 'button' : undefined}
      tabIndex={copyable ? 0 : undefined}
      onKeyDown={
        copyable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                void handleClick();
              }
            }
          : undefined
      }
    >
      {truncated}
    </span>
  );
}
