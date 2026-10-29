// Types
export type { VerificationStepStatus, VerificationStepId, KnowledgeData, KnowledgeItem } from './types';

export { KNOWLEDGE_KEYS, HASH_FIELDS } from './types';
export { knowledgeItemsFromData } from './items';

export {
  PUBLIC_KNOWLEDGE_KEYS,
  VERIFY_MY_KNOWLEDGE_KEYS,
  VERIFY_BOT_KNOWLEDGE_KEYS,
  HIDDEN_KNOWLEDGE_KEYS,
  VERIFICATION_GATED_KEYS,
} from './visibility';

// Normalizer

// Store
export {
  getKnowledgeValue,
  saveKnowledgeData,
  mergeKnowledgeFromApi,
  clearBotKnowledge,
  clearKnowledge,
  clearKnowledgeForSession,
  subscribeToKnowledge,
  getKnowledgeItems,
  setProofBundleStatus,
} from './store';
