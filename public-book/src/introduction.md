# はじめに

> **最終更新:** 2026-05-23

このドキュメントは、`STARK Ballot Simulator` の公開向けガイドです。

## 目的

- システムの全体像を短時間で把握できるようにする
- 暗号プロトコルと検証パイプラインの設計根拠を説明する
- 検証手順を再現できる情報を提供する

## 公開状態

本書はライブデモと公開用ソース snapshot の読者に向けたドキュメントです。ソースコードへのアクセスが必要な再現手順は、対象リリースの公開 repository snapshot と照合して実行してください。`bundle.zip` だけで実行できる確認範囲は [第三者検証ガイド](reproducibility/index.md) にまとめています。

## 想定読者

- 暗号検証・監査に関心のある技術者
- 本アプリケーションに興味のある技術者

## 本書の用語表記

語彙の揺れを避けるため、本書では次のように表記を統一しています。詳細な定義は [用語集](appendix/glossary.md) を参照してください。

- **日本語に統一する語**: コミットメント（文脈に応じて「投票コミットメント」「入力コミットメント」を区別）、包含証明、整合性証明、投票レシート、掲示板、集計確定
- **英語のまま使う語**: STARK、zkVM、Image ID、RFC 6962、capability、`bundle.zip`、fail-closed、journal
- **バンドル関連の正規形**: 配布されるファイル本体は `` `bundle.zip` ``（コードフォント）、配布対象としての論理名は「配布対象アーカイブ」、上位概念（非公開アーティファクトを含む全体）は「証明バンドル」を使い分けます。階層関係は [バンドル構造](verification/bundle-structure.md) を参照。

## 本書の読み方

### 標準ルート

1. まず [全体像](overview.md) でシステムの概要を掴む
2. [暗号プロトコル](protocol/index.md) でコミットメント・Merkle ツリー等の基盤を理解する
3. [zkVM 設計](zkvm/index.md) でゲストプログラムと証明生成の仕組みを学ぶ
4. [検証パイプライン](verification/index.md) で 4 段階検証モデルの全体を把握する
5. [改ざんシナリオ](tamper/index.md) で教育的シミュレーションの動作を確認する
6. [品質保証と形式手法](quality/index.md) でテスト・PBT・Lean による品質境界を確認する
7. [AWS アーキテクチャ](aws/index.md) で非同期証明インフラを理解する
8. [API リファレンス](api/index.md) でエンドポイント仕様を参照する
9. 実際に検証する場合は [第三者検証ガイド](reproducibility/index.md) で `bundle.zip` を使ったローカル検証手順を実行する
10. 設計上の判断については [設計判断](decisions/index.md) を参照する
11. 設計根拠の一次資料は [参考文献](appendix/references.md) を参照する

### 読者別ルート

#### 監査者向け

`bundle.zip` を検証ページから取得し、独立にローカル監査したい読者向け。

1. [全体像](overview.md) で 4 段階モデルとバンドル階層を把握する
2. [検証パイプライン](verification/index.md) で `/verify` の最終判定ロジックを理解する
3. [チェック一覧](verification/checks-catalog.md) で各チェック ID と判定条件を確認する
4. [第三者検証ガイド](reproducibility/index.md) で `bundle.zip` のローカル監査手順を実行する
5. [用語集](appendix/glossary.md) で「検証」「監査」「fail-closed」などの用語を確認する
6. [品質保証と形式手法](quality/index.md) で、テストと形式化がどの境界を守っているかを確認する

飛ばしてよい: [暗号プロトコル](protocol/index.md) の数式詳細、[AWS アーキテクチャ](aws/index.md) のインフラ詳細

#### 実装者向け

クライアント/サーバー/zkVM のいずれかの実装を変更・追従したい読者向け。

1. [全体像](overview.md) でシステム境界を確認する
2. [暗号プロトコル](protocol/index.md) でコミットメント・Merkle・入力コミットメントの正準形を把握する
3. [zkVM 設計](zkvm/index.md) でゲスト/ホストの責務分担と Image ID 管理を理解する
4. [検証パイプライン](verification/index.md) でチェック評価とゲーティングを把握する
5. [品質保証と形式手法](quality/index.md) で、テスト・PBT・Lean のレイヤー分担を確認する
6. [API リファレンス](api/index.md) でエンドポイント仕様と session-scoped 認可を確認する

飛ばしてよい: [第三者検証ガイド](reproducibility/index.md)（実装変更後の動作確認には [改ざんシナリオ](tamper/index.md) を使う方が早い）

#### 運用者向け

AWS インフラ・非同期プローバー・デプロイを担当する読者向け。

1. [全体像](overview.md) で sync / async finalize の違いを確認する
2. [AWS アーキテクチャ](aws/index.md) で現行構成、環境分離、Amplify / Terraform の連携点を把握する
3. [非同期プローバー](aws/async-prover.md) で SQS / Step Functions / ECS の責務を理解する
4. [イメージ署名](aws/image-signing.md) と [Image ID](zkvm/image-id.md) で署名検証と Image ID 解決の連動を確認する
5. [バンドル構造](verification/bundle-structure.md) で公開/非公開アーティファクトの境界を把握する
6. [API リファレンス](api/index.md) で本番運用で監視すべきエンドポイントを確認する

飛ばしてよい: [暗号プロトコル](protocol/index.md) の数式、[改ざんシナリオ](tamper/index.md) の教育的デモ詳細
