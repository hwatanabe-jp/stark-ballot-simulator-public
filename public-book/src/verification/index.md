# 検証パイプライン

この部では、投票の完全性を 4 段階に分けて検証するパイプラインを扱います。

この部の前提となる原則は次の 4 点です。

- 最終的な Verified 判定は fail-closed で、required check が失敗、未実行、保留中、実行中のまま残る場合は successful overall result になりません。`verificationStatus` や `stark_receipt_verify` は STARK receipt verification の信号にすぎず、単独で overall verdict を表しません（[ゲーティングロジック](gating-logic.md)）。
- 判定確定後に送る `POST /api/verification/observation` は observability 専用で、送信の成否が verdict を変更することはありません（[設計と実行フロー](design-and-flow.md)）。
- public `bundle.zip` は保護対象 artifact を含まない監査用アーカイブで、`public` は無認証公開を意味しません（境界の正本は [公開境界](public-boundary.md)）。
- `RISC0_DEV_MODE=1` の receipt は production STARK proof ではありません。

## 章の読み順

- [設計と実行フロー](design-and-flow.md)：設計原則、パイプライン構造、実行フロー、判定確定後の observability
- [4 段階検証モデル](four-stage-model.md)：検証の全体設計と各段階の保証
- [チェック一覧](checks-catalog.md)：全検証チェック ID とその判定ロジック
- [バンドル構造](bundle-structure.md)：[証明バンドル](../appendix/glossary.md#証明バンドルproof-bundle)の公開可能なアーティファクトと非公開アーティファクト
- [公開境界](public-boundary.md)：public `bundle.zip` と protected report artifact の境界
- [ゲーティングロジック](gating-logic.md)：「Verified」表示の条件と不変条件

## 想定読者と前提

- 想定読者：`/verify` 画面の最終判定ロジックを把握したい監査者と実装者
- 前提：[暗号プロトコル](../protocol/index.md) と [zkVM 設計](../zkvm/index.md) の概要を読み終えていること

## 扱わない範囲

- `bundle.zip` のローカル監査手順（[第三者検証ガイド](../reproducibility/index.md) を参照）
- 改ざんシナリオごとの検出表（[改ざんシナリオ](../tamper/index.md) を参照）
- UI コンポーネントや Storybook 配置の詳細

## 関連する章

- [暗号プロトコル](../protocol/index.md)：チェック対象となるプリミティブ
- [zkVM 設計](../zkvm/index.md)：ジャーナルとレシートの構造
- [改ざんシナリオ](../tamper/index.md)：どのチェックがどの改ざんを検出するか
- [可観測性設計](../aws/observability.md)：verdict authority と判定後 observation の分離
- [第三者検証ガイド](../reproducibility/index.md)：[`bundle.zip`](../appendix/glossary.md#配布対象アーカイブbundlezip) を使ったローカル監査
- [用語集](../appendix/glossary.md)：チェック種別とゲーティング用語の定義

<!-- source: packages/verification/src/verification/, apps/api/src/server/api/handlers/verify.ts, apps/api/src/server/api/handlers/verificationRun.ts, apps/api/src/server/api/handlers/verificationObservation.ts, apps/api/src/server/api/handlers/verificationBundles.ts, apps/web/src/routes/verify/, apps/web/src/routes/verify/hooks/useVerificationObservation.ts -->
