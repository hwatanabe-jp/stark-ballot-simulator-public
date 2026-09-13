import type { KnowledgeData, KnowledgeItem as KnowledgeItemType } from '@stark-ballot/web/knowledge';
import { useTranslation } from '@stark-ballot/web/hooks/useTranslation';
import { KnowledgeItem } from './KnowledgeItem';
import { selectKnowledgeItems } from './useKnowledgeItems';
import './KnowledgePanel.css';

interface KnowledgeEvidenceProps {
  items: readonly KnowledgeItemType[];
  /** The caller intersects current route visibility with the selected check inputs. */
  filterKeys: ReadonlyArray<keyof KnowledgeData>;
  id?: string;
  className?: string;
}

/** Reuses the already-displayed values immediately below a selected check. */
export function KnowledgeEvidence({
  items,
  filterKeys,
  id,
  className = '',
}: KnowledgeEvidenceProps): React.ReactElement | null {
  const { t, language } = useTranslation();
  const selected = selectKnowledgeItems(items, filterKeys);
  if (selected.length === 0) return null;
  return (
    <dl id={id} className={`knowledge-evidence ${className}`}>
      {selected.map((item) => (
        <KnowledgeItem key={item.key} item={item} label={t(`knowledge.items.${item.key}`)} language={language} />
      ))}
    </dl>
  );
}
