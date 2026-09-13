import type { KnowledgeData } from './types';
import { normalizeKnowledgeData } from './normalizer';
import { saveKnowledgeData } from './store';

const candidate = normalizeKnowledgeData({ vote: 12 });

// @ts-expect-error Normalizing field names does not admit their values.
const admitted: Partial<KnowledgeData> = candidate;
// @ts-expect-error Unadmitted API values must enter through the store's API boundary.
saveKnowledgeData(candidate);

void admitted;
