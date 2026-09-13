import type { Meta, StoryObj } from '@storybook/react';
import {
  PUBLIC_KNOWLEDGE_KEYS,
  VERIFY_MY_KNOWLEDGE_KEYS,
  knowledgeItemsFromData,
  type KnowledgeData,
} from '@stark-ballot/web/knowledge';
import { LanguageProvider } from '@stark-ballot/web/hooks/useLanguage';
import { buildLanguageCookie, LANGUAGE_STORAGE_KEY } from '@stark-ballot/web/i18n/language';
import { KnowledgePanel } from './KnowledgePanel';
import { KnowledgeEvidence } from './KnowledgeEvidence';
import { KnowledgeHighlightProvider } from './KnowledgeHighlightContext';

const hash = `0x${'a'.repeat(64)}`;
// Synthetic component values, never a cryptographic result or active session.
const snapshot = {
  electionId: '550e8400-e29b-41d4-a716-446655440000',
  'user.choice': 'A',
  'user.random': `0x${'d'.repeat(64)}`,
  'user.commitment': hash,
  'user.voteId': '00000000-0000-4000-8000-000000000001',
  'user.voteReceipt': {
    voteId: '00000000-0000-4000-8000-000000000001',
    commitment: hash,
    bulletinIndex: 0,
    bulletinRootAtCast: hash,
    timestamp: 0,
  },
  'user.merklePath': { leafIndex: 0, treeSize: 1, merklePath: [], bulletinRootAtCast: hash },
  'tally.counts': { A: 13, B: 12, C: 14, D: 11, E: 14 },
  'tally.totalVotes': 64,
  missingSlots: 0,
  invalidPresentedSlots: 0,
  rejectedRecords: 0,
  validVotes: 64,
  excludedSlots: 0,
  totalExpected: 64,
  bulletinRoot: hash,
  treeSize: 64,
  sthDigest: hash,
  seenBitmapRoot: hash,
  includedBitmapRoot: hash,
  inputCommitment: hash,
  imageId: hash,
  proofBundleStatus: 'not_downloaded',
} satisfies KnowledgeData;
const items = knowledgeItemsFromData(snapshot);
const voteKeys = ['electionId', 'user.choice', 'user.random', 'user.commitment', 'user.voteId'] as const;

const meta = {
  title: 'Knowledge/Panel',
  component: KnowledgePanel,
  parameters: { language: 'ja', highlightedKeys: [] },
  loaders: [
    ({ parameters }) => {
      const language = parameters['language'] === 'en' ? 'en' : 'ja';
      localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
      document.cookie = buildLanguageCookie(language);
      return {};
    },
  ],
  decorators: [
    (Story, context) => {
      const language = context.parameters['language'] === 'en' ? 'en' : 'ja';
      const highlightedKeys = context.parameters['highlightedKeys'] as string[];
      return (
        <LanguageProvider key={context.id} initialLanguage={language}>
          <KnowledgeHighlightProvider initialKeys={highlightedKeys}>
            <div style={{ maxWidth: '1080px', margin: '0 auto' }}>
              <Story />
            </div>
          </KnowledgeHighlightProvider>
        </LanguageProvider>
      );
    },
  ],
  args: { items, filterKeys: VERIFY_MY_KNOWLEDGE_KEYS },
} satisfies Meta<typeof KnowledgePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { args: { items: [] } };
export const Vote: Story = { args: { filterKeys: voteKeys, defaultExpandedGroups: ['session', 'vote'] } };
export const Result: Story = {
  args: {
    filterKeys: [...voteKeys, ...PUBLIC_KNOWLEDGE_KEYS, 'proofBundleStatus'],
    defaultExpandedGroups: ['result', 'public'],
  },
};
export const Verification: Story = { args: { defaultExpandedGroups: ['verify', 'public'] } };
export const SelectedEvidence: Story = {
  parameters: { highlightedKeys: ['user.commitment'] },
  render: (args) => (
    <>
      <KnowledgeEvidence items={args.items ?? []} filterKeys={['user.commitment']} />
      <div style={{ marginTop: '30px' }}>
        <KnowledgePanel {...args} />
      </div>
    </>
  ),
};
export const LongValuesEnglish: Story = {
  parameters: { language: 'en' },
  args: { defaultExpandedGroups: ['session', 'vote', 'verify', 'public'] },
};
export const UpdatedVote: Story = {
  args: {
    filterKeys: voteKeys,
    defaultExpandedGroups: ['vote'],
    items: items.map((item) => (item.key === 'user.choice' ? { ...item, value: 'B', isNew: true } : item)),
  },
};
