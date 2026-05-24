# デザイン定義書: 「透明な信頼」(Transparent Trust)

> STARK Ballot Simulator UI リデザイン - 採用デザイン

---

## 1. デザインコンセプト

### 1.1 フィロソフィー

**「見える化」としての透明性**

日本の行政モダニズムと「見える化」の概念に着想を得たデザイン。暗号技術による検証を、美しく整理された公文書のように—精密で、権威があり、それでいてアクセシブルに表現する。

**コアメタファー: 透明性 = 信頼**

- 和紙のテクスチャ: 伝統と信頼性
- 印鑑（ハンコ）: 認証と承認の視覚的表現
- 活版印刷: 精密さと永続性

### 1.2 デザイン原則

1. **精緻な権威性** - 冷たい企業デザインではなく、よく設計された公共サービスの品格
2. **文化的共鳴** - 日本のユーザーが直感的に理解できる印鑑・書類のメタファー
3. **温かみのある精密さ** - 紙のテクスチャと暖色で冷たさを回避
4. **検証の儀式化** - 印鑑アニメーションで検証に意味と重みを付与
5. **ハッシュ値の書道化** - モノスペーステキストに墨の滲み効果

### 1.3 レイアウト参照先

レイアウト構造・ステップインジケーター・知識パネルの配置/レスポンシブは
`docs/current/ui-redesign/layout-architecture.md` を参照。
本ドキュメントは配色/タイポ/コンポーネントの視覚仕様に集中する。

---

## 2. カラーシステム

> **Note**: Tailwind CSS v4 では `--color-*` 名前空間でトークンを定義することで、`bg-ink-700`, `text-vermillion-500` 等のユーティリティクラスが自動生成される。
> 参考: [Tailwind CSS v4 Theme Variables](https://tailwindcss.com/docs/theme)

### 2.1 プライマリカラー（墨色 / Ink）

公式文書のインク、印鑑の色を想起させる深い藍色系。

```css
--color-ink-950: #0f1229; /* 最も深い墨 */
--color-ink-900: #1a1f4d; /* 見出し、重要テキスト */
--color-ink-800: #232a5e; /* ボタン押下時 */
--color-ink-700: #2d3875; /* プライマリボタン */
--color-ink-600: #3a4789; /* ホバー状態 */
--color-ink-500: #4a5399; /* セカンダリ要素 */
--color-ink-400: #6b74b3; /* アイコン */
--color-ink-300: #9ba3c9; /* ボーダー、区切り線 */
--color-ink-200: #c5cadf; /* 薄いボーダー */
--color-ink-100: #e8eaf3; /* 背景アクセント */
--color-ink-50: #f4f5fa; /* 最も薄い背景 */
```

### 2.2 アクセントカラー（朱色 / Vermillion）

印鑑の朱肉を想起。アクション、検証完了、重要な確認を示す。

```css
--color-vermillion-700: #a63232; /* 押下時 */
--color-vermillion-600: #c73d3d; /* 強調ボタン */
--color-vermillion-500: #e04848; /* 標準アクセント */
--color-vermillion-400: #e86b6b; /* ホバー */
--color-vermillion-300: #f09a9a; /* 薄いアクセント */
--color-vermillion-200: #f8c4c4; /* バッジ背景 */
--color-vermillion-100: #fce8e8; /* 通知背景 */
--color-vermillion-50: #fef5f5; /* 最も薄い背景 */
```

### 2.3 ニュートラルカラー（紙色 / Paper）

和紙の温かみを表現。純白ではなく、わずかにクリームがかった色調。

```css
--color-paper-white: #fffffe; /* 純白（限定使用）*/
--color-paper-warm: #faf9f7; /* メイン背景 */
--color-paper-cream: #f7f6f3; /* カード背景 */
--color-paper-cool: #f4f5f8; /* サイドバー背景 */
--color-paper-border: #e5e3df; /* 標準ボーダー */
--color-paper-border-dark: #d4d1cb; /* 強調ボーダー */

/* テキストカラー */
--color-text-primary: #1a1f4d; /* 本文 */
--color-text-secondary: #4a5399; /* 補足テキスト */
--color-text-muted: #7a7f9a; /* 薄いテキスト */
--color-text-disabled: #b0b3c5; /* 無効状態 */
```

### 2.4 セマンティックカラー

```css
/* 検証成功（落ち着いた青緑）*/
--color-verified-700: #1f5c50;
--color-verified-600: #2a7a6a;
--color-verified-500: #2d7d6f; /* 標準 */
--color-verified-100: #e0f2ed;
--color-verified-50: #f0faf7;

/* 警告（山吹色）*/
--color-warning-700: #8a6508;
--color-warning-600: #a67a0a;
--color-warning-500: #b8860b; /* 標準 */
--color-warning-100: #fef3d6;
--color-warning-50: #fffbeb;

/* エラー（深い赤）*/
--color-error-700: #7f2d2d;
--color-error-600: #963636;
--color-error-500: #a63d3d; /* 標準 */
--color-error-100: #fce8e8;
--color-error-50: #fef5f5;

/* 情報（薄い藍）*/
--color-info-600: #3a6b8a;
--color-info-500: #4a7fa3;
--color-info-100: #e3eff6;
--color-info-50: #f0f7fb;
```

### 2.5 知識パネル専用カラー

```css
--color-knowledge-bg: #fffef5; /* クリーム/羊皮紙 */
--color-knowledge-bg-alt: #fdfcf4; /* 代替背景 */
--color-knowledge-border: #d4c9a8; /* 古紙の縁 */
--color-knowledge-border-light: #e8e0c8; /* 薄いボーダー */
--color-knowledge-accent: #8b7355; /* 古墨色 */
--color-knowledge-highlight: #f5f0e0; /* ハイライト */
```

---

## 3. タイポグラフィ

### 3.1 フォントファミリー

```css
/* プライマリ：権威性と可読性 */
--font-primary: 'Noto Serif JP', 'Yu Mincho', serif;

/* セカンダリ：技術的精密さ
   Note: IBM Plex Sans JP は Google Fonts に存在しないため Noto Sans JP を使用 */
--font-secondary: 'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif;

/* モノスペース：暗号値 */
--font-mono: 'IBM Plex Mono', 'Source Code Pro', monospace;

/* ディスプレイ：特別な瞬間 */
--font-display: 'Shippori Mincho', 'Noto Serif JP', serif;
```

### 3.2 フォントスケール

```css
/* ディスプレイ（ページタイトル）*/
--text-display: 2.5rem; /* 40px */
--leading-display: 1.2;
--tracking-display: -0.02em;

/* 見出し1（セクションタイトル）*/
--text-h1: 1.875rem; /* 30px */
--leading-h1: 1.25;
--tracking-h1: -0.01em;

/* 見出し2（カードタイトル）*/
--text-h2: 1.5rem; /* 24px */
--leading-h2: 1.3;

/* 見出し3（サブセクション）*/
--text-h3: 1.25rem; /* 20px */
--leading-h3: 1.4;

/* 本文 */
--text-body: 1rem; /* 16px */
--leading-body: 1.7;

/* 小テキスト */
--text-small: 0.875rem; /* 14px */
--leading-small: 1.5;

/* キャプション */
--text-caption: 0.8125rem; /* 13px */
--leading-caption: 1.5;

/* モノスペース（ハッシュ値）*/
--text-mono: 0.8125rem; /* 13px */
--leading-mono: 1.6;
--tracking-mono: 0.02em;
```

### 3.3 フォントウェイト

```css
--font-normal: 400;
--font-medium: 500;
--font-semibold: 600;
--font-bold: 700;
```

### 3.4 使用ガイドライン

| 要素             | フォント  | サイズ  | ウェイト |
| ---------------- | --------- | ------- | -------- |
| ページタイトル   | Display   | display | bold     |
| セクション見出し | Primary   | h1      | semibold |
| カード見出し     | Primary   | h2      | medium   |
| 本文             | Secondary | body    | normal   |
| ラベル           | Secondary | small   | medium   |
| ハッシュ値       | Mono      | mono    | normal   |
| ボタン           | Secondary | small   | medium   |
| 検証結果         | Primary   | h3      | semibold |

---

## 4. スペーシングシステム

### 4.1 ベーススケール（8px基準）

```css
--space-0: 0;
--space-1: 0.25rem; /* 4px */
--space-2: 0.5rem; /* 8px */
--space-3: 0.75rem; /* 12px */
--space-4: 1rem; /* 16px */
--space-5: 1.25rem; /* 20px */
--space-6: 1.5rem; /* 24px */
--space-8: 2rem; /* 32px */
--space-10: 2.5rem; /* 40px */
--space-12: 3rem; /* 48px */
--space-16: 4rem; /* 64px */
--space-20: 5rem; /* 80px */
```

### 4.2 コンポーネントスペーシング

```css
/* カード内パディング */
--card-padding: var(--space-6);
--card-padding-sm: var(--space-4);

/* セクション間マージン */
--section-gap: var(--space-10);

/* 要素間ギャップ */
--element-gap: var(--space-4);
--element-gap-sm: var(--space-2);

/* インライン要素間 */
--inline-gap: var(--space-2);
```

---

## 5. ボーダーと角丸

### 5.1 角丸（Border Radius）

```css
--radius-none: 0;
--radius-sm: 0.25rem; /* 4px - 小さい要素 */
--radius-md: 0.5rem; /* 8px - ボタン、入力 */
--radius-lg: 0.75rem; /* 12px - カード */
--radius-xl: 1rem; /* 16px - モーダル */
--radius-full: 9999px; /* 円形 */
```

### 5.2 ボーダー

```css
--border-width: 1px;
--border-width-2: 2px;

/* ボーダースタイル */
--border-default: var(--border-width) solid var(--color-paper-border);
--border-strong: var(--border-width) solid var(--color-paper-border-dark);
--border-ink: var(--border-width) solid var(--color-ink-300);
--border-accent: var(--border-width-2) solid var(--color-vermillion-500);
```

---

## 6. シャドウ

```css
/* 控えめなシャドウ（活版印刷の押し跡を想起）*/
--shadow-sm: 0 1px 2px rgba(26, 31, 77, 0.04);
--shadow-md: 0 2px 4px rgba(26, 31, 77, 0.06), 0 1px 2px rgba(26, 31, 77, 0.04);
--shadow-lg: 0 4px 8px rgba(26, 31, 77, 0.08), 0 2px 4px rgba(26, 31, 77, 0.04);

/* インセットシャドウ（凹み効果）*/
--shadow-inset: inset 0 1px 2px rgba(26, 31, 77, 0.08);
--shadow-inset-deep: inset 0 2px 4px rgba(26, 31, 77, 0.12);

/* 印鑑押下効果 */
--shadow-stamp: 0 0 0 2px var(--color-vermillion-500), 0 2px 8px rgba(199, 61, 61, 0.25);
```

---

## 7. コンポーネント仕様

### 7.1 ボタン

#### プライマリボタン

```css
.btn-primary {
  background: var(--color-ink-700);
  color: var(--color-paper-white);
  font-family: var(--font-secondary);
  font-size: var(--text-small);
  font-weight: var(--font-medium);
  padding: var(--space-3) var(--space-6);
  border-radius: var(--radius-md);
  border: none;
  box-shadow: var(--shadow-inset);
  transition: all 150ms ease;
}

.btn-primary:hover {
  background: var(--color-ink-600);
  box-shadow: var(--shadow-md);
}

.btn-primary:active {
  background: var(--color-ink-800);
  box-shadow: var(--shadow-inset-deep);
}

.btn-primary:disabled {
  background: var(--color-ink-300);
  cursor: not-allowed;
}
```

#### セカンダリボタン

```css
.btn-secondary {
  background: var(--color-paper-cream);
  color: var(--color-ink-700);
  border: var(--border-ink);
  box-shadow: var(--shadow-sm);
}

.btn-secondary:hover {
  background: var(--color-ink-50);
  border-color: var(--color-ink-500);
}
```

#### 検証導線ボタン（印鑑スタイル）

```css
.btn-verify {
  background: var(--color-vermillion-600);
  color: var(--color-paper-white);
  border-radius: var(--radius-md);
  position: relative;
  overflow: hidden;
}

/* 印鑑テクスチャオーバーレイ */
.btn-verify::before {
  content: '';
  position: absolute;
  inset: 0;
  background: url('/textures/stamp-texture.png');
  opacity: 0.1;
  mix-blend-mode: overlay;
}

.btn-verify:hover {
  background: var(--color-vermillion-500);
}

.btn-verify:active {
  transform: scale(0.98);
  box-shadow: var(--shadow-stamp);
}
```

### 7.2 カード

#### 基本カード

> **Note**: 紙テクスチャは `background` の複数レイヤーで実装し、`::before`/`::after` を装飾用に解放する。

```css
.card {
  /* 紙テクスチャ + 背景色を background layers で実装 */
  background: url('/textures/paper-noise.png'), var(--color-paper-cream);
  background-blend-mode: overlay, normal;
  border: var(--border-default);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
  position: relative;
}

/* ::before は装飾用に解放（印鑑等で使用可能）*/

/* 下部アクセントライン */
.card::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: var(--space-6);
  right: var(--space-6);
  height: 2px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    var(--color-ink-200) 20%,
    var(--color-ink-200) 80%,
    transparent 100%
  );
}
```

#### 検証カード（印鑑コーナー装飾付き）

```css
.card-verification {
  /* 基本カードを継承 */
}

/* 右上の印鑑装飾（::before が解放されているため競合なし）*/
.card-verification.verified::before {
  content: '✓';
  position: absolute;
  top: var(--space-4);
  right: var(--space-4);
  width: 32px;
  height: 32px;
  background: var(--color-vermillion-500);
  color: var(--color-paper-white);
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  transform: rotate(-5deg);
  box-shadow: var(--shadow-md);
}
```

### 7.3 入力フォーム

#### ラジオグループ（投票選択）

> **Note**: 選択時のボーダー強調は `box-shadow` で実装し、`border-width` 変更によるレイアウトシフトを回避する。

```css
.radio-option {
  background: var(--color-paper-warm);
  border: 1px solid var(--color-paper-border);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  cursor: pointer;
  transition: all 150ms ease;
}

.radio-option:hover {
  border-color: var(--color-ink-400);
  background: var(--color-ink-50);
}

.radio-option.selected {
  border-color: var(--color-ink-600);
  background: var(--color-ink-50);
  /* 追加の1pxを box-shadow で表現（レイアウトシフトなし）*/
  box-shadow:
    0 0 0 1px var(--color-ink-600),
    var(--shadow-sm);
}

/* ラジオインジケーター */
.radio-indicator {
  width: 20px;
  height: 20px;
  border: 2px solid var(--color-ink-400);
  border-radius: var(--radius-full);
  position: relative;
}

.radio-option.selected .radio-indicator::after {
  content: '';
  position: absolute;
  inset: 4px;
  background: var(--color-ink-600);
  border-radius: var(--radius-full);
}
```

### 7.4 プログレスインジケーター

> **Note**: ステップインジケーターの構造/配置は `docs/current/ui-redesign/layout-architecture.md` を参照。

#### 集計進捗バー

```css
.progress-bar {
  height: 8px;
  background: var(--color-paper-border);
  border-radius: var(--radius-full);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--color-ink-600) 0%, var(--color-ink-500) 100%);
  border-radius: var(--radius-full);
  transition: width 300ms ease-out;
}

/* 進捗テキスト */
.progress-text {
  font-family: var(--font-mono);
  font-size: var(--text-mono);
  color: var(--color-text-secondary);
}
```

### 7.5 知識パネル

> **Note**: キー名は `docs/current/ui-redesign/knowledge-panel.md` / `docs/current/guides/6-zkvm_design/final_design.md` を正とし、alias は使用しない。`proofBundleStatus` など UI 生成情報は API 契約に含めない。

```css
.knowledge-panel {
  background: var(--color-knowledge-bg);
  border: 1px solid var(--color-knowledge-border);
  border-radius: var(--radius-lg);
  padding: var(--space-5);
  position: relative;
}

/* 左ボーダー装飾（紗綾形パターン）*/
.knowledge-panel::before {
  content: '';
  position: absolute;
  left: 0;
  top: var(--space-4);
  bottom: var(--space-4);
  width: 4px;
  background: url('/patterns/sayagata.svg') repeat-y;
  background-size: 4px auto;
  opacity: 0.4;
}

/* パネルタイトル: 7.5.3 を参照 */

/* 知識アイテム */
.knowledge-item {
  position: relative; /* NEW ドット配置用 */
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px dashed var(--color-knowledge-border-light);
}

.knowledge-item:last-child {
  border-bottom: none;
}

.knowledge-label {
  font-family: var(--font-secondary);
  font-size: var(--text-caption);
  color: var(--color-text-secondary);
}

.knowledge-value {
  font-family: var(--font-mono);
  font-size: var(--text-mono);
  color: var(--color-text-primary);
}

/* ハッシュ値の省略表示 */
.knowledge-hash {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 新規追加アニメーション（墨の滲み）*/
@keyframes ink-spread {
  0% {
    opacity: 0;
    filter: blur(4px);
    transform: translateY(-4px);
  }
  100% {
    opacity: 1;
    filter: blur(0);
    transform: translateY(0);
  }
}

.knowledge-item.new {
  animation: ink-spread 400ms ease-out;
}
```

> **役割分担**: 「ピコン＋緑ドット」は**新規到達の通知**、`ink-spread` は**ユーザーが展開して初めて目にした瞬間の発見演出**として使い分ける。

### 7.5.1 グループヘッダー

グループの折りたたみ/展開を制御するヘッダー部分。新規項目追加時の通知表示を含む。

```css
/* グループヘッダー */
.knowledge-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2) var(--space-3);
  background: var(--color-knowledge-bg-alt);
  border-bottom: 1px solid var(--color-knowledge-border-light);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.knowledge-group-header:hover {
  background: var(--color-knowledge-highlight);
}

/* グループラベル */
.knowledge-group-label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-secondary);
  font-size: var(--text-caption);
}

.knowledge-group-label.current {
  color: var(--color-ink-900);
  font-weight: var(--font-medium);
}

.knowledge-group-label.inactive {
  color: var(--color-text-muted);
}

/* 展開/折りたたみアイコン */
.knowledge-group-arrow {
  font-size: var(--text-caption);
  color: var(--color-text-secondary);
  transition: transform var(--transition-fast);
}

.knowledge-group-arrow.expanded {
  transform: rotate(90deg);
}

/* グループ件数 */
.knowledge-group-count {
  font-family: var(--font-secondary);
  font-size: 0.75rem; /* 12px */
  color: var(--color-text-muted);
}
```

### 7.5.2 NEW インジケーター（緑系ドット）

新規追加項目を示す視覚的マーカー。`verified` カラーパレットを使用し、「信頼できる新情報」のメタファーを表現。

> **設計意図**: 朱色（vermillion）は検証完了/印鑑のメタファーに専用。新規項目は青緑（verified）で「未開封の手紙」「新鮮な墨」のニュアンスを表現。

```css
/* グループヘッダーの NEW ドット（ピコン後に表示） */
.knowledge-new-indicator {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-verified-500);
  box-shadow: 0 0 4px var(--color-verified-400);
  flex-shrink: 0;
}

/* アイテムレベルの NEW ドット（展開時に表示） */
.knowledge-item-new-dot {
  position: absolute;
  left: var(--space-1);
  top: 50%;
  transform: translateY(-50%);
  width: 4px;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--color-verified-500);
}

/* NEW ドットのフェードアウト */
.knowledge-new-indicator.fading,
.knowledge-item-new-dot.fading {
  animation: new-dot-fade 500ms ease-out forwards;
  animation-delay: 1500ms; /* 2秒間表示後にフェード開始 */
}
```

### 7.5.3 パネルタイトル切替（私 / ボット）

知識パネルのタイトルは、表示コンテキストに応じて「私が知っている情報」と「ボットが知っている情報」を切り替える。

> **単一タイトル時**: 切替が不要でも wrapper を使用し、`.my-knowledge.active` のみ付与する。

```css
/* パネルタイトルのラッパー */
.knowledge-panel-title-wrapper {
  position: relative;
  height: 1.5em;
  overflow: hidden;
  margin-bottom: var(--space-4);
  padding-left: var(--space-3);
}

/* 基本タイトルスタイル */
.knowledge-panel-title {
  position: absolute;
  inset: 0;
  font-family: var(--font-primary);
  font-size: var(--text-small);
  font-weight: var(--font-semibold);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  transition:
    opacity var(--transition-base),
    transform var(--transition-base);
}

/* 「私が知っている情報」タイトル */
.knowledge-panel-title.my-knowledge {
  color: var(--color-knowledge-accent);
}

/* 「ボットが知っている情報」タイトル */
.knowledge-panel-title.bot-knowledge {
  color: var(--color-ink-600);
}

/* アクティブ状態 */
.knowledge-panel-title.active {
  opacity: 1;
  transform: translateY(0);
}

/* 非アクティブ状態（退出） */
.knowledge-panel-title.inactive {
  opacity: 0;
  transform: translateY(-8px);
}

/* アイコン（Lucide React 推奨） */
.knowledge-panel-title-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
```

**実装例（Lucide React）:**

```tsx
import { Scroll, Bot } from 'lucide-react';

// 「私が知っている情報」
<Scroll className="knowledge-panel-title-icon" aria-hidden="true" />

// 「ボットが知っている情報」
<Bot className="knowledge-panel-title-icon" aria-hidden="true" />
```

### 7.5.4 グループ展開/折りたたみ

初期状態は全グループ折りたたみ。自動展開は行わない（ユーザー意思を尊重）。

> **設計意図**: 巻物を開く動作のメタファー。ユーザーが能動的に情報を確認することで、学習効果と理解度を高める。

```css
/* グループコンテンツ（折りたたみ対象） */
.knowledge-group-content {
  overflow: hidden;
  transition: max-height var(--transition-slow);
}

.knowledge-group-content.collapsed {
  max-height: 0;
}

.knowledge-group-content.expanded {
  max-height: 1000px; /* 十分な高さ */
}

/* スムーズな展開のための inner wrapper */
.knowledge-group-content-inner {
  padding: var(--space-1) 0;
}
```

### 7.6 バッジ / ステータス表示

```css
/* 基本バッジ */
.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-full);
  font-family: var(--font-secondary);
  font-size: var(--text-caption);
  font-weight: var(--font-medium);
}

.badge-verified {
  background: var(--color-verified-100);
  color: var(--color-verified-700);
  border: 1px solid var(--color-verified-500);
}

.badge-warning {
  background: var(--color-warning-100);
  color: var(--color-warning-700);
  border: 1px solid var(--color-warning-500);
}

.badge-error {
  background: var(--color-error-100);
  color: var(--color-error-700);
  border: 1px solid var(--color-error-500);
}

/* 印鑑スタイルバッジ（検証完了）*/
.badge-stamp {
  background: var(--color-vermillion-100);
  color: var(--color-vermillion-700);
  border: 2px solid var(--color-vermillion-500);
  border-radius: var(--radius-md);
  transform: rotate(-2deg);
  font-weight: var(--font-semibold);
}
```

---

## 8. アニメーション

### 8.1 基本トランジション

```css
--transition-fast: 150ms ease;
--transition-base: 200ms ease;
--transition-slow: 300ms ease;
--transition-slower: 500ms ease;
```

### 8.2 印鑑押下アニメーション

ステップ完了時、検証成功時に使用。

```css
@keyframes stamp-press {
  0% {
    transform: scale(1.5) rotate(-10deg);
    opacity: 0;
  }
  50% {
    transform: scale(0.95) rotate(-3deg);
    opacity: 1;
  }
  70% {
    transform: scale(1.02) rotate(-5deg);
  }
  100% {
    transform: scale(1) rotate(-5deg);
  }
}

.stamp-animation {
  animation: stamp-press 400ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
```

### 8.3 チェックマーク描画アニメーション

検証成功時のアイコン。

```css
@keyframes draw-check {
  0% {
    stroke-dashoffset: 24;
  }
  100% {
    stroke-dashoffset: 0;
  }
}

.check-icon path {
  stroke-dasharray: 24;
  stroke-dashoffset: 24;
  animation: draw-check 300ms ease-out forwards;
  animation-delay: 200ms;
}
```

### 8.4 ステップ進行アニメーション

```css
@keyframes step-complete {
  0% {
    background: var(--color-ink-700);
  }
  50% {
    transform: scale(1.1);
    background: var(--color-vermillion-400);
  }
  100% {
    transform: scale(1);
    background: var(--color-vermillion-500);
  }
}
```

### 8.5 プログレス非線形補間

集計進行中の進捗バー用。

> **Note**: 100% への遷移は時間ベースではなく、ECS Fargate 完了コールバック受信時に `completeProgress()` で設定する設計。入力値は `queuedAt` / `startedAt` / `estimatedDurationMs`（API 由来）で、`progress.percent` は参照値に留める。

```typescript
const PHASE1_END_RATIO = 168 / 360; // ≈ 0.467
const PHASE2_END_RATIO = 248 / 360; // ≈ 0.689

// 進捗値の補間関数（時間ベース、0-99%）
function interpolateProgress(elapsed: number, total: number = 360000): number {
  // クランプ: 0-1の範囲に制限
  const ratio = Math.min(1, Math.max(0, elapsed / total));

  if (ratio < 1) {
    if (ratio <= PHASE1_END_RATIO) {
      // 序盤区間 (0-70%): 線形進行
      return (ratio / PHASE1_END_RATIO) * 70;
    } else if (ratio <= PHASE2_END_RATIO) {
      // 中盤区間 (70-90%): 線形減速
      const segment = (ratio - PHASE1_END_RATIO) / (PHASE2_END_RATIO - PHASE1_END_RATIO);
      return 70 + linearDeceleration(segment) * 20;
    } else {
      // 終盤区間 (90-99%): 等速度（線形）
      const segment = (ratio - PHASE2_END_RATIO) / (1 - PHASE2_END_RATIO);
      return 90 + segment * 9;
    }
  }
  // ratio === 1 の場合は99%を返す（100%は完了イベントで設定）
  return 99;
}

// 中盤区間の線形減速（速度が徐々に落ちる）
function linearDeceleration(t: number): number {
  const k = 0.808;
  return (t * (2 - k * t)) / (2 - k);
}

// 完了時に呼び出す関数（ECS Fargate完了コールバック受信時）
function completeProgress(): number {
  return 100;
}
```

### 8.6 ピコン通知アニメーション

グループに新規項目が追加された瞬間のフィードバック。墨汁が落ちて波紋が広がるイメージ。

> **役割分担**: ピコン通知は**新規到達の即時通知**、`ink-spread` は**展開時に初めて見える項目の発見演出**。

```css
@keyframes group-notify {
  0% {
    background-color: var(--color-knowledge-bg-alt);
  }
  20% {
    background-color: var(--color-verified-100);
    box-shadow: inset 0 0 0 1px var(--color-verified-300);
  }
  100% {
    background-color: var(--color-knowledge-bg-alt);
    box-shadow: none;
  }
}

.knowledge-group-header.notify {
  animation: group-notify 600ms ease-out;
}
```

### 8.7 NEW ドットフェードアウト

新規項目インジケーターのフェードアウト。2秒間表示後に消える。

> 定義は **7.5.2 NEW インジケーター（緑系ドット）** を参照。

### 8.8 スケルトンシマー（和紙シマーローダー）

検証準備中（2秒間）の表示に使用。和紙の繊維が光を反射するような温かみのあるシマー効果。

```css
@keyframes skeleton-shimmer {
  0% {
    background-position: -200% 0;
  }
  100% {
    background-position: 200% 0;
  }
}

.animate-skeleton-shimmer {
  background: linear-gradient(
    90deg,
    var(--color-paper-cream) 0%,
    var(--color-paper-warm) 20%,
    var(--color-ink-100) 40%,
    var(--color-paper-warm) 60%,
    var(--color-paper-cream) 100%
  );
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s ease-in-out infinite;
}
```

### 8.9 知識パネル連動ハイライト

検証小項目クリック時に対応する知識キーをハイライト。印鑑を押した瞬間の朱肉の広がり → 徐々に落ち着く（2.5秒フェードアウト）。

```css
@keyframes knowledge-highlight-pulse {
  0% {
    box-shadow:
      0 0 0 0 var(--color-vermillion-300),
      inset 0 0 0 2px var(--color-vermillion-400);
    background-color: var(--color-vermillion-100);
  }
  20% {
    box-shadow:
      0 0 0 4px var(--color-vermillion-200),
      inset 0 0 0 2px var(--color-vermillion-400);
  }
  40% {
    box-shadow:
      0 0 0 6px transparent,
      inset 0 0 0 2px var(--color-vermillion-300);
  }
  100% {
    box-shadow:
      0 0 0 0 transparent,
      inset 0 0 0 0 transparent;
    background-color: var(--color-knowledge-highlight);
  }
}

.animate-knowledge-highlight-pulse {
  animation: knowledge-highlight-pulse 2.5s ease-out forwards;
}
```

### 8.10 小項目カスケード出現

検証ステップ詳細の小項目が上から順に出現。筆で書き下ろすような流れ。

```css
@keyframes detail-cascade-in {
  0% {
    opacity: 0;
    transform: translateX(-8px);
    filter: blur(2px);
  }
  100% {
    opacity: 1;
    transform: translateX(0);
    filter: blur(0);
  }
}

.animate-detail-cascade-in {
  animation: detail-cascade-in 0.3s ease-out both;
}

/* カスケード遅延: 各項目 80ms ずらし */
.animate-detail-cascade-in:nth-child(n) {
  animation-delay: calc((n - 1) * 80ms);
}
```

### 8.11 ステータスアイコン変形

小項目のステータス変化時のアイコンアニメーション。印鑑の押下感を小さなアイコンで表現。

```css
@keyframes status-icon-morph {
  0% {
    transform: scale(1);
  }
  30% {
    transform: scale(0.7);
  }
  60% {
    transform: scale(1.15);
  }
  100% {
    transform: scale(1);
  }
}

.animate-status-icon-morph {
  animation: status-icon-morph 0.25s ease-out;
}
```

### 8.12 小項目ステータス遷移

検証ステップ詳細の小項目が状態変化する際のトランジション（0.2秒）。墨が紙に染み込むような滑らかな変化。

```css
.verification-detail-item {
  transition:
    background-color var(--transition-base),
    border-color var(--transition-base),
    box-shadow var(--transition-base);
  border-left: 3px solid transparent;
}

/* pending: 未処理 */
.verification-detail-item[data-status='pending'] {
  background-color: transparent;
  border-left-color: var(--color-paper-border);
}

/* running: 墨汁が動き出す */
.verification-detail-item[data-status='running'] {
  background-color: var(--color-ink-50);
  border-left-color: var(--color-ink-500);
  box-shadow: inset 2px 0 8px -4px var(--color-ink-300);
}

/* success: 朱肉の押印 */
.verification-detail-item[data-status='success'] {
  background-color: var(--color-verified-50);
  border-left-color: var(--color-verified-500);
}

/* failed: 朱墨の警告 */
.verification-detail-item[data-status='failed'] {
  background-color: var(--color-error-50);
  border-left-color: var(--color-error-500);
}
```

---

## 9. レイアウトシステム（移管）

レイアウト構造・グローバル配置・レスポンシブ方針は
`docs/current/ui-redesign/layout-architecture.md` に移管済み。
本ドキュメントではレイアウト詳細を扱わない。

---

## 10. ページ別デザインガイド

### 10.1 トップページ (/)

- 中央配置のウェルカムメッセージ
- 大きなCTAボタン（印鑑押下スタイル）
- 背景に薄い和紙テクスチャ
- 簡潔な説明文（Noto Serif JP）

### 10.2 投票ページ (/vote)

- ラジオグループで選択肢A〜Eを表示
- 選択肢は縦並びカードスタイル
- 選択時に墨色ボーダーでハイライト
- 知識パネルに選択情報が即時反映（アニメーション付き）
- Turnstile は控えめなスタイリング

### 10.3 ボット投票 (/vote#waiting)

- 10秒の視覚的アニメーション
- 選択肢別の棒グラフ（境界はグラデーションで曖昧に）
- 進捗テキストは「処理中...」のみ（具体的数値なし）
- 知識パネルには「63 bot votes (pending)」を表示

### 10.4 改ざん指示 (/aggregate)

- S1〜S5の記号を使わない日本語ラベル
- 単一選択のラジオグループ
- 「改ざんしない」がデフォルト選択肢
- 選択状態で次へ進むボタンが有効化
- 改ざんシナリオの注記（S2/S4の原理的な不可能性など）はUIに表示せず、外部ドキュメント（`<PUBLIC_SPECS_ORIGIN>`）に集約して記載する予定

### 10.5 結果ページ (/result) - 新設

- 集計結果のみを表示
- 投票結果はA〜Eのコンパクトグリッド（票数・割合・下線バー）
- 勝者のハイライトは行わない（全て同列に表示）
- 検証への導線ボタン
- 知識パネルに最終集計値を追加

### 10.6 検証ページ (/verify)

- 検証ページ到達時に自動で順次表示開始（準備中表示→ステップ表示）
- 各検証ステップがカードとして順番にスライドイン
- ステップ完了時に印鑑アニメーション
- STARK検証は最後（4秒のローディング表示）
- 知識パネルと検証ステップの関連を視覚化（ハイライト連動）
- ダウンロードカードは「未ダウンロード」ラベル付き

### 10.7 ボット検証（/verify タブ切替）

- タブUIで「私の検証」「ボット検証」を切替
- 影響を受けたボット（1体）をテーブル表示
- 各ボットをクリックで詳細モーダル
- モーダル内に当該ボットの知識パネルを表示

---

## 11. アセット要件

### 11.1 テクスチャ

| ファイル                      | 用途           | 不透明度 |
| ----------------------------- | -------------- | -------- |
| `/textures/paper-noise.png`   | 紙のノイズ     | 2-3%     |
| `/textures/stamp-texture.png` | 印鑑テクスチャ | 10%      |

### 11.2 パターン

| ファイル                 | 用途                                   |
| ------------------------ | -------------------------------------- |
| `/patterns/sayagata.svg` | 紗綾形パターン（知識パネル左ボーダー） |

### 11.3 アイコン

**推奨ライブラリ**: [Lucide React](https://lucide.dev/) (`lucide-react`)

Tree-shakeable で `currentColor` 対応済み。以下のアイコンを使用する。

| Lucide アイコン | 用途                         | 備考                      |
| --------------- | ---------------------------- | ------------------------- |
| `Scroll`        | 知識パネルタイトル（私）     | 巻物アイコン              |
| `Bot`           | 知識パネルタイトル（ボット） | ボットアイコン            |
| `Check`         | チェックマーク               | SVGパスアニメーション対応 |
| `AlertTriangle` | 警告三角                     | -                         |
| `Info`          | 情報アイコン                 | -                         |
| `Download`      | ダウンロードアイコン         | -                         |
| `Languages`     | 言語切替アイコン             | -                         |
| `ChevronRight`  | グループ展開/折りたたみ      | 回転で開閉状態を表現      |

> **導入済み**: `lucide-react` は `package.json` に追加済み。

---

## 12. アクセシビリティ

### 12.1 カラーコントラスト

すべてのテキスト/背景組み合わせでWCAG AA基準（4.5:1以上）を満たす。

| テキスト         | 背景         | コントラスト比 | ステータス                        |
| ---------------- | ------------ | -------------- | --------------------------------- |
| ink-900          | paper-warm   | 12.5:1         | ✓ 検証済                          |
| ink-700          | paper-cream  | 8.2:1          | ✓ 検証済                          |
| text-secondary   | paper-warm   | 5.8:1          | ✓ 検証済                          |
| vermillion-600   | paper-white  | 5.1:1          | ✓ 検証済                          |
| text-muted       | paper-cream  | 4.8:1          | ✓ 検証済 (色値を #686d8a に調整)  |
| text-muted       | paper-warm   | 4.6:1          | ✓ 検証済 (色値を #686d8a に調整)  |
| knowledge-accent | knowledge-bg | 5.2:1          | ✓ 検証済 (色値を #7a6448 に調整)  |
| ink-400 (icon)   | paper-warm   | 4.5:1          | ✓ 検証済 (3:1以上でアイコン対応)  |
| text-disabled    | paper-cream  | 2.0:1          | ✓ 免除 (disabled状態はWCAG対象外) |

> **完了**: 2026-01-10 全組み合わせのコントラスト検証完了。WCAG AA基準を満たさない色は `globals.css` で調整済み。

### 12.2 フォーカス表示

```css
:focus-visible {
  outline: 2px solid var(--color-ink-500);
  outline-offset: 2px;
}
```

### 12.3 ARIA属性

| 要素                  | 属性                                              |
| --------------------- | ------------------------------------------------- |
| 進捗バー              | `aria-valuenow`, `aria-valuemin`, `aria-valuemax` |
| ステップナビ          | `aria-current="step"`                             |
| 知識パネル            | `aria-live="polite"`                              |
| エラー/成功メッセージ | `role="alert"`                                    |

---

## 13. 実装対象

### 基盤

1. カラー変数とタイポグラフィの定義
2. 基本コンポーネント（Button, Card, Badge）
3. グローバルレイアウト構造

### コアUI

4. ステップナビゲーション
5. 知識パネル
6. 投票フォーム（RadioGroup）

### フロー実装

7. ボット投票アニメーション
8. 改ざん指示UI
9. 進捗表示（非線形補間）

### 検証UI

10. 検証カード群
11. 印鑑アニメーション
12. ボット検証タブ

### 仕上げ

13. テクスチャ/パターン適用
14. アニメーション調整
15. アクセシビリティ検証

---

## 14. 変更対象ファイル

### 新規作成

- `src/app/globals.css` - カラー/タイポグラフィ変数の全面改訂
- `src/components/KnowledgePanel/` - 知識パネルコンポーネント群
- `src/app/(routes)/result/page.tsx` - 結果ページ（新設）
- `public/textures/` - テクスチャアセット
- `public/patterns/` - パターンアセット

### 大幅変更

- `src/components/ui/Button.tsx`
- `src/components/ui/Badge.tsx`
- `src/components/ui/RadioGroup.tsx`
- `src/components/ui/ProgressBar.tsx`
- `src/components/sidebar/Sidebar.tsx`
- `src/components/LayoutProvider.tsx`
- `src/app/(routes)/vote/page.tsx`
- `src/app/(routes)/aggregate/page.tsx`
- `src/app/(routes)/verify/page.tsx`
- `src/components/vote/WaitingProgress.tsx`
- `src/components/verification/*`
