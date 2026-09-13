'use client';

import { useMemo, useState } from 'react';
import type { KnowledgeData, KnowledgeItem as KnowledgeItemType } from '@stark-ballot/web/knowledge';
import { useTranslation } from '@stark-ballot/web/hooks/useTranslation';
import { useKnowledgeHighlight } from './KnowledgeHighlightContext';
import { useVerificationTab } from './VerificationTabContext';
import { KnowledgeGroup, type KnowledgeGroupDefinition, KNOWLEDGE_GROUPS } from './KnowledgeGroup';
import { selectKnowledgeItems, useKnowledgeItems } from './useKnowledgeItems';
import './KnowledgePanel.css';

interface KnowledgePanelProps {
  title?: string;
  className?: string;
  filterKeys?: ReadonlyArray<keyof KnowledgeData>;
  defaultExpandedGroups?: Array<KnowledgeGroupDefinition['id']>;
  /** Supplied snapshots are useful for isolated component examples and tests. */
  items?: readonly KnowledgeItemType[];
}

/** Existing knowledge, in document flow, with persistent explicit disclosure. */
export function KnowledgePanel({
  title,
  className = '',
  filterKeys,
  defaultExpandedGroups = ['session'],
  items: externalItems,
}: KnowledgePanelProps): React.ReactElement {
  const { t, language } = useTranslation();
  const { highlightedKeys } = useKnowledgeHighlight();
  const { activeTab } = useVerificationTab();
  const items = useKnowledgeItems(externalItems);
  const groupedItems = useMemo(() => {
    const visibleItems = selectKnowledgeItems(items, filterKeys ?? KNOWLEDGE_GROUPS.flatMap((group) => group.keys));
    return KNOWLEDGE_GROUPS.map((group) => ({
      group,
      items: selectKnowledgeItems(visibleItems, group.keys),
    })).filter((entry) => entry.items.length > 0);
  }, [items, filterKeys]);
  const isBotView = activeTab === 'bot' && groupedItems.some(({ group }) => group.id === 'bot');
  const panelTitle = title ?? t(isBotView ? 'knowledge.titleBot' : 'knowledge.title');

  const selectedGroups = groupedItems
    .filter(({ items: groupItems }) => groupItems.some((item) => highlightedKeys.includes(item.key)))
    .map(({ group }) => group.id);
  const selection = JSON.stringify([highlightedKeys, selectedGroups]);
  const [disclosure, setDisclosure] = useState(() => ({
    selection,
    expanded: new Set([...defaultExpandedGroups, ...selectedGroups]),
  }));
  // Reconcile selection before committing a closed group to the DOM.
  // Unrelated value changes preserve manual disclosure and keyboard focus.
  if (disclosure.selection !== selection) {
    setDisclosure({ selection, expanded: new Set([...disclosure.expanded, ...selectedGroups]) });
  }

  const toggleGroup = (id: KnowledgeGroupDefinition['id']) => {
    setDisclosure((previous) => {
      const next = new Set(previous.expanded);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...previous, expanded: next };
    });
  };

  return (
    <aside className={`knowledge-panel ${className}`} aria-label={panelTitle}>
      <div className="knowledge-panel-header">
        <h2>{panelTitle}</h2>
        <div className="knowledge-panel-controls">
          <button
            type="button"
            onClick={() => setDisclosure({ selection, expanded: new Set(groupedItems.map(({ group }) => group.id)) })}
          >
            {t('knowledge.controls.expand')}
          </button>
          <button type="button" onClick={() => setDisclosure({ selection, expanded: new Set() })}>
            {t('knowledge.controls.collapse')}
          </button>
        </div>
      </div>
      {groupedItems.length > 0 ? (
        groupedItems.map(({ group, items: groupItems }) => (
          <KnowledgeGroup
            key={group.id}
            group={group}
            items={groupItems}
            language={language}
            expanded={disclosure.expanded.has(group.id)}
            onToggle={toggleGroup}
            highlightedKeys={highlightedKeys}
            getLabel={(key) => t(`knowledge.items.${key}`)}
          />
        ))
      ) : (
        <p className="knowledge-panel-empty">{t('knowledge.empty')}</p>
      )}
    </aside>
  );
}
