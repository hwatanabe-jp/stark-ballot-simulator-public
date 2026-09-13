interface KnowledgeHashProps {
  value: string;
  className?: string;
}

/** Full, selectable evidence; copying uses the browser's native text selection. */
export function KnowledgeHash({ value, className = '' }: KnowledgeHashProps): React.ReactElement {
  const fullValue = value.startsWith('0x') ? value : `0x${value}`;
  return <code className={`knowledge-hash ${className}`}>{fullValue}</code>;
}
