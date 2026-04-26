# Cloud Security Guide

AWS インフラストラクチャと公開境界のセキュリティ設定・監視に関する入口。

> **Note**: アプリケーションレベルのセキュリティ（CSP、Turnstile、Rate Limiting、コンテナ署名等）は [`docs/current/runbooks/security.md`](../../runbooks/security.md) を参照。

## 概要

| ドキュメント                                                                                                             | 内容                                                                |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| [aws-security-hub.md](./aws-security-hub.md)                                                                             | AWS Security Hub / AWS Config の低コスト監視設定メモ                |
| [`../7-terraform/README.md`](../7-terraform/README.md)                                                                   | CloudTrail、IAM、S3 policy、ECR signing など Terraform 管理インフラ |
| [`../../runbooks/security.md`](../../runbooks/security.md)                                                               | Turnstile、Rate Limiting、CSP、公開安全スキャン、コンテナ署名       |
| [`../../../PUBLIC_REPOSITORY.md`](../../../PUBLIC_REPOSITORY.md) | 生成 public snapshot の公開境界と stripped-path policy |
| [`../../../../scripts/security/README.md`](../../../../scripts/security/README.md)                                       | `pnpm public-safety:scan` と pre-commit hook                        |

## プロダクトセキュリティ vs インフラセキュリティ

| 分類                       | 対象                                                              | 主なドキュメント                                                                                                             |
| -------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **プロダクトセキュリティ** | STARK 暗号、CSP、Turnstile、Rate Limiting、コンテナ署名           | `docs/current/runbooks/security.md`                                                                                          |
| **インフラセキュリティ**   | Security Hub、AWS Config、CloudTrail、IAM、S3 policy、ECR signing | `docs/current/guides/8-security/`、`docs/current/guides/7-terraform/`                                                        |
| **公開境界セキュリティ**   | secrets、環境固有 ID、公開リポジトリ export、public safety scan   | `docs/PUBLIC_REPOSITORY.md`、`scripts/security/README.md` |
