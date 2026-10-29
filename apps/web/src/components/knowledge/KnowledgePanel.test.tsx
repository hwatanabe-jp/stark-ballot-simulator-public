import { admitSessionIdentity } from '@stark-ballot/web/session/identity';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgePanel } from './KnowledgePanel';
import { KnowledgeEvidence } from './KnowledgeEvidence';
import { useKnowledgeItems } from './useKnowledgeItems';
import { KnowledgeHighlightProvider } from './KnowledgeHighlightContext';
import { VerificationTabProvider } from './VerificationTabContext';
import {
  clearKnowledge,
  clearKnowledgeForSession,
  saveKnowledgeData,
  PUBLIC_KNOWLEDGE_KEYS,
  VERIFY_BOT_KNOWLEDGE_KEYS,
  VERIFY_MY_KNOWLEDGE_KEYS,
  knowledgeItemsFromData,
  type KnowledgeData,
  type KnowledgeItem,
} from '@stark-ballot/web/knowledge';
import { clearSession, initializeSession } from '@stark-ballot/web/session/client';
import { KNOWLEDGE_STORAGE_KEY, SESSION_STORAGE_KEY } from '@stark-ballot/web/session/storage';

vi.mock('@stark-ballot/web/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => (key.startsWith('knowledge.items.') ? key.slice('knowledge.items.'.length) : key),
    language: 'ja',
  }),
}));

const hash = `0x${'a'.repeat(64)}`;
const receipt = { voteId: 'vote', commitment: hash, bulletinIndex: 7, bulletinRootAtCast: hash, timestamp: 1 };
const item = <K extends keyof KnowledgeData>(key: K, value: KnowledgeData[NoInfer<K>]): KnowledgeItem => {
  const data: KnowledgeData = {};
  data[key] = value;
  const first = knowledgeItemsFromData(data)[0];
  if (!first) throw new Error('Expected a knowledge fixture value');
  return first;
};

function LiveEvidence(): React.ReactElement {
  return <KnowledgeEvidence items={useKnowledgeItems()} filterKeys={['user.commitment']} />;
}

describe('KnowledgePanel', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('shows existing public values and omits the ambiguous tally tamper count', () => {
    render(
      <KnowledgePanel
        items={[
          item('tally.tamperedCount', 2),
          item('missingSlots', 4),
          item('receiptPublication', { boardIndex: 7, receiptHash: hash }),
        ]}
        filterKeys={PUBLIC_KNOWLEDGE_KEYS}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'knowledge.controls.expand' }));
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText(hash)).toBeInTheDocument();
    expect(screen.queryByText('tally.tamperedCount')).not.toBeInTheDocument();
  });

  it('opens the group containing a selected existing value without a second action', () => {
    render(
      <KnowledgeHighlightProvider initialKeys={['user.commitment']}>
        <KnowledgePanel items={[item('user.commitment', hash)]} filterKeys={['user.commitment']} />
      </KnowledgeHighlightProvider>,
    );
    expect(screen.getByRole('button', { name: '投票' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(hash).closest('[data-key]')).toHaveAttribute('data-highlighted', 'true');
  });

  it('keeps disclosure and keyboard focus when existing values update', () => {
    const { rerender } = render(<KnowledgePanel items={[item('user.choice', 'A')]} filterKeys={['user.choice']} />);
    const toggle = screen.getByRole('button', { name: '投票' });
    toggle.focus();
    fireEvent.click(toggle);
    rerender(<KnowledgePanel items={[{ ...item('user.choice', 'B'), isNew: true }]} filterKeys={['user.choice']} />);
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('B')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByText('user.choice')).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });

  it('never reveals hidden keys or unrequested bot values through expansion', () => {
    render(
      <KnowledgePanel
        items={[
          item('user.commitment', hash),
          item('user.voteReceipt', receipt),
          item('verification.steps', [{ id: 'cast_as_intended', status: 'success', inputs: [] }]),
          item('verification.reportSummary', { status: 'ok' }),
          item('proofBundleStatus', 'not_downloaded'),
          item('scenarioId', 'S1'),
          item('bot.id', 12),
        ]}
        filterKeys={VERIFY_MY_KNOWLEDGE_KEYS}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'knowledge.controls.expand' }));
    expect(screen.getByText('#7')).toBeInTheDocument();
    expect(screen.getByText('未ダウンロード')).toBeInTheDocument();
    for (const key of ['scenarioId', 'bot.id', 'verification.steps', 'verification.reportSummary']) {
      expect(screen.queryByText(key)).not.toBeInTheDocument();
    }
  });

  it('retains the generic bot filter without mixing in private user evidence', () => {
    render(
      <VerificationTabProvider initialTab="bot">
        <KnowledgePanel
          items={[item('user.voteReceipt', receipt), item('bot.id', 12), item('bot.choice', 'A')]}
          filterKeys={VERIFY_BOT_KNOWLEDGE_KEYS}
        />
      </VerificationTabProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'knowledge.controls.expand' }));
    expect(screen.getByText('bot.id')).toBeInTheDocument();
    expect(screen.queryByText('user.voteReceipt')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'knowledge.titleBot' })).toBeInTheDocument();
  });

  it('displays only the empty state when no permitted values exist', () => {
    render(<KnowledgePanel items={[item('sessionId', 'hidden-session')]} filterKeys={['sessionId', 'user.choice']} />);
    expect(screen.getByText('knowledge.empty')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '投票' })).not.toBeInTheDocument();
    expect(screen.queryByText('hidden-session')).not.toBeInTheDocument();
  });

  it('clears a mounted panel when its current snapshot is explicitly cleared', async () => {
    saveKnowledgeData({ sessionId: 'session-a', electionId: 'election-a' });
    render(<KnowledgePanel filterKeys={['electionId']} />);
    expect(screen.getByText('election-a')).toBeInTheDocument();
    await act(async () => clearKnowledgeForSession('different-session'));
    expect(screen.getByText('election-a')).toBeInTheDocument();
    await act(async () => clearKnowledgeForSession('session-a'));
    expect(screen.queryByText('election-a')).not.toBeInTheDocument();
    act(() => {
      saveKnowledgeData({ sessionId: 'session-a', electionId: 'election-a' });
    });
    expect(screen.getByText('election-a')).toBeInTheDocument();
    await act(async () => clearKnowledge());
    expect(screen.queryByText('election-a')).not.toBeInTheDocument();
  });

  it('re-admits cross-tab session changes and preserves the replacement snapshot', () => {
    const identity = {
      ...admitSessionIdentity({ sessionId: 'session-a', capabilityToken: 'capability-a' }),
      electionId: '123e4567-e89b-42d3-a456-426614174000',
      electionConfigHash: hash,
      logId: hash,
    };
    initializeSession(identity);
    saveKnowledgeData({ electionId: '123e4567-e89b-42d3-a456-426614174000' });
    render(<KnowledgePanel filterKeys={['electionId']} />);
    expect(screen.getByText('123e4567-e89b-42d3-a456-426614174000')).toBeInTheDocument();
    const replacement = JSON.stringify({ sessionId: 'session-b', electionId: '123e4567-e89b-42d3-a456-426614174001' });
    localStorage.setItem(KNOWLEDGE_STORAGE_KEY, replacement);
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        ...identity,
        sessionId: 'session-b',
        capabilityToken: 'capability-b',
        electionId: '123e4567-e89b-42d3-a456-426614174001',
        phase: 'voting',
        lastActivity: Date.now(),
        expiresAt: Date.now() + 60000,
      }),
    );
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: SESSION_STORAGE_KEY }));
    });
    expect(screen.queryByText('123e4567-e89b-42d3-a456-426614174000')).not.toBeInTheDocument();
    expect(screen.queryByText('123e4567-e89b-42d3-a456-426614174001')).not.toBeInTheDocument();
    expect(localStorage.getItem(KNOWLEDGE_STORAGE_KEY)).toBe(replacement);
  });

  it('clears mounted panel and inline evidence when the same tab clears its session', async () => {
    const electionId = '123e4567-e89b-42d3-a456-426614174000';
    initializeSession({
      ...admitSessionIdentity({ sessionId: 'session-a', capabilityToken: 'capability-a' }),
      electionId,
      electionConfigHash: hash,
      logId: hash,
    });
    saveKnowledgeData({ electionId, 'user.commitment': hash });
    render(
      <>
        <KnowledgePanel filterKeys={['electionId']} />
        <LiveEvidence />
      </>,
    );
    expect(screen.getByText(electionId)).toBeInTheDocument();
    expect(screen.getByText(hash)).toBeInTheDocument();

    await act(async () => clearSession());

    expect(localStorage.getItem(KNOWLEDGE_STORAGE_KEY)).toBeNull();
    expect(screen.queryByText(electionId)).not.toBeInTheDocument();
    expect(screen.queryByText(hash)).not.toBeInTheDocument();
  });

  it('defers admission-triggered snapshot removal without recursive updates during render', async () => {
    const electionId = '123e4567-e89b-42d3-a456-426614174000';
    initializeSession({
      ...admitSessionIdentity({ sessionId: 'session-a', capabilityToken: 'capability-a' }),
      electionId,
      electionConfigHash: hash,
      logId: hash,
    });
    saveKnowledgeData({ electionId, 'user.commitment': hash });
    const { rerender } = render(
      <div>
        <KnowledgePanel filterKeys={['electionId']} />
      </div>,
    );
    expect(screen.getByText(electionId)).toBeInTheDocument();
    localStorage.setItem(
      KNOWLEDGE_STORAGE_KEY,
      JSON.stringify({
        sessionId: 'session-a',
        electionId,
        'user.voteReceipt': { ...receipt, timestamp: 'invalid' },
      }),
    );
    const consoleError = vi.spyOn(console, 'error');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    try {
      await act(async () => {
        rerender(
          <div>
            <KnowledgePanel filterKeys={['electionId']} />
            <LiveEvidence />
          </div>,
        );
      });

      expect(removeItem).toHaveBeenCalledExactlyOnceWith(KNOWLEDGE_STORAGE_KEY);
      expect(localStorage.getItem(KNOWLEDGE_STORAGE_KEY)).toBeNull();
      expect(screen.queryByText(electionId)).not.toBeInTheDocument();
      expect(screen.queryByText(hash)).not.toBeInTheDocument();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      removeItem.mockRestore();
      consoleError.mockRestore();
    }
  });
});

describe('KnowledgeEvidence', () => {
  it('reuses existing value formats without expanding receipt internals or hidden fields', () => {
    render(
      <KnowledgeEvidence
        items={[item('user.voteReceipt', receipt), item('user.commitment', hash), item('sessionId', 'hidden')]}
        filterKeys={['user.voteReceipt', 'user.commitment', 'sessionId']}
      />,
    );
    expect(screen.getByText('#7')).toBeInTheDocument();
    expect(screen.getByText(hash)).toBeInTheDocument();
    expect(screen.queryByText('timestamp')).not.toBeInTheDocument();
    expect(screen.queryByText('hidden')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('does not fabricate absent inputs or reveal verification evidence outside its filter', () => {
    const { container } = render(
      <KnowledgeEvidence items={[item('user.voteReceipt', receipt)]} filterKeys={['user.commitment']} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
