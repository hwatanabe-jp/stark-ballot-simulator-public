# STARK証明の構造と特性

このドキュメントでは、RISC Zero zkVM が生成する Receipt の構造、公開出力、検証境界を、
現在の実装に合わせて整理します。

## 目次

1. [概要](#概要)
2. [証明の構造](#証明の構造)
3. [実測・目安](#実測目安)
4. [検証可能な保証と境界](#検証可能な保証と境界)

## 概要

RISC Zero zkVM は、指定された RISC-V guest program の実行と、その実行が commit した journal を
Receipt に結び付けます。このリポジトリでは、mock、開発用 fake receipt、本番 feature で生成する
実 STARK receipt を明確に区別します。

| 経路                  | 実行主体              | 証拠                                    |
| --------------------- | --------------------- | --------------------------------------- |
| mock                  | TypeScript mock       | mock のみ。RISC Zero Receipt ではない   |
| RISC Zero development | dev-mode-capable host | Fake receipt。production proof ではない |
| RISC Zero production  | production host       | 実 STARK receipt                        |

Fake receipt を生成するには、dev mode を許可した host build が必要です。

```bash
pnpm build:zkvm:dev-mode
RISC0_DEV_MODE=1 \
  ./zkvm/target/release/host zkvm/test-data/test-fixture-valid.json
```

実 STARK receipt の生成には、dev mode を無効化した production feature build を使用します。

```bash
pnpm build:zkvm
env -u RISC0_DEV_MODE \
  ./zkvm/target/release/host zkvm/test-data/test-fixture-valid.json
```

両方の build は同じ `zkvm/target/release/host` を上書きします。production feature build は
`risc0-zkvm/disable-dev-mode` を有効にするため、`RISC0_DEV_MODE=1` を受理しません。
Fake receipt は `verifier-service` で通常 `dev_mode` として報告され、production STARK proof
evidence としては受理されません。

## 証明の構造

### Receipt envelope

host が保存し、verification bundle が `receipt.json` として配布する現在の artifact は、raw
RISC Zero `Receipt` と compiled guest の ImageID metadata を持つ envelope です。

```json
{
  "receipt": {
    "inner": {
      "Composite": {
        "segments": [
          {
            "seal": []
          }
        ]
      }
    },
    "journal": {
      "bytes": []
    }
  },
  "image_id": "0x..."
}
```

この `Composite` は checked-in の実 receipt fixture が現在使用している variant の例です。
envelope の契約は特定の inner variant に固定されておらず、dev-mode-capable host が
`RISC0_DEV_MODE=1` で生成した Receipt では `inner.Fake` が入ります。consumer は envelope 内の
RISC Zero `Receipt` を generic に deserialize し、`Composite` を前提にしません。

app の bundle 生成は、境界間の表記を維持するため `image_id` に加えて `imageId` を top-level
および nested receipt に付与することがあります。`verifier-service` が receipt metadata として
読み、expected ImageID と比較する authority は top-level `image_id` です。

### Seal

Seal は計算の正当性を検証する暗号学的 proof data です。具体的な JSON shape は RISC Zero の
inner receipt variant に依存します。現在の checked-in `Composite` receipt では segment ごとの
配列として表現され、実 receipt JSON のファイルサイズの大半を占めます。seal または seal が
結び付ける claim / journal を不整合に変更すると、`Receipt::verify(expectedImageId)` は失敗します。

### Journal（公開出力）

guest は次の current field set を `VerificationOutput` として commit します。

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
  "methodVersion": 14
}
```

current host は `receipt.journal.decode::<VerificationOutput>()` でこの値を復元し、camelCase の
`*-output.json` として保存します。sync / async bundle 生成は decoded field を allowlist し、
canonical な公開 artifact `journal.json` を生成します。この decoded `VerificationOutput` →
`journal.json` が app と bundle における現在の journal path です。

- `methodVersion` は **14** です。current journal admission はこの version を要求し、legacy count
  alias や旧 layout を current field へ変換しません。
- `imageId` は guest が commit する `VerificationOutput` の field ではありません。host が付与する
  comparison-only metadata で、`journal.json` に投影されることがあります。
- `tamperDetected` も journal field ではありません。app は `excludedSlots`、`rejectedRecords`、
  および S2/S4 の claimed-tally tampering を表す `tamperSummary` の scenario signal から導出します。
- `seenBitmapRoot` と `includedBitmapRoot` は公開されますが、個々の bitmap artifact は private で、
  public bundle には含めません。

`packages/verification/src/verification/journal-parser.ts` の `parseJournalBytes()` が扱う 272-byte
packed layout は unit test 用の低レベル helper です。RISC Zero Receipt 内部の
`receipt.journal.bytes` は serde encoding を含み、この layout の入力ではありません。raw bytes を
直接解釈せず、`journal.json` を current public interface として使用します。

## 実測・目安

実測値は環境、RISC Zero の version、proof 条件、JSON 表現、圧縮有無に依存し、protocol 上の
保証値ではありません。

| モード                | Receipt / 証明タイプ              | サイズ目安   | 生成時間目安                    |
| --------------------- | --------------------------------- | ------------ | ------------------------------- |
| mock                  | mock artifact                     | 実装依存     | 高速                            |
| RISC Zero development | Fake                              | 数十KB程度   | ~100ms                          |
| RISC Zero production  | Composite（current fixture の例） | 数百KB〜~2MB | 数分（64票 ≈ ~370秒、環境依存） |

- `Receipt::verify` の検証時間は数秒程度が目安です。
- checked-in の 64票 real receipt JSON は現在およそ **1.7MB** です。

## 検証可能な保証と境界

`verifier-service` は、外部から選択された expected ImageID を使って
`Receipt::verify(expectedImageId)` を実行します。これにより、expected ImageID が識別する guest
program が正常終了し、その実行が commit した journal と receipt の claim / seal が整合することを
検証します。non-dev receipt では、envelope の top-level `image_id` が expected ImageID と一致する
ことも必須です。

`inputCommitment` は、次の **公開 subset** を domain-separated hash に結び付けます。

- `electionId`
- `bulletinRoot`
- `treeSize`
- `totalExpected`
- vote record 数
- canonical order に並べた各 vote の `index`、`commitment`、`merklePath`

`inputCommitment` は private witness 全体や `public-input.json` 全 field の hash ではありません。
`choice` と `random` は commitment の opening として guest 内で検証されますが、値そのものは
`inputCommitment` preimage や journal に公開されません。また、次の field はそれぞれ独立した
authority と consistency check で結び付けます。

- `electionConfigHash`: journal、public input、election manifest の一致と manifest の再計算
- `logId` / `timestamp`: `sthDigest` と close statement の再計算・一致
- `methodVersion`: journal と public input contract の current-version admission
- ImageID: verifier の expected ImageID、receipt verification report、envelope metadata の一致

したがって、production の検証結果は seal だけで決まりません。実 STARK receipt、expected
ImageID、canonical journal、public input、manifest、close statement、bitmap / bulletin evidence
など、必要な check がすべて成功した場合にだけ全体を Verified と扱えます。mock は高速な UI / API
test evidence、Fake receipt は RISC Zero integration 用の development evidence に限定され、どちらも
production STARK proof correctness の証拠ではありません。
