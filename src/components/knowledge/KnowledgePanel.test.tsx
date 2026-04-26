import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { KnowledgePanel } from './KnowledgePanel';
import { VerificationTabProvider } from './VerificationTabContext';
import { KnowledgeHighlightProvider } from './KnowledgeHighlightContext';
import type { KnowledgeItem } from '@/lib/knowledge';
import { PUBLIC_KNOWLEDGE_KEYS, VERIFY_BOT_KNOWLEDGE_KEYS, VERIFY_MY_KNOWLEDGE_KEYS } from '@/lib/knowledge';

vi.mock('@/lib/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    language: 'ja',
  }),
}));

describe('KnowledgePanel', () => {
  it('shows public fields when visible keys include public info', () => {
    const items: KnowledgeItem[] = [
      { key: 'tally.tamperedCount', value: 2, isNew: false, addedAt: 0 },
      { key: 'missingSlots', value: 4, isNew: false, addedAt: 0 },
      { key: 'receiptPublication', value: { boardIndex: 7 }, isNew: false, addedAt: 0 },
    ];

    render(<KnowledgePanel items={items} filterKeys={PUBLIC_KNOWLEDGE_KEYS} />);
    fireEvent.click(screen.getByRole('button', { name: 'knowledge.controls.expand' }));

    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('missingSlots')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('#7')).toBeInTheDocument();
  });

  it('highlights items when highlight keys are provided', () => {
    const items: KnowledgeItem[] = [{ key: 'electionId', value: 'election-456', isNew: false, addedAt: 0 }];

    render(
      <KnowledgeHighlightProvider initialKeys={['electionId']}>
        <KnowledgePanel items={items} filterKeys={['electionId'] as const} />
      </KnowledgeHighlightProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /セッション/ }));
    const highlightedItem = screen.getByText('election-456').closest('[data-key="electionId"]');
    expect(highlightedItem).not.toBeNull();
    expect(highlightedItem as HTMLElement).toHaveClass('bg-[var(--color-knowledge-highlight)]');
  });

  it('filters verify phase to my verification inputs only', () => {
    const items: KnowledgeItem[] = [
      { key: 'user.commitment', value: '0x' + 'a'.repeat(64), isNew: false, addedAt: 0 },
      { key: 'user.voteReceipt', value: { bulletinIndex: 7 }, isNew: false, addedAt: 0 },
      {
        key: 'verification.steps',
        value: [
          {
            id: 'cast_as_intended',
            status: 'success',
          },
        ],
        isNew: false,
        addedAt: 0,
      },
      { key: 'verification.reportSummary', value: 'ok', isNew: false, addedAt: 0 },
      { key: 'proofBundleStatus', value: 'not_downloaded', isNew: false, addedAt: 0 },
      { key: 'scenarioId', value: 'S1', isNew: false, addedAt: 0 },
      { key: 'bot.id', value: 12, isNew: false, addedAt: 0 },
    ];

    render(<KnowledgePanel items={items} filterKeys={VERIFY_MY_KNOWLEDGE_KEYS} />);
    fireEvent.click(screen.getByRole('button', { name: 'knowledge.controls.expand' }));

    expect(screen.getByText('user.commitment')).toBeInTheDocument();
    expect(screen.getByText('#7')).toBeInTheDocument();
    expect(screen.getByText('未ダウンロード')).toBeInTheDocument();
    expect(screen.queryByText('scenarioId')).not.toBeInTheDocument();
    expect(screen.queryByText('bot.id')).not.toBeInTheDocument();
    expect(screen.queryByText('1/1 検証済')).not.toBeInTheDocument();
    expect(screen.queryByText('ok')).not.toBeInTheDocument();
  });

  it('filters verify phase to bot inputs only when bot tab is active', () => {
    const items: KnowledgeItem[] = [
      { key: 'user.voteReceipt', value: { bulletinIndex: 3 }, isNew: false, addedAt: 0 },
      { key: 'bot.id', value: 12, isNew: false, addedAt: 0 },
      { key: 'bot.choice', value: 'A', isNew: false, addedAt: 0 },
    ];

    render(
      <VerificationTabProvider initialTab="bot">
        <KnowledgePanel items={items} filterKeys={VERIFY_BOT_KNOWLEDGE_KEYS} />
      </VerificationTabProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'knowledge.controls.expand' }));
    expect(screen.getByText('bot.id')).toBeInTheDocument();
    expect(screen.getByText('bot.choice')).toBeInTheDocument();
    expect(screen.queryByText('user.voteReceipt')).not.toBeInTheDocument();
    expect(screen.getByText('knowledge.titleBot')).toBeInTheDocument();
  });

  it('toggles group expansion when header is clicked', () => {
    const items: KnowledgeItem[] = [{ key: 'user.choice', value: 'A', isNew: false, addedAt: 0 }];

    render(<KnowledgePanel items={items} filterKeys={['user.choice'] as const} />);

    const groupButton = screen.getByRole('button', { name: /投票/ });
    expect(screen.queryByText('user.choice')).not.toBeInTheDocument();

    fireEvent.click(groupButton);
    expect(screen.getByText('user.choice')).toBeInTheDocument();

    fireEvent.click(groupButton);
    expect(screen.queryByText('user.choice')).not.toBeInTheDocument();
  });

  it('supports bottom sheet drag and snap behavior', async () => {
    const items: KnowledgeItem[] = [{ key: 'user.choice', value: 'A', isNew: false, addedAt: 0 }];
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true });

    render(<KnowledgePanel items={items} variant="bottomSheet" />);

    const sheet = screen.getByTestId('knowledge-bottom-sheet');
    const handle = screen.getByTestId('knowledge-bottom-sheet-handle');

    await waitFor(() => {
      expect(sheet).toHaveStyle({ height: '60px' });
    });

    fireEvent.pointerDown(handle, { clientY: 900, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 100, pointerId: 1 });

    await waitFor(() => {
      expect(sheet).toHaveStyle({ height: '800px' });
    });

    Object.defineProperty(window, 'innerHeight', { value: originalHeight, configurable: true });
  });

  it('syncs floating scroll position', () => {
    const items: KnowledgeItem[] = [
      { key: 'user.choice', value: 'A', isNew: false, addedAt: 0 },
      { key: 'user.commitment', value: '0x' + 'a'.repeat(64), isNew: false, addedAt: 0 },
    ];
    const handleScroll = vi.fn();

    const { container } = render(
      <KnowledgePanel
        items={items}
        variant="floating"
        dockState="floating"
        floatingScrollTop={0}
        onFloatingScrollTopChange={handleScroll}
      />,
    );

    const scrollContainer = container.querySelector('.knowledge-items-container') as HTMLDivElement;
    expect(scrollContainer).not.toBeNull();
    scrollContainer.scrollTop = 120;
    fireEvent.scroll(scrollContainer);

    expect(handleScroll).toHaveBeenCalledWith(120);
  });

  it('restores floating scroll position after docking', async () => {
    const items: KnowledgeItem[] = [
      { key: 'user.choice', value: 'A', isNew: false, addedAt: 0 },
      { key: 'user.commitment', value: '0x' + 'b'.repeat(64), isNew: false, addedAt: 0 },
    ];

    const { container, rerender } = render(
      <KnowledgePanel items={items} variant="floating" dockState="docked" floatingScrollTop={80} />,
    );

    let scrollContainer = container.querySelector('.knowledge-items-container') as HTMLDivElement;
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 200, configurable: true });
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 100, configurable: true });
    scrollContainer.scrollTop = 0;

    rerender(<KnowledgePanel items={items} variant="floating" dockState="floating" floatingScrollTop={80} />);

    scrollContainer = container.querySelector('.knowledge-items-container') as HTMLDivElement;
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 200, configurable: true });
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 100, configurable: true });

    await waitFor(() => {
      expect(scrollContainer.scrollTop).toBe(80);
    });
  });

  it('emits expanded groups when toggled', async () => {
    const items: KnowledgeItem[] = [{ key: 'user.choice', value: 'A', isNew: false, addedAt: 0 }];
    const handleExpandedGroups = vi.fn();

    render(
      <KnowledgePanel
        items={items}
        filterKeys={['user.choice'] as const}
        onExpandedGroupsChange={handleExpandedGroups}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /投票/ }));

    await waitFor(() => {
      expect(handleExpandedGroups).toHaveBeenCalledWith(['vote']);
    });
  });
});
