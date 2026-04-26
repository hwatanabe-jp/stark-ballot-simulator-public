# レイアウトアーキテクチャ定義書

> STARK Ballot Simulator UI リデザイン - Proposal A「書道巻物」採用

---

## 1. 概要

### 1.1 採用アーキテクチャ

**Proposal A: 書道巻物 (Single-Column Scroll Flow)**

伝統的な巻物（まきもの）に着想を得たシングルカラムレイアウト。縦方向に自然に読み進める日本の文書文化を反映し、ユーザーの注意を現在のタスクに集中させる。

### 1.2 従来レイアウトからの脱却

**禁止事項**:

> 2カラムの固定レイアウト（`LayoutProvider.tsx`, `Sidebar.tsx`）を前提としない構成へ。

旧レイアウト (廃止):

```text
┌─────────────────────────────────────────────────────────────┐
│  Header                                                      │
├──────────────┬─────────────────────────────┬────────────────┤
│  Sidebar     │  Main Content               │  Knowledge     │
│  (w-64)      │  (flex-1)                   │  Panel (w-80)  │
│  固定        │                             │  固定          │
└──────────────┴─────────────────────────────┴────────────────┘
```

新レイアウト (採用):

```text
┌─────────────────────────────────────────────────────────────┐
│  Header (sticky)                                             │
├─────────────────────────────────────────────────────────────┤
│  Step Indicator (horizontal, sticky)                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│              ┌─────────────────────────┐                     │
│              │                         │                     │
│              │    Main Content         │                     │
│              │    (max-w-2xl)          │                     │
│              │                         │                     │
│              └─────────────────────────┘                     │
│                                                              │
│              ┌─────────────────────────┐                     │
│              │  Knowledge Panel        │                     │
│              │  (floating/docked)      │                     │
│              └─────────────────────────┘                     │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  Footer                                                      │
└─────────────────────────────────────────────────────────────┘
```

> **注記**: `/`（トップページ）では知識パネルは表示しない。

---

## 2. レイアウト構造

### 2.1 グローバルレイアウト

```tsx
<div className="min-h-screen flex flex-col bg-paper-warm">
  {/* 1. Header - sticky */}
  <Header onReset={handleReset} showReset={!isLegalRoute} />

  {/* 2. Step Indicator - sticky below header */}
  {!isLegalRoute && <StepIndicatorHorizontal language={language} onReset={handleReset} />}

  {/* 3. Main Content Area */}
  {/* Note: /verify は max-w-4xl, / は max-w-none, 法務ページは max-w-3xl */}
  <main className="flex-1 w-full mx-auto px-4 py-8 lg:px-8">
    {children}

    {/* Mobile: bottom sheet */}
    {showKnowledgePanel && isMobile && <KnowledgePanel filterKeys={visibleKeys} variant="bottomSheet" />}

    {/* Desktop: docking sentinel (end of main content) */}
    {showKnowledgePanel && !isMobile && <div ref={dockZoneRef} aria-hidden className="h-px w-full" />}

    {/* Desktop: docked panel in flow */}
    {showKnowledgePanel && !isMobile && (
      <div className="mt-8">
        {isDocked && (
          <KnowledgePanel
            className="knowledge-docked"
            filterKeys={visibleKeys}
            variant="floating"
            dockState="docked"
            defaultExpandedGroups={floatingExpandedGroups}
          />
        )}
      </div>
    )}

    {/* Desktop: spacer to prevent overlap */}
    {showKnowledgePanel && !isMobile && spacerHeight > 0 && <div aria-hidden style={{ height: `${spacerHeight}px` }} />}
  </main>

  {/* Desktop: floating panel */}
  {showKnowledgePanel && !isMobile && isFloating && (
    <div
      ref={panelRef}
      className="knowledge-floating-container fixed inset-x-0"
      style={{ '--knowledge-floating-offset': `${floatingBottomOffsetPx}px` }}
    >
      <div className={`w-full px-4 lg:px-8 ${contentWidthClass} mx-auto`}>
        <KnowledgePanel
          className="knowledge-floating"
          filterKeys={visibleKeys}
          variant="floating"
          dockState="floating"
          floatingScrollTop={floatingScrollTop}
          onFloatingScrollTopChange={setFloatingScrollTop}
          onExpandedGroupsChange={setFloatingExpandedGroups}
        />
      </div>
    </div>
  )}

  {/* 5. Footer */}
  <Footer />

  {/* Mobile: spacer for bottom sheet */}
  {showKnowledgePanel && isMobile && (
    <div aria-hidden style={{ height: 'calc(60px + env(safe-area-inset-bottom, 0px))' }} />
  )}
</div>
```

### 2.2 レイアウト変数

```css
/* Layout system */
--layout-content-max-width: 42rem; /* max-w-2xl = 672px */
--layout-content-max-width-wide: 56rem; /* max-w-4xl = 896px (/verify 用) */
--layout-padding-x: 1rem; /* px-4 = 16px */
--layout-padding-x-lg: 2rem; /* px-8 = 32px (desktop) */
--header-height: 57px;
--step-bar-height: 56px;
--sticky-offset: calc(var(--header-height) + var(--step-bar-height)); /* 113px */
```

> **実装メモ**: `--header-height` / `--step-bar-height` は `globals.css` に追加済み。現状は固定値で運用している。

### 2.3 ページ別幅ルール

| ルート               | コンテンツ幅           | 理由                                                      |
| -------------------- | ---------------------- | --------------------------------------------------------- |
| `/`                  | `main` は `max-w-none` | 内部セクション側で `max-w-2xl` / `max-w-3xl` を使い分ける |
| `/vote`              | `max-w-2xl`            | 選択肢 5 つ、集中型レイアウト                             |
| `/aggregate`         | `max-w-2xl`            | 改ざん指示 UI、シンプル                                   |
| `/result`            | `max-w-2xl`            | 集計結果表示                                              |
| `/verify`            | **`max-w-4xl`**        | 検証カード群、タブ UI、情報量が多いため例外               |
| `/privacy`, `/terms` | `max-w-3xl`            | 法務ページは読み物レイアウトを優先                        |

---

## 3. コンポーネント仕様

### 3.1 Header

既存の Header コンポーネントを継続使用。変更なし。

```text
┌───────────────────────────────────────────────────────────────┐
│ STARK Ballot Simulator                                  [JA/EN] [やり直す] │
└───────────────────────────────────────────────────────────────┘
```

### 3.2 Step Indicator (Horizontal)

路線図スタイル（横型）:

```text
●━━━━━●━━━━━●━━━━━○━━━━━○
ホーム   投票    集計    結果    検証
```

**ナビゲーション機能**: 既存 Sidebar と同様、**完了済みステップはルート遷移リンク付き**。ユーザーは過去のステップに戻ることができる。

実装仕様:

```tsx
interface StepIndicatorHorizontalProps {
  currentStep?: number; // 未指定時は pathname から導出
  language?: 'ja' | 'en';
  className?: string;
  onReset?: () => void;
}

const steps = [
  { id: 'home', label: 'ホーム', labelEn: 'Home', path: '/' },
  { id: 'vote', label: '投票', labelEn: 'Vote', path: '/vote' },
  { id: 'aggregate', label: '集計', labelEn: 'Aggregate', path: '/aggregate' },
  { id: 'result', label: '結果', labelEn: 'Result', path: '/result' },
  { id: 'verify', label: '検証', labelEn: 'Verify', path: '/verify' },
];
```

> **補足**: 現在は `/verify/*` や `/result/*` のネストルートも `pathname` から現在ステップを解決する。完了済みの Home は単純リンクではなく、`onReset` が渡された場合のみ確認付きのリセットボタンになる。

**CSS 仕様**:

```css
.step-indicator-horizontal {
  position: sticky;
  top: var(--header-height);
  z-index: 40;
  background: var(--color-paper-warm);
  border-bottom: 1px solid var(--color-paper-border);
  padding: var(--space-3) var(--space-4);
}

.step-list {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  gap: 0;
  /* Note: /verify (max-w-4xl) でも step-list は max-w-2xl を維持。
     5ステップを一覧表示するには 2xl 幅で十分であり、
     コンテンツ幅と独立させることで視認性と一貫性を確保。 */
  max-width: var(--layout-content-max-width);
  margin: 0 auto;
}

.step-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
  flex: 1;
  max-width: 120px;
}

/* 接続線 */
.step-item:not(:last-child)::after {
  content: '';
  position: absolute;
  top: 14px;
  left: calc(50% + 14px);
  right: calc(-50% + 14px);
  height: 2px;
  background: var(--color-ink-300);
  z-index: 0;
}

.step-item.completed:not(:last-child)::after {
  background: var(--color-vermillion-500);
}

/* ステップドット */
.step-dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-caption);
  font-weight: var(--font-medium);
  z-index: 1;
  transition: all 200ms ease;
}

.step-dot.pending {
  background: var(--color-paper-cream);
  border: 2px solid var(--color-ink-300);
  color: var(--color-text-muted);
}

.step-dot.active {
  background: var(--color-ink-700);
  color: var(--color-paper-white);
  box-shadow: 0 0 0 4px var(--color-ink-100);
}

.step-dot.completed {
  background: var(--color-vermillion-500);
  color: var(--color-paper-white);
}

/* ステップラベル */
.step-label {
  margin-top: var(--space-2);
  font-family: var(--font-secondary);
  font-size: var(--text-caption);
  color: var(--color-text-muted);
  white-space: nowrap;
}

.step-item.active .step-label {
  color: var(--color-ink-900);
  font-weight: var(--font-medium);
}
```

**モバイル対応**: セクション 5.2「Step Indicator レスポンシブ」を参照。

### 3.3 Main Content Area

```css
.main-content {
  flex: 1;
  width: 100%;
  max-width: var(--layout-content-max-width);
  margin: 0 auto;
  padding: var(--space-8) var(--space-4);
}

@media (min-width: 1024px) {
  .main-content {
    padding: var(--space-8) var(--space-8);
  }
}
```

---

## 4. 知識パネル UI/UX (20項目対応)

### 4.1 課題

知識パネルは最終的に約20項目を表示する必要がある。単純なリスト表示では：

- スクロールが長くなりすぎる
- 重要な項目が埋もれる
- 現在のフェーズに関係ない項目がノイズになる

### 4.2 解決策: グループ化 + 折りたたみ（実装済み）

**基本方針**:

- 初期状態は**全グループ折りたたみ**
- フェーズ切替・新規追加・検証ステップで**自動展開しない**
- 新規追加は「ピコン」反応 + **緑丸**で通知（詳細は `knowledge-panel.md` の TO-BE に準拠）

```text
┌─────────────────────────────────────────────────┐
│  📜 私が知っている情報                           │
├─────────────────────────────────────────────────┤
│  ▸ セッション (3)   ● NEW                       │
│  ▸ 投票 (7)         ● NEW                       │
│  ▸ 結果 (1)                                   │
│  ▸ 公開情報 (10)                               │
└─────────────────────────────────────────────────┘
```

### 4.3 グループ定義（現行）

```typescript
type KnowledgeGroupId = 'session' | 'vote' | 'result' | 'public' | 'verify' | 'bot';

interface KnowledgeGroup {
  id: KnowledgeGroupId;
  labelJa: string;
  labelEn: string;
  keys: Array<keyof KnowledgeData>;
}

// public グループは src/lib/knowledge/visibility.ts の
// PUBLIC_KNOWLEDGE_KEYS をそのまま利用する。

const KNOWLEDGE_GROUPS: KnowledgeGroup[] = [
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
    keys: [
      'bot.id',
      'bot.choice',
      'bot.random',
      'bot.commitment',
      'bot.voteId',
      'bot.bulletinIndex',
      'bot.bulletinRootAtCast',
      'bot.voteTimestamp',
      'bot.merklePath',
      'bot.verification.steps',
    ],
  },
  {
    id: 'public',
    labelJa: '公開情報',
    labelEn: 'Public',
    keys: [...PUBLIC_KNOWLEDGE_KEYS],
  },
];

const HIDDEN_KEYS: Array<keyof KnowledgeData> = [
  'sessionId',
  'user.voteTimestamp',
  'scenarioId',
  'verification.steps',
  'verification.reportSummary',
  's3BundleUrl',
  's3BundleExpiresAt',
];
```

> **メモ**: `scenarioId` は API 送信用に保持するが、知識パネルには表示しない。`public` は現行実装でも最後尾の定義になっている。

### 4.4 表示フィルタ / 展開ロジック（現行）

```typescript
const ROUTE_GROUPS: Record<string, KnowledgeGroupId[]> = {
  '/vote': ['session', 'vote'],
  '/aggregate': ['session', 'vote'],
  '/result': ['session', 'vote', 'result', 'public'],
};

const VERIFY_MY_KEYS: Array<keyof KnowledgeData> = [
  'electionId',
  'user.choice',
  'user.random',
  'user.commitment',
  'user.voteId',
  'user.voteReceipt',
  'user.merklePath',
  ...PUBLIC_KNOWLEDGE_KEYS,
  'proofBundleStatus',
];

const VERIFY_BOT_KEYS: Array<keyof KnowledgeData> = [
  'bot.id',
  'bot.choice',
  'bot.random',
  'bot.commitment',
  'bot.voteId',
  'bot.bulletinIndex',
  'bot.bulletinRootAtCast',
  'bot.voteTimestamp',
  'bot.merklePath',
  'bot.verification.steps',
  ...PUBLIC_KNOWLEDGE_KEYS,
];

function getVisibleKeys(pathname: string, verifyTab?: 'my' | 'bot') {
  if (pathname === '/') return [];
  if (pathname === '/verify' || pathname.startsWith('/verify/')) {
    return verifyTab === 'bot' ? VERIFY_BOT_KEYS : VERIFY_MY_KEYS;
  }
  return (
    ROUTE_GROUPS[pathname]?.flatMap((id) => KNOWLEDGE_GROUPS.find((g) => g.id === id)?.keys ?? []) ??
    KNOWLEDGE_GROUPS.flatMap((group) => group.keys)
  );
}

interface KnowledgePanelState {
  expandedGroups: Set<KnowledgeGroupId>;
}

// すべて折りたたみが初期状態。自動展開は行わない。
function toggleGroup(id: KnowledgeGroupId, setExpandedGroups: Function) {
  setExpandedGroups((prev: Set<KnowledgeGroupId>) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}
```

### 4.5 ハイライト連動（現行）

検証ステップ表示時、対応する知識項目をハイライトする。現行実装では固定マップを手書きせず、`src/lib/verification/verification-checks.ts` の step inputs から既定値を導出し、API が step ごとの `inputs` を返した場合はそれを優先する。

```typescript
const DEFAULT_VERIFICATION_HIGHLIGHTS: Record<VerificationStepId, string[]> = {
  cast_as_intended: getVerificationStepInputs('cast_as_intended'),
  recorded_as_cast: getVerificationStepInputs('recorded_as_cast'),
  counted_as_recorded: getVerificationStepInputs('counted_as_recorded'),
  stark_verification: getVerificationStepInputs('stark_verification'),
};
```

**ハイライト時の挙動**:

1. 自動展開・自動スクロールは行わない
2. 表示中の項目のみ背景色を `--color-knowledge-highlight` に変更 (300ms fade)

### 4.6 コンパクトモード

項目数が多い場合、グループヘッダーのみ表示するコンパクトモード：

> **現状**: これは未実装の将来案。現行 UI には compact mode 切替は存在しない。

```text
┌─────────────────────────────────────────────────┐
│  📜 私が知っている情報            [展開] [縮小] │
├─────────────────────────────────────────────────┤
│  ✓ セッション (3)  ✓ 投票 (7)  □ 結果 (1)      │
│  □ 検証 (2)       □ ボット (0)  □ 公開情報 (10)│
└─────────────────────────────────────────────────┘
       ↓ クリックで展開
┌─────────────────────────────────────────────────┐
│  📜 私が知っている情報            [展開] [縮小] │
├─────────────────────────────────────────────────┤
│  ▼ 投票 (7)                                    │
│     user.choice: A                             │
│     ...                                        │
└─────────────────────────────────────────────────┘
```

### 4.7 モバイル: ボトムシート（実装済み）

```text
┌─────────────────────────────────────────┐
│                Main Content             │
│                                         │
│                                         │
├─────────────────────────────────────────┤
│ ━━━━━━ (drag handle)                   │
│  📜 私が知っている情報 (21項目)         │
│  ▼ セッション (3)                       │
│  ▼ 投票 (7)                            │
│  ▶ 結果 (1)                            │
│  ▶ 公開情報 (10)                       │
└─────────────────────────────────────────┘
```

**ボトムシート仕様**:

- 最小高さ: 60px (ヘッダーのみ)
- 中間高さ: 40vh (グループ一覧)
- 最大高さ: 80vh (全項目展開)
- ドラッグでスナップ
- Pointer Events + 状態管理で高さを制御する

---

## 5. レスポンシブ対応

### 5.1 ブレークポイント

| ブレークポイント | 幅         | Step Indicator         | Knowledge Panel               |
| ---------------- | ---------- | ---------------------- | ----------------------------- |
| Mobile           | < 640px    | ラベル縮小、ドット縮小 | ボトムシート（3段階スナップ） |
| Tablet           | 640-1023px | 標準表示               | 浮遊/ドッキングパネル         |
| Desktop          | ≥ 1024px   | 標準表示               | 浮遊/ドッキングパネル         |

### 5.2 Step Indicator レスポンシブ

```css
/* Mobile */
@media (max-width: 639px) {
  .step-indicator-horizontal {
    padding: var(--space-2) var(--space-2);
  }

  .step-list {
    gap: 0;
    justify-content: space-between;
    max-width: 100%;
  }

  .step-item {
    flex: 1;
    max-width: none;
    min-width: 0;
  }

  .step-dot {
    width: 24px;
    height: 24px;
    font-size: 0.75rem;
  }

  .step-label {
    font-size: 0.625rem; /* 10px */
    max-width: 56px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .step-item:not(:last-child)::after {
    top: 12px;
    left: calc(50% + 12px);
    right: calc(-50% + 12px);
    height: 1px;
  }
}
```

### 5.3 Knowledge Panel レスポンシブ（variant prop + ドッキング）

**API 設計**: レイアウト側が `variant` prop とドッキング制御を明示的に指定する。

```tsx
interface KnowledgePanelProps {
  filterKeys?: ReadonlyArray<keyof KnowledgeData>;
  /** 表示バリエーション (default: "inline", legacy) */
  variant?: 'floating' | 'bottomSheet' | 'inline';
  /** 浮遊/ドッキング状態 */
  dockState?: 'floating' | 'docked';
  /** 浮遊時の内部スクロール位置 */
  floatingScrollTop?: number;
  /** ドッキング復帰時に引き継ぐ展開状態 */
  defaultExpandedGroups?: Array<KnowledgeGroupDefinition['id']>;
  /** 浮遊時の内部スクロール位置の同期 */
  onFloatingScrollTopChange?: (scrollTop: number) => void;
  /** 展開状態の同期 */
  onExpandedGroupsChange?: (groupIds: Array<KnowledgeGroupDefinition['id']>) => void;
  className?: string;
}

// LayoutProvider.tsx での使用例
function LayoutProvider({ children }: Props) {
  const isMobile = useMediaQuery('(max-width: 639px)');
  const visibleKeys = getVisibleKeys(pathname, verifyTab);
  const showKnowledgePanel = pathname !== '/' && !isLegalRoute;
  const contentWidthClass = isVerifyRoute ? 'max-w-4xl' : 'max-w-2xl';
  const floatingBottomOffsetPx = 88;
  const [floatingScrollTop, setFloatingScrollTop] = useState(0);
  const [floatingExpandedGroups, setFloatingExpandedGroups] = useState<Array<KnowledgeGroupDefinition['id']>>([]);
  const { isDocked, isFloating, dockZoneRef, panelRef, floatingPanelHeight } = useDockingPanel({
    enabled: !isMobile,
    offsetPx: floatingBottomOffsetPx,
    minDockScrollPx: floatingBottomOffsetPx,
  });
  const spacerHeight = isFloating ? floatingPanelHeight + floatingBottomOffsetPx : isDocked ? floatingBottomOffsetPx : 0;

  return (
    <main>
      {children}

      {showKnowledgePanel && isMobile && <KnowledgePanel filterKeys={visibleKeys} variant="bottomSheet" />}

      {showKnowledgePanel && !isMobile && (
        <div className="mt-8">
          {isDocked && (
            <KnowledgePanel
              className="knowledge-docked"
              filterKeys={visibleKeys}
              variant="floating"
              dockState="docked"
              defaultExpandedGroups={floatingExpandedGroups}
            />
          )}
        </div>
      )}

      {showKnowledgePanel && !isMobile && spacerHeight > 0 && (
        <div aria-hidden style={{ height: `${spacerHeight}px` }} />
      )}
    </main>

    {showKnowledgePanel && !isMobile && isFloating && (
      <div ref={panelRef} className="knowledge-floating-container fixed inset-x-0">
        <div className={`w-full px-4 lg:px-8 ${contentWidthClass} mx-auto`}>
          <KnowledgePanel
            className="knowledge-floating"
            filterKeys={visibleKeys}
            variant="floating"
            dockState="floating"
            floatingScrollTop={floatingScrollTop}
            onFloatingScrollTopChange={setFloatingScrollTop}
            onExpandedGroupsChange={setFloatingExpandedGroups}
          />
        </div>
      </div>
    )}

    {showKnowledgePanel && !isMobile && <div ref={dockZoneRef} aria-hidden className="h-px w-full" />}
  );
}
```

> **設計意図**: レスポンシブ判定とドッキング制御は KnowledgePanel 内部ではなくレイアウト側で行う。これにより表示形態が明示的になり、テストや SSR でも挙動が予測しやすい。

> **補足**: `inline` は従来表示（LayoutProvider では未使用）。

---

## 6. 実装状況メモ

- `StepIndicatorHorizontal.tsx` は導入済みで、`LayoutProvider.tsx` が共通レイアウトから利用する
- `KnowledgePanel` は `variant="inline" | "floating" | "bottomSheet"` をサポートしている
- `useDockingPanel` により、デスクトップでは浮遊表示からドキュメントフローへのドッキングへ切り替わる
- モバイルでは固定アコーディオンではなく、3 段階スナップのボトムシートを使用する
- 残課題としては compact mode のような情報圧縮 UI が将来案として残っている

---

## 7. 主要構成ファイル

- `src/components/LayoutProvider.tsx` - シングルカラムの共通レイアウト、step bar、知識パネルの配置制御
- `src/components/step/StepIndicatorHorizontal.tsx` - 横型ステップナビ
- `src/components/knowledge/KnowledgePanel.tsx` - variant 対応、ボトムシート、浮遊/ドッキング連携
- `src/components/knowledge/KnowledgeGroup.tsx` - グループ化と折りたたみ UI
- `src/lib/hooks/useDockingPanel.ts` - デスクトップのドッキング判定

> **注記**: `Sidebar.tsx` 前提の旧構成はすでに廃止済み。

---

## 8. 設計原則

1. **フォーカス優先**: 現在のタスクに集中できるシングルカラム
2. **段階的開示**: 知識パネルはグループ化 + 折りたたみで情報過多を回避
3. **文脈適応**: フェーズに応じて表示対象をフィルタ（自動展開は行わない）
4. **ハイライト連動**: 検証ステップと知識項目の関係を視覚化
5. **モバイルファースト**: ボトムシートで自然なモバイル体験
