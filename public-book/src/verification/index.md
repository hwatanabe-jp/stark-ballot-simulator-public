# 検証パイプライン

投票の完全性を 4 段階に分けて検証するパイプラインを扱う部です。

## この部に含まれる章

- [設計と実行フロー](design-and-flow.md) — 設計原則、パイプライン構造、実行フロー
- [4 段階検証モデル](four-stage-model.md) — 検証の全体設計と各段階の保証
- [チェック一覧](checks-catalog.md) — 全検証チェック ID とその判定ロジック
- [バンドル構造](bundle-structure.md) — [証明バンドル](../appendix/glossary.md#証明バンドルproof-bundle)の公開可能・非公開アーティファクト
- [ゲーティングロジック](gating-logic.md) — 「Verified」表示の条件と不変条件

## 想定読者と前提

- 想定読者: `/verify` 画面の最終判定ロジックを把握したい監査者・実装者
- 前提: [暗号プロトコル](../protocol/index.md) と [zkVM 設計](../zkvm/index.md) の概要を読み終えていること

## 本章で扱わないもの

- `bundle.zip` のローカル監査手順（[第三者検証ガイド](../reproducibility/index.md) を参照）
- 改ざんシナリオごとの検出表（[改ざんシナリオ](../tamper/index.md) を参照）
- UI コンポーネントや Storybook 配置の詳細

## 関連する章

- [暗号プロトコル](../protocol/index.md) — チェック対象となるプリミティブ
- [zkVM 設計](../zkvm/index.md) — ジャーナルとレシートの構造
- [改ざんシナリオ](../tamper/index.md) — どのチェックがどの改ざんを検出するか
- [第三者検証ガイド](../reproducibility/index.md) — [`bundle.zip`](../appendix/glossary.md#配布対象アーカイブbundlezip) を使ったローカル監査
- [用語集](../appendix/glossary.md) — チェック種別・ゲーティング用語の定義

<!-- source: src/lib/verification/, src/server/api/handlers/verify.ts, src/server/api/handlers/verificationRun.ts, src/server/api/handlers/verificationBundles.ts, src/app/(routes)/verify/ -->
