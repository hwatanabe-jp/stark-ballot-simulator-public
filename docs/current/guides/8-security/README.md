# Cloud Security Guide

AWS インフラストラクチャと公開境界のセキュリティ設定・監視に関する入口。

> **Note**: アプリケーションレベルのセキュリティ（CSP、Turnstile、Rate Limiting、コンテナ署名等）は [`docs/current/runbooks/security.md`](../../runbooks/security.md) を参照。

## 概要

| ドキュメント                                                                                                                                                                                                                 | 内容                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [aws-security-hub.md](./aws-security-hub.md)                                                                                                                                                                                 | AWS Security Hub / AWS Config の低コスト監視設定メモ                |
| [`../7-terraform/README.md`](../7-terraform/README.md)                                                                                                                                                                       | CloudTrail、IAM、S3 policy、ECR signing など Terraform 管理インフラ |
| [`../../runbooks/security.md`](../../runbooks/security.md)                                                                                                                                                                   | Turnstile、Rate Limiting、CSP、公開安全スキャン、コンテナ署名       |
| [`../../verification/README.md`](../../verification/README.md)、[`../5-reference/stark-proof-structure.md`](../5-reference/stark-proof-structure.md)、[`../6-zkvm_design/final_design.md`](../6-zkvm_design/final_design.md) | STARK / zkVM 検証フロー、proof 構造、暗号契約                       |
| [`../../internal/guides/2-development/secrets-management.md`](../../internal/guides/2-development/secrets-management.md)                                                                                                     | secrets / 環境値 / 公開リポジトリ境界の扱い                         |
| [`../../../../scripts/security/README.md`](../../../../scripts/security/README.md)                                                                                                                                           | `pnpm public-safety:scan` と pre-commit hook                        |

## プロダクトセキュリティ vs インフラセキュリティ

| 分類                              | 対象                                                              | 主なドキュメント                                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **プロダクト / Web セキュリティ** | CSP、Turnstile、Rate Limiting、コンテナ署名                       | `docs/current/runbooks/security.md`                                                                                                                    |
| **STARK / zkVM 暗号契約**         | STARK 検証フロー、proof 構造、zkVM I/O / ImageID / bundle 境界    | `docs/current/verification/README.md`、`docs/current/guides/5-reference/stark-proof-structure.md`、`docs/current/guides/6-zkvm_design/final_design.md` |
| **インフラセキュリティ**          | Security Hub、AWS Config、CloudTrail、IAM、S3 policy、ECR signing | `docs/current/guides/8-security/`、`docs/current/guides/7-terraform/`                                                                                  |
| **公開境界セキュリティ**          | secrets、環境固有 ID、公開リポジトリ export、public safety scan   | `docs/PUBLIC_REPOSITORY.md`、`scripts/security/README.md`                           |
