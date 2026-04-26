# STARK証明の構造と特性

このドキュメントでは、RISC Zero zkVMが生成するSTARK証明（Receipt）の構造と特性を、**Phase 10 launch prep** 時点の実装に合わせて整理します。

## 目次

1. [概要](#概要)
2. [証明の構造](#証明の構造)
3. [実測・目安](#実測目安)
4. [検証可能な保証](#検証可能な保証)

## 概要

STARK（Scalable Transparent ARgument of Knowledge）証明は、計算の正当性を数学的に保証するゼロ知識証明の一種です。RISC Zero zkVMでは、RISC-V命令セットで記述されたプログラムの実行が正しく行われたことを証明します。

### 開発モード vs 本番モード

```bash
# 開発モード（Fake receipt）
RISC0_DEV_MODE=1 ./zkvm/target/release/host input.json

# 本番モード（実STARK証明）
./zkvm/target/release/host input.json
```

- **RISC0_DEV_MODE=1** は **Fake receiptのみ** を生成します（実証明ではない）。
- Fake receipt は実STARK証明としては扱えず、現行 `verifier-service` では `dev_mode` として報告されます。
- 本番証明は環境依存で数分かかります（Phase 10 の基準: 64票 ≈ ~370秒）。

## 証明の構造

### Receipt構造（概略）

RISC Zero zkVM内部の **raw Receipt** は、概念的には次のような構造です。

```json
{
  "inner": {
    "Composite": {
      "segments": [
        {
          "seal": [...],
          "index": 0,
          "hashfn": "...",
          "verifier_parameters": "...",
          "claim": "..."
        }
      ]
    }
  },
  "journal": {
    "bytes": [...]
  }
}
```

ただし、現行実装でホストや verification bundle が扱う `receipt.json` は、
この raw Receipt をそのまま配るのではなく、**top-level metadata を持つ envelope** として保存します。
非 dev receipt の検証では、`verifier-service` は top-level `image_id` を要求します。

```json
{
  "receipt": {
    "inner": {
      "Composite": {
        "segments": [
          {
            "seal": [...]
          }
        ]
      }
    },
    "journal": {
      "bytes": [...]
    }
  },
  "image_id": "0x..."
}
```

- dev mode では `Composite` の代わりに `Fake` receipt が入ります。
- app 側の bundle 生成では互換のため `image_id` に加えて `imageId` も注入されることがありますが、現行 verifier が参照するのは top-level `image_id` です。

### 主要コンポーネント

#### 1. Seal（証明データ）

- **内容**: フィールド要素の配列（サイズはプログラムや証明条件に依存）
- **役割**: 計算の正当性を証明する暗号学的データ
- **特徴**:
  - 改ざんすると検証が失敗する
  - 受領するファイルサイズの大半を占める
  - Phase 10 の実装では **数百KB〜~2MB** が目安（環境・JSON表現に依存）

#### 2. Journal（公開出力）

Phase 10 現行レイアウト（272 bytes 固定）：

```text
[0:16]   electionId (UUID)
[16:48]  electionConfigHash (32 bytes)
[48:80]  bulletinRoot (32 bytes)
[80:84]  treeSize (u32)
[84:88]  totalExpected (u32)
[88:120] sthDigest (32 bytes)
[120:140] verifiedTally (5 x u32)
[140:168] totalVotes, validVotes, invalidVotes, seenIndicesCount,
          missingSlots, invalidPresentedSlots, rejectedRecords (u32 each)
[168:200] seenBitmapRoot (32 bytes)
[200:232] includedBitmapRoot (32 bytes)
[232:236] excludedSlots (u32)
[236:268] inputCommitment (32 bytes)
[268:272] methodVersion (u32)
```

- `tamperDetected` は **Journalには含まれず**、クライアント/サーバが `excludedSlots` / `rejectedRecords` などの journal 統計値と、S2/S4 などの claimed tally tampering を表す `tamperSummary` 由来の scenario signal から導出します。
- 272-byte の raw journal bytes には `imageId` も含まれません。ただし、公開 `journal.json` などの JSON projection では comparison-only metadata として `imageId` が付与されることがあります。
- `methodVersion` は **12（v1.2）**。
- app 側の journal parser / public journal projection はこの **272-byte / v12 layout** を前提とし、legacy journal の後方互換は維持しません。
- `verifier-service` 自体は主に `Receipt::verify(expectedImageId)` と top-level `image_id` の整合を担当し、journal bytes の意味解釈は app 側の責務です。

#### 3. Claim（主張）

証明が主張する内容：

- 初期プログラムカウンタ（PC）
- 終了コード
- 入力データのハッシュ

## 実測・目安

**実測値は環境依存**のため、ここでは Phase 10 時点の目安を示します。

| モード     | 証明タイプ        | サイズ目安   | 生成時間目安                    |
| ---------- | ----------------- | ------------ | ------------------------------- |
| 開発モード | Fake              | 数KB         | ~100ms                          |
| 本番モード | Composite (STARK) | 数百KB〜~2MB | 数分（64票 ≈ ~370秒、環境依存） |

- **検証時間**: 数秒程度（Receipt::verify）
- checked-in の 64票 real receipt JSON は現在およそ **1.7MB** です。圧縮有無、RISC Zero のバージョン、証明条件により変動します。

### Journal データの例（解析後）

```json
{
  "electionId": "2f6c9c4a-7f2d-4a1f-9c60-2d3a7f3f7c20",
  "electionConfigHash": "0x...",
  "bulletinRoot": "0x...",
  "treeSize": 64,
  "totalExpected": 64,
  "sthDigest": "0x...",
  "verifiedTally": [14, 13, 13, 12, 12],
  "totalVotes": 64,
  "validVotes": 64,
  "invalidVotes": 0,
  "seenIndicesCount": 64,
  "missingSlots": 0,
  "invalidPresentedSlots": 0,
  "rejectedRecords": 0,
  "seenBitmapRoot": "0x...",
  "includedBitmapRoot": "0x...",
  "excludedSlots": 0,
  "inputCommitment": "0x...",
  "methodVersion": 12
}
```

## 検証可能な保証

STARK証明は以下を数学的に保証します：

### 1. 計算の正確性

- 指定されたRISC-Vプログラムが正確に実行された
- 全ての命令が仕様通りに処理された
- メモリアクセスが正しく行われた

### 2. 入出力の整合性

- Journal（公開出力）が実際の計算結果である
- 入力コミットメント（`inputCommitment`）により、**特定入力**での実行が保証される

### 3. 改ざん不可能性

- 証明データの1ビットでも変更すると検証失敗
- 別の計算結果に対する証明の再利用不可
- 事後的な結果の変更不可

## まとめ

STARK証明は強力な数学的保証を提供しますが、そのトレードオフとして計算コストとストレージの負担が大きいです。Phase 10 の現行実装では、**開発時は Fake receipt を使用し、本番検証では実STARK証明のみを受理する**運用が前提です。
