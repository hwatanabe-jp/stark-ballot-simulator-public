# STARK証明の構造と特性

このドキュメントでは、RISC Zero zkVM が生成する Receipt の構造、公開出力、検証境界を、
現在の実装に合わせて整理します。

## 目次

1. [概要](#概要)
2. [証明の構造](#証明の構造)
3. [サイズと性能の評価](#サイズと性能の評価)
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

この `Composite` は構造を説明するための例で、配列の中身は省略しています。
envelope の契約は特定の inner variant に固定されておらず、dev-mode-capable host が
`RISC0_DEV_MODE=1` で生成した Receipt では `inner.Fake` が入ります。consumer は envelope 内の
RISC Zero `Receipt` を generic に deserialize し、`Composite` を前提にしません。

app の bundle 生成は、境界間の表記を維持するため `image_id` に加えて `imageId` を top-level
および nested receipt に付与することがあります。`verifier-service` が receipt metadata として
読み、expected ImageID と比較する authority は top-level `image_id` です。

### Seal

Seal は計算の正当性を検証する暗号学的 proof data です。具体的な JSON shape は RISC Zero の
inner receipt variant に依存します。上の `Composite` の例では segment ごとの
配列として表現されます。seal または seal が
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
  alias、未知の field、必須 field の欠落を拒否します。
- `imageId` は guest が commit する `VerificationOutput` の field ではありません。host が付与する
  comparison-only metadata で、`journal.json` に投影されることがあります。
- `tamperDetected` も journal field ではありません。app は `excludedSlots`、`rejectedRecords`、
  および S2/S4 の claimed-tally tampering を表す `tamperSummary` の scenario signal から導出します。
- `seenBitmapRoot` と `includedBitmapRoot` は公開されますが、個々の bitmap artifact は private で、
  public bundle には含めません。

TypeScript の journal admission は、count と5要素の `verifiedTally` に非負の JavaScript safe
integer かつ Rust `u32` の範囲を要求し、`treeSize` には正数を要求します。さらに tally 合計と
`validVotes`、有効・無効 record 数の合計と `totalVotes`、`invalidVotes` と `rejectedRecords` の一致を
確認します。計上・提示済み無効・未提示 slot の分割が tree size と整合し、提示済み無効 slot が
なければ両 bitmap root も一致する必要があります。これらの authority は
[`journal-guards.ts`](../../packages/zkvm-contract/src/zkvm/journal-guards.ts) です。
`totalExpected` と `treeSize` の不一致は失敗を説明する証拠として受理できますが、全体を
Verified とする条件は満たしません。

RISC Zero Receipt 内部の `receipt.journal.bytes` は RISC Zero serde encoding です。生成時の
decode は Rust host が所有し、app と bundle はそこから投影した `journal.json` を使用します。
独立した監査では `verifier-service decode-journal` が同じ読み込み済み receipt を expected
ImageID で検証し、`success` の場合だけ `VerificationOutput` へ decode して methodVersion 14 の
JSON を出力します。Fake receipt や旧 method の journal はこの経路では出力しません。
bundle の `journal.json` との照合手順は
[`verifier-service` の CLI guide](../../verifier-service/README.md#cli-usage) を参照してください。
どちらの経路も RISC Zero serde を使い、固定 byte offset の TypeScript parser は持ちません。

## サイズと性能の評価

Receipt のサイズ、生成時間、検証時間は環境、RISC Zero の version、proof 条件、JSON 表現、
圧縮有無に依存します。receipt fixture は実行時に再生成する artifact であり、この文書には
現在の build に対する固定の実測値を置きません。比較には同じ入力・build・環境で生成した
artifact と計測条件を使い、mock / Fake の速度を production STARK の性能として扱わないでください。
再生成手順は [zkVM guide](../../zkvm/README.md#build-test-prove-and-verify) にあります。

## 検証可能な保証と境界

`verifier-service` は、外部から選択された expected ImageID を使って
`Receipt::verify(expectedImageId)` を実行します。これにより、expected ImageID が識別する guest
program が正常終了し、その実行が commit した journal と receipt の claim / seal が整合することを
検証します。non-dev receipt では、envelope の top-level `image_id` が expected ImageID と一致する
ことも必須です。app が受理する report は status と `dev_mode_receipt`、ImageID、errors の相関を
検査し、`duration_ms` には非負の JavaScript safe integer を要求します。`success` report は
non-dev receipt と一致する expected / receipt ImageID を持ち、errors を持ちません。
report の形式・process exit/status 契約は [検証フロー](../verification/README.md) を参照してください。

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

公開 verification resource の admission は、report がある場合の status / ImageID、included
journal と `proofAuthority`、claimed tally と proof tally、それらから導く check・stage・表示
policy の整合も確認します。S2/S4 の claimed-tally 改ざんでは journal と receipt が正しくても、
公開 tally との不一致が検証失敗になります。

全体の Verified 表示は、[共有 presentation policy](../../packages/verification/src/verification/verification-presentation-policy.ts)
が全必須 check と stage の成功、表示準備完了、hard failure と development evidence の不在を
確認した場合に限ります。必要な証拠には実 STARK receipt、expected ImageID、canonical journal、
public input、manifest、close statement、個票の cast / bulletin / bitmap evidence が含まれます。
STH source を設定した場合はその consensus も必須です。未実行・欠落・進行中の必須 check、
除外 slot や rejected record、期待票数と tree size の不一致は成功を阻みます。
mock は UI / API test evidence、Fake receipt は RISC Zero integration 用の development evidence
であり、どちらも production STARK proof correctness の証拠ではありません。
