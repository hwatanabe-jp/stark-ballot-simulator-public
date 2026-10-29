const COUNT_FIELDS = ['missingSlots', 'invalidPresentedSlots', 'validVotes', 'excludedSlots'] as const;
type ReportCounts = Partial<Record<(typeof COUNT_FIELDS)[number], number>>;

export function formatCliCountDiagnostics(details: ReportCounts): string | undefined {
  if (!COUNT_FIELDS.some((field) => typeof details[field] === 'number')) return undefined;
  return `Counts: ${COUNT_FIELDS.map((field) => `${field}=${details[field] ?? 'n/a'}`).join(', ')}`;
}
