# 第三者検証ガイド

> **公開 snapshot に関する注意**
> `bundle.zip` の展開と `journal.json` 完全性チェック（Step 3, 6）はダウンロード済み ZIP のみで実行できます。
> `verifier-service` ビルド・`imageId-mapping.json` 参照・公開アーティファクト整合・`inputCommitment` 再計算（Step 2, 4, 7, 8）は、検証対象リリースと対応する公開 repository snapshot が必要です。

この章は、検証ページでダウンロードした [`bundle.zip`](../appendix/glossary.md#配布対象アーカイブbundlezip) を使って、第三者がローカルで行える[配布対象アーカイブ](../appendix/glossary.md#配布対象アーカイブbundlezip)単体の最小監査手順をまとめたものです。`/verify` 画面の最終判定の完全再現ではなく、下表の不変条件を確認することがゴールです。

**`bundle.zip` 単体では揃わないもの**（上の callout は手順実行に必要な前提、ここは検証材料そのものとして ZIP に入らないものです）:

- `/api/verify` が返す claimed tally と `verificationChecks` / `verificationSteps`
- 投票者端末に残る投票意図・乱数・投票レシート
- 掲示板の包含証明 / 整合性証明
- 自票 inclusion 用のビットマップ証明
- 有効化されている場合の第三者 STH ソース照合

これは PoC の設計意図です（[配布対象アーカイブ](../verification/bundle-structure.md) の構成も参照）。

## この部に含まれる章

- [ZIP ローカル検証（Ubuntu）](audit-bundle.md) — `bundle.zip` を取得した第三者が Ubuntu 上で実行できる最小監査手順

## 想定読者と前提

- 想定読者: 配布された `bundle.zip` を独立にローカル監査したい第三者
- 前提: Ubuntu 系 Linux と `jq` / `unzip` などの基本 CLI、対応する公開リポジトリ snapshot へのアクセス。詳細は [はじめに](../introduction.md#公開状態) を参照

## 本章で扱わないもの

- `/verify` UI が表示する最終判定の完全再現（包含証明・整合性証明・第三者 STH 照合などはサーバー側でのみ評価される）
- 投票者端末のローカル証跡（投票意図・乱数・投票レシート）を使った Cast-as-Intended 検証
- AWS インフラのデプロイ・運用手順
- 上で扱わない検証材料の一覧は冒頭の「`bundle.zip` 単体では揃わないもの」も参照

## 関連する章

この章は `bundle.zip` のローカル監査に絞ります。範囲外の作業は次のページを参照してください。

- [チェック一覧](../verification/checks-catalog.md) — チェック ID と判定ロジック
- [API エンドポイント一覧](../api/endpoints.md) — 手動検証に使う API 契約
- [検出メカニズム](../tamper/detection-mechanism.md) — 改ざんシナリオごとの失敗パターン
- [非同期プローバー](../aws/async-prover.md) — 非同期 finalize の処理と障害調査導線
- [バンドル構造](../verification/bundle-structure.md) — 配布対象アーカイブの公開可能・非公開アーティファクト
- [用語集](../appendix/glossary.md#検証パイプライン) — 「検証」と「監査」の使い分けほか

## 最低限確認する不変条件

| 項目                     | 合格条件                                                                        |
| ------------------------ | ------------------------------------------------------------------------------- |
| STARK レシート           | `verifier-service verify` が `status: "success"`                                |
| 投票の除外有無           | `excludedSlots == 0` かつ `missingSlots == 0` かつ `invalidPresentedSlots == 0` |
| 期待投票数整合           | `totalExpected == treeSize`                                                     |
| 集計合計整合             | `journal.json` の `verifiedTally` の合計が `validVotes` と一致                  |
| 公開入力の基本整合性     | `public-input.json` が現行 contract に沿い、入力数・root・重複検査が成立        |
| 公開監査アーティファクト | `election-manifest.json` と `close-statement.json` の自己整合・相互整合が成立   |
| 入力整合性               | `inputCommitment` の再計算値が `journal.json` と一致                            |

<!-- source: src/app/(routes)/verify/page.tsx, src/app/(routes)/verify/lib/verification-data.ts, src/app/(routes)/verify/lib/download.ts, src/server/api/handlers/verify.ts, src/server/api/handlers/verificationBundles.ts, src/lib/verification/verification-bundle.ts, src/lib/verification/public-audit-artifacts.ts, src/lib/verification/verification-checks.ts, src/lib/verification/engine/evaluate-checks.ts, src/lib/verification/verification-summary.ts, src/lib/zkvm/types.ts, verifier-service/src/lib.rs, public/imageId-mapping.json -->
