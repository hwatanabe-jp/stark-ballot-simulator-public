# STARK証明検証テストガイド

このドキュメントでは、STARK Ballot Simulatorで **STARK証明の生成・検証を現行のCLI/スクリプトで確認する方法** をまとめます。

## 前提

- `RISC0_DEV_MODE=1` は **Fake receipt** のみ生成します（実証明ではありません）。
- 実際のSTARK証明は **数分（64票で約6分）** かかります。
- まずは `pnpm build:zkvm` と `pnpm build:verifier-service` を済ませておくとスムーズです。

## 1. 推奨: CLI E2E テスト

エンドツーエンドで最も確実な確認方法です。詳細は `docs/current/tests/cli.md` を参照してください。

```bash
# モック（最速）
pnpm test:cli:mock

# 実zkVM + dev receipts
pnpm test:cli:real-dev

# 実zkVM + 本番STARK（S0のみ）
pnpm test:cli:real-prod:s0

# 直接ハーネス起動（ユーザー票指定）
pnpm test:cli -- --user-choice A
```

補足:

- `pnpm test:cli -- --user-choice A` はデフォルトで S0 + S1 を実行します。
- `pnpm test:cli:mock` は package script 側で `--scenario S0` を指定しています。モックの S0-S5 matrix を回す場合は
  `docs/current/tests/cli.md` の直接ハーネス例を参照してください。
- `--skip-build` は既存の `next build` 出力を再利用するオプションです。出力がない場合は指定しないでください。

## 2. zkVM 単体スモークテスト（dev mode）

簡易スモークとして `scripts/tests/test-zkvm.sh` を使用します。テストデータは `zkvm/test-data/test-fixture-*.json` を使います。

```bash
./scripts/tests/test-zkvm.sh
```

## 3. Receipt / Journal 解析

### 3.1 Journal の正しいパース方法

Journal の byte-level 解析は `src/lib/verification/journal-parser.ts` が **正** です。現行 contract の確認はまず `src/lib/verification/journal-parser.test.ts` を使ってください。

```bash
pnpm vitest run src/lib/verification/journal-parser.test.ts
```

`zkvm/test-data/*-receipt.json` と `*-output.json` は checked-in fixture ではなく、host 実行で生成されるローカル artifact です。現行の
`parseJournalBytes()` にそのまま渡せる 272-byte journal とも限りません。手早く現行 field を確認したい場合は、
`./scripts/tests/test-zkvm.sh` または host CLI 実行後に生成された `*-output.json` を参照します。検証 bundle では、
`receipt.json` ではなく canonical な `journal.json` が公開 journal field の確認入口です。

```bash
# ./scripts/tests/test-zkvm.sh 実行後の生成物を読む例
pnpm tsx -e "import fs from 'node:fs'; const output = JSON.parse(fs.readFileSync('zkvm/test-data/test-fixture-valid-output.json','utf-8')); console.log({ methodVersion: output.methodVersion, excludedSlots: output.excludedSlots, rejectedRecords: output.rejectedRecords, inputCommitment: output.inputCommitment });"
```

`parseJournalBytes()` を手元で直接叩く対象は、unit test と同じ 272-byte 固定レイアウトの journal bytes に限ってください。RISC Zero の receipt 内部 journal や bundle の `receipt.json` は serde / receipt wrapper 由来の形式を含むため、272-byte parser の入力としては扱わないでください。

> `scripts/analyze-stark-receipt.js`、`scripts/verification/test-cli.sh`、`scripts/verification/verify-single.js` は
> legacy / manual helper です。`test-cli.sh` は意図的に disabled で、`verify-single.js` は fixture 形状確認のみを行います。現行の
> `{ receipt: ..., image_id: ... }` wrapper、journal layout、receipt 種別、数値、または暗号学的検証の判断には使わないでください。

### 3.2 Journal フォーマット（現行: methodVersion 12）

`parseJournalBytes` は現行実装で `methodVersion=12` のみ受け付けます。順序・サイズは以下です（272 bytes 固定）：

1. `electionId` (16 bytes)
2. `electionConfigHash` (32 bytes)
3. `bulletinRoot` (32 bytes)
4. `treeSize` (u32 LE)
5. `totalExpected` (u32 LE)
6. `sthDigest` (32 bytes)
7. `verifiedTally` (5 x u32 LE)
8. `totalVotes` (u32 LE)
9. `validVotes` (u32 LE)
10. `invalidVotes` (u32 LE)
11. `seenIndicesCount` (u32 LE)
12. `missingSlots` (u32 LE)
13. `invalidPresentedSlots` (u32 LE)
14. `rejectedRecords` (u32 LE)
15. `seenBitmapRoot` (32 bytes)
16. `includedBitmapRoot` (32 bytes)
17. `excludedSlots` (u32 LE)
18. `inputCommitment` (32 bytes)
19. `methodVersion` (u32 LE, 現行は `12`)

## 4. Bundle 検証（verifier-service）

`verifier-service` で bundle を検証できます。bundle は `/verify` ページやCLIの出力URLから取得します。

```bash
# Deployed / AWS-native verification
export EXPECTED_IMAGE_ID="$(node verifier-service/scripts/read-image-id.mjs public/imageId-mapping.json --variant default)"

# Local x86_64 / WSL verification
export EXPECTED_IMAGE_ID="$(node verifier-service/scripts/read-image-id.mjs public/imageId-mapping.json --variant x86_64)"

./verifier-service/target/release/verifier-service verify /path/to/bundle-or-receipt
```

`public/imageId-mapping.json` には `expectedImageID` と `expectedImageID_x86_64` の両方があり、環境に応じて使い分けが必要です。詳細は `verifier-service/README.md` を参照してください。

## トラブルシューティング

- **遅い**: 本番STARKは数分かかります。開発時は `RISC0_DEV_MODE=1` を使用してください。
- **検証失敗**: ImageID の不一致がないか `public/imageId-mapping.json` を確認してください。
- **Fake receipt**: `RISC0_DEV_MODE=1` の結果は本番検証では失敗します。
- **`*-output.json` がない**: `./scripts/tests/test-zkvm.sh` または `zkvm/target/release/host` を先に実行して、ローカル生成物を作成してください。
