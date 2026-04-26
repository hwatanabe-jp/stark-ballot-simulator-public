# AWS アーキテクチャ

Amplify Gen 2 が担うアプリ層と、Terraform で管理する非同期プローバー層を組み合わせたハイブリッド構成を扱う部です。

## この部に含まれる章

- [設計思想とサービス一覧](design-and-services.md) — ハイブリッド構成の理由、環境分離、サービス構成
- [トポロジー](topology.md) — レイヤ別のサービス構成と通信フロー
- [非同期プローバー](async-prover.md) — SQS → Step Functions → ECS による証明パイプライン
- [イメージ署名](image-signing.md) — AWS Signer によるコンテナイメージ検証
- [Terraform](terraform.md) — IaC による構成管理とワークスペース運用

## 想定読者と前提

- 想定読者: 非同期プローバーや IaC の構成を把握したい運用者
- 前提: AWS の基本サービス（S3 / SQS / Step Functions / ECS）と Terraform の概念を把握していること

## 関連する章

- [zkVM 設計](../zkvm/index.md) — ECS 上で実行されるホストとレシート生成
- [第三者検証ガイド](../reproducibility/index.md) — 公開バケットに置かれた `bundle.zip` の取得経路
- [用語集](../appendix/glossary.md) — インフラ用語の定義

<!-- source: terraform/, amplify/backend.ts, docker/ -->
