# STARK証明検証テストガイド

このドキュメントでは、STARK Ballot Simulator で STARK 証明の生成と receipt 検証を確認するための、
現行 CLI / host / `verifier-service` の使い分けを説明します。mock と development receipt は
production STARK proof の証拠ではありません。

## テスト経路と build を選ぶ

| 目的                              | 実行 profile / 証拠                                          | 事前 build                                                           | 実行コマンド                   |
| --------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------ |
| 最速の application E2E            | `static-mock-e2e` / mock artifact                            | Rust build 不要。CLI が `pnpm build:local-mock` を実行               | `pnpm test:cli:mock`           |
| TypeScript / Rust contract の確認 | `local-proof-development` / fake development receipt         | `pnpm build:zkvm:dev-mode` と `pnpm build:verifier-service:dev-mode` | `pnpm test:cli:real-dev`       |
| host fixture の低レベル診断       | host を `RISC0_DEV_MODE=1` で実行 / fake development receipt | `pnpm build:zkvm:dev-mode`                                           | `./scripts/tests/test-zkvm.sh` |
| production proof smoke            | `local-proof-production` / production RISC Zero receipt      | `pnpm build:zkvm` と `pnpm build:verifier-service`                   | `pnpm test:cli:real-prod:s0`   |

`RISC0_DEV_MODE=1` は development build で fake receipt を生成するための設定です。production feature
付きの host / verifier binary は dev mode を拒否します。`test-zkvm.sh` は host binary がない場合だけ
development build を行うため、production binary を直前に build した場合は、先に
`pnpm build:zkvm:dev-mode` で置き換えてください。

production proof は環境により数分かかります。64票では約6分が目安ですが、保証値ではありません。

## CLI E2E workflow

CLI harness は session 作成、投票、finalize、verification resource の確認、capability-protected artifact
の download、receipt 検証までを browser なしで実行します。

```bash
# mock S0、choice A
pnpm test:cli:mock

# direct harness。scenario 未指定時は S0 + S1
pnpm test:cli -- --user-choice A

# mock の S0-S5 matrix
pnpm test:cli -- --user-choice A --all-scenarios

# real zkVM + fake development receipt、S0
pnpm test:cli:real-dev

# real zkVM + production STARK、S0
pnpm test:cli:real-prod:s0
```

`pnpm test:cli:mock` は package script で `--user-choice A --scenario S0` を指定します。その他の choice
や scenario を選ぶ場合は direct harness を使います。全 option は [CLI guide](./cli.md) を参照してください。

CLI が server を所有する場合、実行前に選択した local runtime profile で `pnpm build:local-mock` を実行します。
`--skip-build` はこの build を省略して既存の `dist/` を再利用します。`dist/` が存在し、今回の CLI run と
同じ `VITE_RUNTIME_PROFILE` で生成されたことを確認できる場合だけ指定してください。

```bash
pnpm test:cli -- --user-choice A --skip-build
```

local adapter 経由の real host 実行には600秒の期限があります。期限到達やhost終了時は、所有する
POSIX process group に SIGTERM を送り、5秒後に SIGKILL、さらに1秒の終了確認待ちを行います。
process group の終了を確認できなければ成功にはしません。この期限管理は、host CLI や
`test-zkvm.sh` の直接実行には適用されません。

real-mode CLI の finalize HTTP 待ちは既定900秒、最低636秒です。`CLI_FINALIZE_TIMEOUT_MS` に
短い値を指定しても、host期限600秒、終了処理6秒、応答余裕30秒を確保します。HTTP待ちを延ばしても
hostの期限は延びません。失敗時はhostの期限・外部signal・非zero exitを区別し、CLI report の
requested/effective timeout と実行条件を確認してください。保存先と収録範囲は
[CLI guide の Run Evidence and Failures](./cli.md#run-evidence-and-failures) にまとめています。

## Custom host input の上限

host は proving を始める前に serialized size と shared contract / structural budget を検証し、guest は
contract / structural budget を journal field の emit 前に再検証します。

| Input / budget                     | 現行上限                   | Enforcement  |
| ---------------------------------- | -------------------------- | ------------ |
| `tree_size`                        | `1..=1,000,000`            | host / guest |
| `total_expected`                   | `1,000,000` 以下           | host / guest |
| 提示 vote record 数                | `1,000,000` 以下           | host / guest |
| 1 record の Merkle path node 数    | `u16::MAX`（`65,535`）以下 | host / guest |
| 全 record の Merkle path node 合計 | `1,000,000` 以下           | host / guest |
| structural byte estimate           | `64 MiB` 以下              | host / guest |
| input file の serialized size      | `64 MiB` 以下              | host         |

候補ごとの tally も提示 vote 数を超えず、guest は counter overflow と `1,000,000` 超過を拒否します。
上限違反は journal field を emit する前に失敗します。

## Host fixture の低レベル診断

`scripts/tests/test-zkvm.sh` は `zkvm/test-data/test-fixture-valid.json` と
`zkvm/test-data/test-fixture-tampered.json` を development host に渡します。これは application E2E や
production proof の代替ではありません。

```bash
pnpm build:zkvm:dev-mode
./scripts/tests/test-zkvm.sh
```

実行後、host は同じ directory に `*-output.json`、`*-receipt.json`、bitmap artifact を生成します。
これらは checked-in fixture ではなく local artifact です。

## Journal artifact を区別する

同じ guest output に由来していても、次の表現は交換可能ではありません。

| 表現                                        | 内容と用途                                                                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*-receipt.json` / bundle の `receipt.json` | RISC Zero receipt envelope。内部の `receipt.journal.bytes` は RISC Zero serde encoding であり、TypeScript で固定 offset として解釈しない                   |
| host の `*-output.json`                     | host が `receipt.journal.decode::<VerificationOutput>()` した結果と host-provided `imageId`。UUID/hash field は byte array のままの camelCase JSON         |
| `decode-journal` の出力                     | production検証に成功したreceiptをRust serdeでdecodeしたhost形式JSON。UUID/hash field は byte array、`imageId` は検証済みreceipt envelope由来               |
| bundle の `journal.json`                    | UUID/hash field を文字列化した canonical public artifact。sync は TypeScript の `toPublicZkvmJournal()`、async は Rust の `public_journal()` がprojectする |

bundle journal の `imageId` は比較用metadataです。journal単体の存在やhostのdecode成功はreceipt検証の
代わりにはなりません。receipt journal bytes のencodingは RISC Zero 3.0.6 のserde実装が所有し、
Rustの `Journal::decode` で解釈します。

実際の serde round-trip と host JSON projection は Rust owner の test で確認します。

```bash
pnpm rust:zkvm:test
pnpm --filter @stark-ballot/zkvm-contract test
```

logical `VerificationOutput` は `methodVersion=14` で次の field 順序を持ちます。型と配列長は
`zkvm/contract-core/src/types.rs` に従います。以下はserialized byte offsetの表ではありません。

1. `electionId` (16 bytes)
2. `electionConfigHash` (32 bytes)
3. `bulletinRoot` (32 bytes)
4. `treeSize` (u32)
5. `totalExpected` (u32)
6. `sthDigest` (32 bytes)
7. `verifiedTally` (5 x u32)
8. `totalVotes` (u32)
9. `validVotes` (u32)
10. `invalidVotes` (u32)
11. `seenIndicesCount` (u32)
12. `missingSlots` (u32)
13. `invalidPresentedSlots` (u32)
14. `rejectedRecords` (u32)
15. `seenBitmapRoot` (32 bytes)
16. `includedBitmapRoot` (32 bytes)
17. `excludedSlots` (u32)
18. `inputCommitment` (32 bytes)
19. `methodVersion` (u32、現行は `14`)

host fixture の decoded output は次のように確認できます。

```bash
pnpm tsx -e "import fs from 'node:fs'; const output = JSON.parse(fs.readFileSync('zkvm/test-data/test-fixture-valid-output.json','utf-8')); console.log({ methodVersion: output.methodVersion, excludedSlots: output.excludedSlots, rejectedRecords: output.rejectedRecords, inputCommitment: output.inputCommitment });"
```

production receiptからfieldを確認する場合は、`verifier-service` の `decode-journal` を使います。
次はlocal x86_64 receiptの例です。対象を生成したguest buildに一致するexpected ImageIDを指定します。

```bash
export EXPECTED_IMAGE_ID="$(node verifier-service/scripts/read-image-id.mjs public/imageId-mapping.json --variant x86_64)"

./verifier-service/target/release/verifier-service decode-journal \
  --bundle /path/to/bundle-or-receipt \
  --output /path/to/decoded-host-output.json --quiet
```

このcommandはreceiptを一度読み、そのreceiptのproduction検証成功後にcurrent methodのjournalを
decodeします。fake receipt、検証失敗、ImageID欠落、非current methodではdecoded JSONを出力しません。
出力先はbundleの `journal.json` と別にしてください。host形式のbyte arrayを保持するためです。

## Bundle から receipt / ImageID を検証する

`/verify` page は session capability を使って、current finalization の bundle を download します。CLI も
finalize response の top-level `finalizationId` から次の capability-protected endpoint を組み立て、
`X-Session-Capability` を送信します。

```text
/api/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle
```

CLI が download した zip は次の path に保存されます。CLI output では URL ではなく、authenticated delivery、
extract した local directory、SHA-256 digest を確認します。

```text
.tmp/cli-bundles/<sessionId>/bundle-authenticated-endpoint-<epoch-ms>-<uuid>.zip
```

local x86_64 build の receipt を手動で検証する場合は、同じ guest build の ImageID variant を明示します。

```bash
export EXPECTED_IMAGE_ID="$(node verifier-service/scripts/read-image-id.mjs public/imageId-mapping.json --variant x86_64)"

./verifier-service/target/release/verifier-service verify /path/to/bundle-or-receipt
```

checked-in `public/imageId-mapping.json` の現行 methodVersion `14` では、変更後のguestに対応する
`default` は承認済みのmanaged ARM64 Prover releaseを根拠に `confirmed` です。
`x86_64` は新しい出力先で行ったlocal production guest buildから独立にconfirmedです。
通常のApp deploymentは選択したProver releaseとdefaultの一致を確認します。稼働中deploymentの
receiptを検証する場合は、そのreleaseに対応するソースとconfirmed variantを使ってください。
variant間のfallbackはありません。

`verifier-service` が bundle directory または zip を受け取った場合、内部の `receipt.json` を探して
`Receipt::verify(expectedImageId)` と top-level `image_id` の一致を検証します。これは **bundle 内の
receipt / ImageID 検証** であり、`journal.json`、`public-input.json`、election manifest、close statement
などを含む whole-bundle integrity 検証ではありません。application 全体の verdict には
[Verification pipeline](../verification/README.md) に定義された全 required check が必要です。

verifier の主な結果は次のとおりです。

| Exit code / status | 意味                                               |
| ------------------ | -------------------------------------------------- |
| `0` / `success`    | production receipt と expected ImageID の検証成功  |
| `2` / `dev_mode`   | fake receipt を検出し、production proof として拒否 |
| `3` / `failed`     | receipt または ImageID の検証失敗                  |

ImageID mismatch の場合は `public/imageId-mapping.json` の method version、variant、state を確認します。
production receiptがあれば、hostを再実行せず上記の `decode-journal` でfieldを確認できます。
fake receiptの診断には、development hostが生成した `*-output.json` を使います。

## 関連資料

- [CLI guide](./cli.md)
- [Verification pipeline](../verification/README.md)
- [verifier-service README](../../verifier-service/README.md)
- [zkVM documentation](../zkvm/README.md)
- [RISC Zero セットアップ](./risc0-setup.md)
- [STARK proof structure](../zkvm/stark-proof-structure.md)
