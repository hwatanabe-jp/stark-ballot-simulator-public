'use client';

import { HASH_FIELDS, type KnowledgeData, type KnowledgeItem as KnowledgeItemType } from '@stark-ballot/web/knowledge';
import { KnowledgeHash } from './KnowledgeHash';

interface KnowledgeItemProps {
  item: KnowledgeItemType;
  /** Display label for the item */
  label: string;
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
    verified: '検証済',
    pending: '処理中',
    notDownloaded: '未ダウンロード',
    downloaded: 'ダウンロード済',
    completed: '完了',
    fields: 'フィールド',
    votes: '票',
  },
  en: {
    verified: 'verified',
    pending: 'Pending',
    notDownloaded: 'Not downloaded',
    downloaded: 'Downloaded',
    completed: 'Completed',
    fields: 'fields',
    votes: 'votes',
  },
} as const;

const scenarioLabels: Record<'ja' | 'en', Record<NonNullable<KnowledgeData['scenarioId']>, string>> = {
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
function formatValue(item: KnowledgeItemType, lang: 'ja' | 'en' = 'ja'): React.ReactNode {
  const { key, value } = item;
  const t = i18n[lang];

  // Handle number
  if (typeof value === 'number') {
    return value.toLocaleString();
  }

  // Handle proof bundle status
  if (key === 'proofBundleStatus') {
    const status = value;
    if (status === 'not_downloaded') {
      return <span className="text-warning-600">{t.notDownloaded}</span>;
    }
    if (status === 'downloaded') {
      return <span className="text-verified-600">{t.downloaded}</span>;
    }
    return status;
  }

  if (key === 'botVotesStatus') {
    const resolved = typeof value === 'object' ? value : null;
    const status = typeof value === 'object' ? value.status : value;
    const total = resolved?.total;
    const statusLabel = status === 'pending' ? t.pending : t.completed;
    const totalLabel =
      typeof total === 'number' ? (lang === 'ja' ? `${total}${t.votes}` : `${total} ${t.votes}`) : null;
    const combined = totalLabel ? `${totalLabel} (${statusLabel})` : statusLabel;
    const statusClass = status === 'pending' ? 'text-warning-600' : 'text-verified-600';
    return <span className={statusClass}>{combined}</span>;
  }

  if (key === 'scenarioId') {
    return scenarioLabels[lang][value];
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
  if (key === 'tally.counts') {
    const counts = value;
    return (
      <span className="font-mono text-[0.8125rem]">
        {Object.entries(counts)
          .map(([k, v]) => `${k}:${v}`)
          .join(' ')}
      </span>
    );
  }

  // Handle verification steps array
  if (key === 'verification.steps') {
    const steps = value;
    const passedCount = steps.filter((s) => s.status === 'success').length;
    return (
      <span className="font-mono text-[0.8125rem]">
        {passedCount}/{steps.length} {t.verified}
      </span>
    );
  }

  // Handle receipt publication
  if (key === 'receiptPublication') {
    return <KnowledgeHash value={value.receiptHash} />;
  }

  // Handle inclusion proof (merklePath)
  if (key === 'user.merklePath' || key === 'bot.merklePath') {
    const proof = value;
    return (
      <span className="font-mono text-[0.8125rem]">
        idx:{proof.leafIndex} / {proof.treeSize}
      </span>
    );
  }

  // Handle vote receipt
  if (key === 'user.voteReceipt') {
    const receipt = value;
    return <span className="font-mono text-[0.8125rem]">#{receipt.bulletinIndex}</span>;
  }

  // Handle objects by showing a summary
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    return (
      <span className="text-[0.75rem] text-text-muted">
        {keys.length} {t.fields}
      </span>
    );
  }

  return null;
}

/**
 * A single knowledge item row with label and value
 *
 * The label/value pair is shared by the panel and inline check evidence.
 */
export function KnowledgeItem({
  item,
  label,
  className = '',
  language = 'ja',
  highlighted = false,
}: KnowledgeItemProps): React.ReactElement {
  return (
    <div
      className={`knowledge-entry ${className}`}
      data-key={item.key}
      data-highlighted={highlighted ? 'true' : 'false'}
    >
      <dt className="knowledge-label">{label}</dt>
      <dd className="knowledge-value">{formatValue(item, language)}</dd>
    </div>
  );
}
