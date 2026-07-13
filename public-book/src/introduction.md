# はじめに

> **最終更新:** 2026-07-13

このドキュメントは、`STARK Ballot Simulator` の公開向けガイドです。
`STARK Ballot Simulator` は投票の完全性を段階的に検証する教育・ポートフォリオ向けの PoC であり、実運用の選挙基盤ではありません。

## 目的

- システムの全体像を短時間で把握できるようにする
- 暗号プロトコルと検証パイプラインの設計根拠を説明する
- 検証手順を再現できる情報を提供する

## 公開状態

本書は、ライブデモと公開用ソース snapshot の読者に向けたドキュメントです。
公開 repository snapshot は [hwatanabe-jp/stark-ballot-simulator-public](https://github.com/hwatanabe-jp/stark-ballot-simulator-public) で確認できます。

ソースコードへのアクセスが必要な再現手順は、対象リリースの公開 repository snapshot と照合して実行してください。
`bundle.zip` だけで実行できる確認範囲は [第三者検証ガイド](reproducibility/index.md) にまとめています。

公開仕様は、runtime、検証、artifact の 3 つの境界を説明します。
これらは利用者、監査者、実装追跡者が確認できる範囲です。
開発中ブランチの移行作業記録、運用証跡、個別の本番切替進捗は内部ドキュメント側で管理し、本書では完了状態として主張しません。

## 想定読者

- 暗号検証や監査、本アプリケーションの設計に関心のある技術者

## 本書の用語表記

本書では、語彙の揺れを避けるために次の表記へ統一します。
詳細な定義は [用語集](appendix/glossary.md) を参照してください。

- **日本語に統一する語**：コミットメント（文脈に応じて「投票コミットメント」「入力コミットメント」を区別）、包含証明、整合性証明、投票レシート、掲示板、ジャーナル
- **英語のまま使う語**：STARK、zkVM、Image ID、RFC 6962、capability、`bundle.zip`、fail-closed、finalization（集計確定）
- **識別子は原文のまま**：ファイル名、API フィールド、契約名（`journal.json`、`verificationStatus` など）はコードフォントの英語表記を保ちます。
- **コンポーネント名**：概念としては「検証サービス」、バイナリ名・パスとしては `verifier-service` を使います。
- **役割名とリソース名**：概念・役割としては「プローバー」「検証 worker」、リソース・コンポーネント固有名（prover semaphore、`proof-dispatcher`、`verification-worker` など）は原文の英語表記を保ちます。

バンドル関連は、次の 3 語を使い分けます。

| 指すもの                             | 表記               |
| ------------------------------------ | ------------------ |
| 配布されるファイル本体               | `bundle.zip`       |
| 配布対象としての論理名               | 配布対象アーカイブ |
| 非公開アーティファクトを含む上位概念 | 証明バンドル       |

`verification.json` は protected report artifact であり、public `bundle.zip` のメンバーではありません。
階層関係は [バンドル構造](verification/bundle-structure.md) と [公開境界](verification/public-boundary.md) を参照してください。

## 本書の読み方

### 標準ルート

1. まず [全体像](overview.md) でシステムの概要を掴む
2. [利用フロー](usage-flow.md) で Home から Verify までの画面と API の流れを確認する
3. [暗号プロトコル](protocol/index.md) でコミットメントや Merkle ツリーなどの基盤を理解する
4. [zkVM 設計](zkvm/index.md) でゲストプログラムと証明生成の仕組みを学ぶ
5. [検証パイプライン](verification/index.md) で 4 段階検証モデルの全体と公開境界を把握する
6. [改ざんシナリオ](tamper/index.md) で教育的シミュレーションの動作を確認する
7. [品質保証と形式手法](quality/index.md) でテスト、PBT、Lean による品質境界を確認する
8. [AWS アーキテクチャ](aws/index.md) で runtime の責務分担を理解する
9. [API リファレンス](api/index.md) でエンドポイント仕様を参照する
10. 実際に検証する場合は [第三者検証ガイド](reproducibility/index.md) で `bundle.zip` を使ったローカル検証手順を実行する

補助資料（[設計判断](decisions/index.md)、[アーキテクチャ語彙マップ（参考）](architecture-map.md)、[参考文献](appendix/references.md)）は必要になった時点で参照してください。

### 読者別ルート

いずれも標準ルートの 1〜2（[全体像](overview.md)、[利用フロー](usage-flow.md)）を読み終えていることを前提に、そこから先の重点だけを示します。

#### 監査者向け

`bundle.zip` を検証ページから取得し、独立にローカル監査したい読者向けです。

1. [検証パイプライン](verification/index.md) で `/verify` の最終判定ロジックを理解する
2. [公開境界](verification/public-boundary.md) で public `bundle.zip` と protected report artifact（`verification.json`）の境界を確認する
3. [チェック一覧](verification/checks-catalog.md) で各チェック ID と判定条件を確認する
4. [第三者検証ガイド](reproducibility/index.md) で `bundle.zip` のローカル監査手順を実行する

[用語集](appendix/glossary.md) を手元に置き、テストと形式化が守る境界は [品質保証と形式手法](quality/index.md) で補足してください。
飛ばしてよい: [暗号プロトコル](protocol/index.md) の数式詳細、[AWS アーキテクチャ](aws/index.md) のインフラ詳細

#### 実装者向け

クライアント、サーバー、zkVM のいずれかの実装を変更または追従したい読者向けです。

1. [暗号プロトコル](protocol/index.md) でコミットメント、Merkle、入力コミットメントの正準形を把握する
2. [zkVM 設計](zkvm/index.md) でゲストとホストの責務分担と Image ID 管理を理解する
3. [検証パイプライン](verification/index.md) でチェック評価、ゲーティング、公開境界を把握する
4. [API リファレンス](api/index.md) でエンドポイント仕様と session-scoped 認可を確認する

テストのレイヤー分担は [品質保証と形式手法](quality/index.md)、語彙とデータフローの俯瞰は [アーキテクチャ語彙マップ（参考）](architecture-map.md) を参照してください。
飛ばしてよい: [第三者検証ガイド](reproducibility/index.md)（実装変更後の動作確認には [改ざんシナリオ](tamper/index.md) を使う方が早い）

#### 運用者向け

AWS インフラ、非同期プローバー、デプロイを担当する読者向けです。

1. [AWS runtime boundary](aws/runtime-boundary.md) で frontend、API、DynamoDB、async prover、artifact delivery の責務分担を把握する
2. [AWS アーキテクチャ](aws/index.md) で runtime 構成、環境分離、Terraform-managed infrastructure の連携点を把握する
3. [非同期プローバー](aws/async-prover.md) で SQS、Step Functions、ECS の責務を理解する
4. [イメージ署名](aws/image-signing.md) と [Image ID](zkvm/image-id.md) で署名検証と Image ID 解決の連動を確認する
5. [公開境界](verification/public-boundary.md) と [バンドル構造](verification/bundle-structure.md) で artifact の公開 / 保護境界を把握する

運用時に監視するエンドポイントは [API リファレンス](api/index.md) を参照してください。
飛ばしてよい: [暗号プロトコル](protocol/index.md) の数式、[改ざんシナリオ](tamper/index.md) の教育的デモ詳細
