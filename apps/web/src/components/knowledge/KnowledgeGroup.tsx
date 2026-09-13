'use client';

import { ChevronRight } from 'lucide-react';
import { useId } from 'react';
import type { KnowledgeData, KnowledgeItem as KnowledgeItemType } from '@stark-ballot/web/knowledge';
import { PUBLIC_KNOWLEDGE_KEYS } from '@stark-ballot/web/knowledge';
import { BOT_KNOWLEDGE_KEYS } from '@stark-ballot/web/knowledge/types';
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
    keys: [...BOT_KNOWLEDGE_KEYS],
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
  items: readonly KnowledgeItemType[];
  language: 'ja' | 'en';
  expanded: boolean;
  onToggle: (groupId: KnowledgeGroupDefinition['id']) => void;
  highlightedKeys: readonly string[];
  getLabel: (key: keyof KnowledgeData) => string;
}

export function KnowledgeGroup({
  group,
  items,
  language,
  expanded,
  onToggle,
  highlightedKeys,
  getLabel,
}: KnowledgeGroupProps): React.ReactElement {
  const label = language === 'ja' ? group.labelJa : group.labelEn;
  const contentId = useId();

  return (
    <section className="knowledge-group">
      <h3>
        <button
          type="button"
          onClick={() => onToggle(group.id)}
          className="knowledge-group-toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
        >
          <ChevronRight className="knowledge-group-chevron" aria-hidden="true" />
          <span>{label}</span>
        </button>
      </h3>
      {expanded && (
        <dl id={contentId} className="knowledge-list">
          {items.map((item) => (
            <KnowledgeItem
              key={item.key}
              item={item}
              label={getLabel(item.key)}
              language={language}
              highlighted={highlightedKeys.includes(item.key)}
            />
          ))}
        </dl>
      )}
    </section>
  );
}
