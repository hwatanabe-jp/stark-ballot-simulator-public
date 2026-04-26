'use client';

import { ChevronRight } from 'lucide-react';
import type { KnowledgeData, KnowledgeItem as KnowledgeItemType } from '@/lib/knowledge';
import { PUBLIC_KNOWLEDGE_KEYS } from '@/lib/knowledge';
import { KnowledgeItem } from './KnowledgeItem';

export interface KnowledgeGroupDefinition {
  id: 'session' | 'vote' | 'result' | 'verify' | 'bot' | 'public';
  labelJa: string;
  labelEn: string;
  keys: Array<keyof KnowledgeData>;
}

export const KNOWLEDGE_GROUPS: KnowledgeGroupDefinition[] = [
  {
    id: 'session',
    labelJa: 'セッション',
    labelEn: 'Session',
    keys: ['electionId', 'electionConfigHash', 'logId'],
  },
  {
    id: 'vote',
    labelJa: '投票',
    labelEn: 'Vote',
    keys: [
      'user.choice',
      'user.random',
      'user.commitment',
      'user.voteId',
      'user.bulletinIndex',
      'user.bulletinRootAtCast',
      'botVotesStatus',
    ],
  },
  {
    id: 'result',
    labelJa: '結果',
    labelEn: 'Result',
    keys: ['proofBundleStatus'],
  },
  {
    id: 'verify',
    labelJa: '検証',
    labelEn: 'Verification',
    keys: ['user.voteReceipt', 'user.merklePath'],
  },
  {
    id: 'bot',
    labelJa: 'ボット検証',
    labelEn: 'Bot Verification',
    keys: [
      'bot.id',
      'bot.choice',
      'bot.random',
      'bot.commitment',
      'bot.voteId',
      'bot.bulletinIndex',
      'bot.bulletinRootAtCast',
      'bot.voteTimestamp',
      'bot.merklePath',
      'bot.verification.steps',
    ],
  },
  {
    id: 'public',
    labelJa: '公開情報',
    labelEn: 'Public',
    keys: [...PUBLIC_KNOWLEDGE_KEYS],
  },
];

export interface KnowledgeGroupProps {
  group: KnowledgeGroupDefinition;
  items: KnowledgeItemType[];
  language: 'ja' | 'en';
  expanded: boolean;
  onToggle: (groupId: KnowledgeGroupDefinition['id']) => void;
  highlightedKeys: Array<keyof KnowledgeData>;
  isCurrent?: boolean;
  emptyLabel: string;
  getLabel: (key: keyof KnowledgeData) => string;
}

export function KnowledgeGroup({
  group,
  items,
  language,
  expanded,
  onToggle,
  highlightedKeys,
  isCurrent = false,
  emptyLabel,
  getLabel,
}: KnowledgeGroupProps): React.ReactElement {
  const label = language === 'ja' ? group.labelJa : group.labelEn;
  const countLabel = language === 'ja' ? `${items.length}項目` : `${items.length} items`;
  const hasNew = items.some((item) => item.isNew);

  return (
    <section className="border border-[var(--color-knowledge-border-light)] rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => onToggle(group.id)}
        className={cn(
          'w-full px-3 py-2 flex items-center justify-between text-left bg-[var(--color-knowledge-bg-alt)] hover:bg-[var(--color-knowledge-highlight)] transition-colors',
          hasNew && 'animate-group-notify',
        )}
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <ChevronRight
            className={cn('w-4 h-4 text-text-secondary transition-transform duration-200', expanded && 'rotate-90')}
            aria-hidden="true"
          />
          <span
            className={cn(
              'font-secondary text-[0.8125rem]',
              isCurrent ? 'text-ink-900 font-medium' : 'text-text-muted',
            )}
          >
            {label}
          </span>
          {hasNew && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-verified-500 shadow-[0_0_4px_var(--color-verified-400)]"
              aria-hidden="true"
            />
          )}
        </div>
        <span className="text-[0.75rem] text-text-muted font-secondary">{countLabel}</span>
      </button>
      {expanded && (
        <div className="bg-[var(--color-knowledge-bg)]">
          {items.length === 0 ? (
            <p className="px-3 py-3 text-text-muted text-[0.75rem] italic">{emptyLabel}</p>
          ) : (
            items.map((item) => (
              <KnowledgeItem
                key={item.key}
                keyName={item.key}
                label={getLabel(item.key)}
                value={item.value}
                isNew={item.isNew}
                language={language}
                highlighted={highlightedKeys.includes(item.key)}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

const cn = (...classes: Array<string | false | undefined>): string => classes.filter(Boolean).join(' ');
