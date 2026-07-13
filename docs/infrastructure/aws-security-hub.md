# AWS Security Hub 設定ガイド

## 設定スナップショット（2026-01-20）

| 項目          | 状態                                     |
| ------------- | ---------------------------------------- |
| Security Hub  | 有効（無料トライアルは 2026-02-19 まで） |
| AWS Config    | 有効（全リソース記録）                   |
| FSBP Standard | 4コントロールのみ有効                    |
| CIS Benchmark | 無効化                                   |

### 有効コントロール

| ID        | 重要度   | 説明                                 |
| --------- | -------- | ------------------------------------ |
| IAM.1     | HIGH     | IAMポリシーがフル権限を許可しない    |
| IAM.4     | CRITICAL | ルートアクセスキーが存在しない       |
| Lambda.1  | CRITICAL | Lambda関数がパブリックアクセスを禁止 |
| Account.1 | MEDIUM   | セキュリティ連絡先が設定されている   |

## 運用コマンド

```bash
# 検出結果の確認
aws securityhub get-findings --region ap-northeast-1 --max-items 20

# コントロール状態の確認
aws securityhub batch-get-security-controls \
  --security-control-ids IAM.1 IAM.4 Lambda.1 Account.1 \
  --region ap-northeast-1 --output table

# コスト確認（翌月以降）
aws ce get-cost-and-usage --time-period Start=2026-02-01,End=2026-02-28 \
  --granularity MONTHLY --metrics UnblendedCost \
  --filter '{"Dimensions":{"Key":"SERVICE","Values":["AWS Security Hub","AWS Config"]}}'
```

## 無効化手順

```bash
# Security Hub無効化
aws securityhub disable-security-hub --region ap-northeast-1

# Config Recorder停止
aws configservice stop-configuration-recorder --configuration-recorder-name default --region ap-northeast-1
```

## 月額コスト見積もり

- **Security Hub**: 〜$0.50/月（4コントロール）
- **AWS Config**: 〜$1-3/月（CI記録）
- **合計**: 約 $1.50-3.50/月

## 変更履歴

| 日付       | 変更内容                   |
| ---------- | -------------------------- |
| 2026-01-20 | 初期設定、AWS Config有効化 |
