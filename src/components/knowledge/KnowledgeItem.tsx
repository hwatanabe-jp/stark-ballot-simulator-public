'use client';

import { HASH_FIELDS, type KnowledgeData } from '@/lib/knowledge';
import { KnowledgeHash } from './KnowledgeHash';

interface KnowledgeItemProps {
  /** The knowledge key */
  keyName: keyof KnowledgeData;
  /** Display label for the item */
  label: string;
  /** The value to display */
  value: unknown;
  /** Whether this item was recently added (triggers animation) */
  isNew?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Language for i18n (defaults to 'ja') */
  language?: 'ja' | 'en';
  /** Whether this item is highlighted */
  highlighted?: boolean;
}

/**
 * Localized strings for knowledge item values
 */
const i18n = {
  ja: {
    unset: '未設定',
    yes: 'はい',
    no: 'いいえ',
    verified: '検証済',
    pending: '処理中',
    notDownloaded: '未ダウンロード',
    downloaded: 'ダウンロード済',
    completed: '完了',
    fields: 'フィールド',
    votes: '票',
  },
  en: {
    unset: 'Not set',
    yes: 'Yes',
    no: 'No',
    verified: 'verified',
    pending: 'Pending',
    notDownloaded: 'Not downloaded',
    downloaded: 'Downloaded',
    completed: 'Completed',
    fields: 'fields',
    votes: 'votes',
  },
} as const;

const scenarioLabels: Record<'ja' | 'en', Record<string, string>> = {
  ja: {
    S0: '改ざんしない',
    S1: 'あなたの投票を除外する',
    S2: 'あなたの投票に関する発表結果を改ざんする',
    S3: '1体のボット投票を除外する',
    S4: '1体のボットの投票に関する発表結果を改ざんする',
    S5: 'ランダムエラー注入',
  },
  en: {
    S0: 'No Tampering',
    S1: 'Exclude Your Vote',
    S2: 'Tamper Claimed Tally for Your Vote',
    S3: 'Exclude a Bot Vote',
    S4: 'Tamper Claimed Tally for a Bot Vote',
    S5: 'Random Error Injection',
  },
};

/**
 * Check if a key represents a hash field
 */
function isHashField(key: keyof KnowledgeData): boolean {
  return HASH_FIELDS.includes(key);
}

/**
 * Format a value for display
 */
function formatValue(key: keyof KnowledgeData, value: unknown, lang: 'ja' | 'en' = 'ja'): React.ReactNode {
  const t = i18n[lang];

  if (value === null || value === undefined) {
    return <span className="text-text-muted italic">{t.unset}</span>;
  }

  // Handle boolean
  if (typeof value === 'boolean') {
    return value ? t.yes : t.no;
  }

  // Handle number
  if (typeof value === 'number') {
    return value.toLocaleString();
  }

  // Handle proof bundle status
  if (key === 'proofBundleStatus') {
    const status = value as string;
    if (status === 'not_downloaded') {
      return <span className="text-warning-600">{t.notDownloaded}</span>;
    }
    if (status === 'downloaded') {
      return <span className="text-verified-600">{t.downloaded}</span>;
    }
    return status;
  }

  if (key === 'botVotesStatus') {
    const resolved = typeof value === 'object' ? (value as { status?: string; total?: number }) : null;
    const status = resolved?.status ?? (value as string);
    const total = resolved?.total;
    const statusLabel =
      status === 'pending' ? t.pending : status === 'completed' ? t.completed : status ? String(status) : '';
    const totalLabel =
      typeof total === 'number' ? (lang === 'ja' ? `${total}${t.votes}` : `${total} ${t.votes}`) : null;
    const combined = totalLabel ? `${totalLabel} (${statusLabel})` : statusLabel;
    const statusClass = status === 'pending' ? 'text-warning-600' : status === 'completed' ? 'text-verified-600' : '';
    return <span className={statusClass}>{combined}</span>;
  }

  if (key === 'scenarioId') {
    const scenario = typeof value === 'string' ? value : '';
    return scenarioLabels[lang][scenario] ?? scenario;
  }

  // Handle string
  if (typeof value === 'string') {
    // Check if it's a hash value
    if (isHashField(key) || (value.startsWith('0x') && value.length > 20)) {
      return <KnowledgeHash value={value} />;
    }
    return value;
  }

  // Handle tally counts object
  if (key === 'tally.counts' && typeof value === 'object') {
    const counts = value as Record<string, number>;
    return (
      <span className="font-mono text-[0.8125rem]">
        {Object.entries(counts)
          .map(([k, v]) => `${k}:${v}`)
          .join(' ')}
      </span>
    );
  }

  // Handle verification steps array
  if (key === 'verification.steps' && Array.isArray(value)) {
    const steps = value as Array<{ id: string; status: string }>;
    const passedCount = steps.filter((s) => s.status === 'success').length;
    return (
      <span className="font-mono text-[0.8125rem]">
        {passedCount}/{steps.length} {t.verified}
      </span>
    );
  }

  // Handle receipt publication
  if (key === 'receiptPublication' && typeof value === 'object') {
    const pub = value as { receiptHash?: string; boardIndex?: number };
    if (pub.receiptHash) {
      return <KnowledgeHash value={pub.receiptHash} />;
    }
    return `#${pub.boardIndex}`;
  }

  // Handle inclusion proof (merklePath)
  if ((key === 'user.merklePath' || key === 'bot.merklePath') && typeof value === 'object') {
    const proof = value as { leafIndex?: number; treeSize?: number };
    return (
      <span className="font-mono text-[0.8125rem]">
        idx:{proof.leafIndex} / {proof.treeSize}
      </span>
    );
  }

  // Handle vote receipt
  if (key === 'user.voteReceipt' && typeof value === 'object') {
    const receipt = value as { bulletinIndex?: number };
    return <span className="font-mono text-[0.8125rem]">#{receipt.bulletinIndex}</span>;
  }

  // Handle objects by showing a summary
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    return (
      <span className="text-text-muted text-[0.75rem]">
        {keys.length} {t.fields}
      </span>
    );
  }

  if (typeof value === 'bigint' || typeof value === 'symbol') {
    return value.toString();
  }

  if (typeof value === 'function') {
    return value.name ? `[function ${value.name}]` : '[function]';
  }

  return null;
}

/**
 * A single knowledge item row with label and value
 *
 * Design spec:
 * - Dashed bottom border (#e8e0c8)
 * - Label: Secondary font, 0.8125rem, text-secondary
 * - Value: Mono font for hashes, aligned right
 * - ink-spread animation for new items
 */
export function KnowledgeItem({
  keyName,
  label,
  value,
  isNew = false,
  className = '',
  language = 'ja',
  highlighted = false,
}: KnowledgeItemProps): React.ReactElement {
  return (
    <div
      className={`
        relative
        flex justify-between items-baseline gap-2
        py-2 px-3 pl-4
        border-be border-dashed border-[var(--color-knowledge-border-light)]
        last:border-be-0
        ${isNew ? 'animate-ink-spread' : ''}
        ${highlighted ? 'bg-[var(--color-knowledge-highlight)] animate-knowledge-highlight-pulse' : ''}
        ${className}
      `}
      data-key={keyName}
      data-highlighted={highlighted ? 'true' : 'false'}
    >
      {isNew && <span className="knowledge-item-new-dot" aria-hidden="true" />}
      <span className="font-secondary text-[0.8125rem] text-text-secondary shrink-0">{label}</span>
      <span className="font-mono font-features-none text-[0.8125rem] text-text-primary text-right truncate">
        {formatValue(keyName, value, language)}
      </span>
    </div>
  );
}
