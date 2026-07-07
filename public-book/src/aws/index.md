# AWS アーキテクチャ

この部は、STARK Ballot Simulator を AWS 上で動かす場合の runtime 境界とサービス責務を説明します。
まず [AWS runtime boundary](runtime-boundary.md) を読み、公開仕様として扱う範囲を確認してください。

AWS runtime は、Terraform 管理の静的フロントエンド、Hono/API ランタイム、DynamoDB ストア、非同期プローバー、検証 worker、private proof artifact storage で構成されます。
この部はそれぞれの責務分担を説明するもので、本番環境の初期構築、独自ドメインの本番 DNS 切り替え、旧 AWS アカウント削除の完了状態を主張するものではありません。

ここでの `public` bundle は「秘密を含まず第三者検証に使える」配布対象 artifact の分類であり、無認証公開を意味しません（詳細は [公開境界](../verification/public-boundary.md)）。
`verification.json` などの protected report artifact は別物で、通常の bundle/report 取得経路は capability 保護 API です。

## この部に含まれる章

- [AWS runtime boundary](runtime-boundary.md)：公開仕様として扱う runtime 境界、artifact 境界、扱わない情報
- [現行構成とサービス一覧](design-and-services.md)：runtime 管理境界、環境分離、主要サービスの責務
- [トポロジー](topology.md)：レイヤ別のサービス構成と通信フロー
- [非同期プローバー](async-prover.md)：SQS → Step Functions → ECS による証明パイプライン
- [イメージ署名](image-signing.md)：AWS Signer によるコンテナイメージ検証
- [Terraform](terraform.md)：IaC による root ownership と runtime wiring

## 想定読者と前提

- 想定読者: 公開仕様として AWS runtime の責務分担を把握したい読者
- 前提: AWS の基本サービス（S3 / SQS / Step Functions / ECS）と Terraform の概念を把握していること

## 本章で扱わないもの

- 退役済み Amplify / AppSync 構成の詳細
- Terraform 文法・モジュール設計の一般論
- CloudWatch アラート設計やコスト最適化ガイド
- 個別アカウント、秘密値、デプロイ承認、移行作業記録、環境切り替えの進捗

## 関連する章

- [zkVM 設計](../zkvm/index.md)：ECS 上で実行されるホストとレシート生成
- [バンドル構造](../verification/bundle-structure.md)：`bundle.zip` と protected report artifact の境界
- [第三者検証ガイド](../reproducibility/index.md)：capability 保護 API から取得した `bundle.zip` を使うローカル監査
- [用語集](../appendix/glossary.md)：インフラ用語の定義

<!-- source: infra/terraform/, infra/lambdas/, infra/docker/, public-book/src/aws/runtime-boundary.md -->
