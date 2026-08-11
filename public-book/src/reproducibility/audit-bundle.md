# ZIP ローカル検証（Ubuntu）

この手順は、検証ページでダウンロードした `bundle.zip` を対象に、Ubuntu 上で第三者が行える最小監査のガイドです。
確認できるのは [第三者検証ガイド](index.md) の不変条件表にある範囲であり、`/verify` UI の総合 Verified 判定の代替ではありません。

各 Step の概要は次のとおりです。

| Step | 確認内容                                         | 必要ツール                         |
| ---- | ------------------------------------------------ | ---------------------------------- |
| 1    | Ubuntu セットアップ（Rust toolchain の導入）     | `apt`、`rustup`                    |
| 2    | production-feature `verifier-service` の build   | Rust toolchain                     |
| 3    | `bundle.zip` の admission と展開                 | Node.js / pnpm、`unzip`            |
| 4    | 期待 Image ID の決定                             | Node.js / pnpm、`jq`               |
| 5    | STARK レシートの検証                             | Step 2 の `verifier-service`、`jq` |
| 6    | receipt と `journal.json` の結合・完全性チェック | Node.js / pnpm、`jq`               |
| 7    | 公開監査アーティファクトの整合性チェック         | Node.js / pnpm                     |
| 8    | `inputCommitment` 再計算                         | Node.js / pnpm、`jq`               |

## 0. 前提

ツール要件:

- Ubuntu 22.04 / 24.04
- Node.js 24 と Corepack 経由の pnpm 11.x

実行済みであること:

- 検証ページから `bundle.zip` をダウンロード済みであること
- このリポジトリ（`stark-ballot-simulator`）のソースを取得済みであること
- `$REPO_ROOT` で `corepack enable` と `pnpm install --frozen-lockfile` を実行済みであること

必要になる Step:

- Node.js / pnpm 前提は Step 3、Step 4、Step 6、Step 7、Step 8 で必要（Step ごとの必要ツールは冒頭の概要表を参照）

> 手順の前提（ソース取得やビルドが必要なステップ）は、リポジトリが公開されるまで実行できません。
> 詳細は [第三者検証ガイド](index.md) を参照してください。

`bundle.zip` の通常の取得経路は capability 保護 API であり、raw S3 URL や presigned URL は通常のブラウザと CLI 契約ではありません。
`public` の意味と境界は [公開境界](../verification/public-boundary.md)、現行レスポンスに含まれない旧 URL フィールドの扱いは [API エンドポイント一覧](../api/endpoints.md#現行-response-で返さない-legacy-フィールド) を参照してください。

以降の手順では、リポジトリルートを `REPO_ROOT` として扱います。
実際のクローン先に合わせて先に設定してください。

```bash
export REPO_ROOT="$HOME/stark-ballot-simulator"
export AUDIT_ROOT="$HOME/stark-audit"
cd "$REPO_ROOT"
```

## 1. Ubuntu セットアップ（Rust）

```bash
sudo apt update
sudo apt install -y build-essential pkg-config libssl-dev unzip jq curl ca-certificates

curl https://sh.rustup.rs -sSf | sh -s -- -y
source "$HOME/.cargo/env"

RUST_CHANNEL="$(awk -F'\"' '/^channel *=/ {print $2}' "$REPO_ROOT/rust-toolchain.toml")"
rustup toolchain install "$RUST_CHANNEL"
rustup default "$RUST_CHANNEL"
echo "rust_channel=$RUST_CHANNEL"

rustc --version
cargo --version
```

## 2. verifier-service をビルド

```bash
cd "$REPO_ROOT/verifier-service"
cargo build --release --features production
```

この監査では production-feature build を使用します。`production` feature は
`risc0-zkvm/disable-dev-mode` を有効にし、production STARK proof の検証境界と一致させます。
fake receipt を診断できる dev-mode-capable build（`cargo build --release`）は、この手順の合格証拠には使用しません。

生成物:

- `verifier-service/target/release/verifier-service`

## 3. bundle.zip を admission して展開

```bash
mkdir -p "$AUDIT_ROOT"
cp ~/Downloads/stark-ballot-verification-*.zip "$AUDIT_ROOT/bundle.zip"
cd "$REPO_ROOT"

pnpm tsx -e "
import { inspectVerificationBundleArchiveFile } from './packages/node-adapters/src/verification-bundle';
import { resolvePublicBundlePolicy } from './packages/verification/src/verification/public-bundle-manifest';

const archivePath = process.argv[1];

void (async () => {
  const failures = [];
  for (const mode of ['sync', 'async']) {
    try {
      const inspection = await inspectVerificationBundleArchiveFile(
        archivePath,
        resolvePublicBundlePolicy(mode),
      );
      console.log(JSON.stringify({ bundle_manifest: 'ok', mode, members: inspection.members }, null, 2));
      return;
    } catch (error) {
      failures.push({ mode, error: error instanceof Error ? error.message : String(error) });
    }
  }

  console.error(JSON.stringify({ bundle_manifest: 'ng', failures }, null, 2));
  process.exitCode = 1;
})();
" "$AUDIT_ROOT/bundle.zip"

if [ "$?" -ne 0 ]; then
  echo 'bundle manifest admission failed'
  exit 1
fi

cd "$AUDIT_ROOT"

unzip -o bundle.zip -d bundle
ls -1 bundle
```

admission は、mode-aware な default-deny manifest に従って次を検査します。

- sync bundle: 下記 5 ファイルと `metadata.json` が必須。`sth.json` と `consistency-proof.json` だけが任意
- async bundle: 下記 5 ファイルだけが必須かつ許可対象
- 両 mode: 必須 member の欠落、未登録または非公開 member、duplicate、case conflict、traversal・absolute・非 canonical path は不合格

両 mode で共通して必要なファイルは次のとおりです。

- `bundle/receipt.json`
- `bundle/journal.json`
- `bundle/public-input.json`
- `bundle/election-manifest.json`
- `bundle/close-statement.json`

`metadata.json` は sync bundle では必須で、async bundle には含まれません。
`bundle_manifest="ok"` が出力されるまで ZIP を展開せず、admission が失敗した ZIP を以降の証拠として扱わないでください。

## 4. 期待 Image ID を決定

Step 4 では `public/imageId-mapping.json` から、`verifier-service` に渡す期待 Image ID を決めます。
variant は検証対象の成果物に合わせて選びます（trust material の対応は [Image ID > variant とアーキテクチャ](../zkvm/image-id.md#variant-とアーキテクチャ) を参照）。

| 検証対象の成果物                               | variant 指定                                     |
| ---------------------------------------------- | ------------------------------------------------ |
| target-account prover image（default / ARM64） | 未指定または `EXPECTED_IMAGE_ID_VARIANT=default` |
| local / CI production-feature build（x86_64）  | `EXPECTED_IMAGE_ID_VARIANT=x86_64`               |

アプリ側と同様に、次のいずれかに該当する場合は暗黙のフォールバックを行わず [fail-closed](../appendix/glossary.md#fail-closed) で停止します。

- `journal.json` の `methodVersion` が `CURRENT_METHOD_VERSION` と一致しない
- mapping が欠落している、または unsupported variant を指定した
- 選択した variant の Image ID が欠落している
- 選択した authority が `unconfirmed`（別 variant へフォールバックしない）

```bash
METHOD_VERSION="$(jq -r '.methodVersion' bundle/journal.json)"
CURRENT_METHOD_VERSION="$(awk -F'= ' '/export const CURRENT_METHOD_VERSION/ {print $2; exit}' "$REPO_ROOT/packages/zkvm-contract/src/zkvm/types.ts" | tr -d ';[:space:]')"

if [ "$METHOD_VERSION" != "$CURRENT_METHOD_VERSION" ]; then
  echo "methodVersion=$METHOD_VERSION is not the current supported contract ($CURRENT_METHOD_VERSION)"
  exit 1
fi

export EXPECTED_IMAGE_ID_VARIANT=default
EXPECTED_IMAGE_ID="$(
  node "$REPO_ROOT/verifier-service/scripts/read-image-id.mjs" \
    "$REPO_ROOT/public/imageId-mapping.json"
)"
RECEIPT_IMAGE_ID="$(jq -r '.image_id // .imageId // .receipt.image_id // .receipt.imageId // empty' bundle/receipt.json | tr '[:upper:]' '[:lower:]')"

if [ -z "$EXPECTED_IMAGE_ID" ]; then
  echo "expected Image ID could not be resolved from imageId-mapping.json"
  exit 1
fi

echo "methodVersion=$METHOD_VERSION"
echo "imageIdVariant=$EXPECTED_IMAGE_ID_VARIANT"
echo "receiptImageId=$RECEIPT_IMAGE_ID"
echo "expectedImageId=$EXPECTED_IMAGE_ID"
```

local / CI production-feature build の成果物を検証する場合だけ、上の `export` を次のように置き換えます。

```bash
export EXPECTED_IMAGE_ID_VARIANT=x86_64
```

`verifier-service/scripts/read-image-id.mjs` は `EXPECTED_IMAGE_ID_VARIANT=default` または未指定の場合に `variants.default`、`EXPECTED_IMAGE_ID_VARIANT=x86_64` の場合に `variants.x86_64` を解決します（fail-closed 条件は本 Step 冒頭のリスト参照）。
`verifier-service` 本体は `EXPECTED_IMAGE_ID_VARIANT` を直接読みません。
Step 5 では、ここで導出した `EXPECTED_IMAGE_ID` を `--image-id` として渡します。
`receipt.json` の Image ID が期待値と一致しない場合は Step 5 で不合格になります。

## 5. STARK レシートを検証

```bash
"$REPO_ROOT/verifier-service/target/release/verifier-service" verify \
  --bundle ./bundle.zip \
  --image-id "$EXPECTED_IMAGE_ID" \
  --output ./verification.json

echo "exit_code=$?"
jq '{status, expected_image_id, receipt_image_id, dev_mode_receipt, errors}' ./verification.json
```

判定:

- `exit_code=0` かつ `status="success"`: 合格
- `exit_code=2` または `status="dev_mode"`: dev-mode のフェイクレシート（production STARK proof ではなく、本番検証としては不合格）
- `exit_code=3` または `status="failed"`: 不合格

## 6. receipt と journal.json の結合・完全性チェック

Step 5 の `verifier-service` は `receipt.json` 内の STARK receipt を検証しますが、ZIP 内で別ファイルになっている
`journal.json` との一致までは検証しません。そのため、最初に receipt 内の journal bytes を現行 contract で
decode し、`journal.json` の全 proof-bound field と一致することを確認します。

```bash
cd "$REPO_ROOT"

pnpm tsx -e "
import fs from 'node:fs';
import { parseJournalBytes } from './packages/verification/src/verification/journal-parser';

const [receiptPath, journalPath] = process.argv.slice(1);
const receiptPayload = JSON.parse(fs.readFileSync(receiptPath, 'utf-8'));
const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
const journalBytes = receiptPayload?.receipt?.journal?.bytes ?? receiptPayload?.journal?.bytes;

if (
  !Array.isArray(journalBytes) ||
  !journalBytes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
) {
  console.error('receipt journal bytes are missing or invalid');
  process.exit(1);
}

const receiptJournal = parseJournalBytes(journalBytes);
const hexFields = new Set([
  'electionConfigHash',
  'bulletinRoot',
  'sthDigest',
  'seenBitmapRoot',
  'includedBitmapRoot',
  'inputCommitment',
]);
const proofBoundFields = [
  'electionId',
  'electionConfigHash',
  'bulletinRoot',
  'treeSize',
  'totalExpected',
  'sthDigest',
  'verifiedTally',
  'totalVotes',
  'validVotes',
  'invalidVotes',
  'seenIndicesCount',
  'missingSlots',
  'invalidPresentedSlots',
  'rejectedRecords',
  'seenBitmapRoot',
  'includedBitmapRoot',
  'excludedSlots',
  'inputCommitment',
  'methodVersion',
];
const normalizeHex = (value) => String(value).replace(/^0x/i, '').toLowerCase();
const mismatches = proofBoundFields.filter((field) => {
  const receiptValue = receiptJournal[field];
  const journalValue = journal[field];
  if (hexFields.has(field)) {
    return (
      typeof receiptValue !== 'string' ||
      typeof journalValue !== 'string' ||
      normalizeHex(receiptValue) !== normalizeHex(journalValue)
    );
  }
  return JSON.stringify(receiptValue) !== JSON.stringify(journalValue);
});

console.log(JSON.stringify({ receipt_journal_matches: mismatches.length === 0, mismatches }, null, 2));
process.exit(mismatches.length === 0 ? 0 : 1);
" \
  "$AUDIT_ROOT/bundle/receipt.json" \
  "$AUDIT_ROOT/bundle/journal.json"

echo "exit_code=$?"
cd "$AUDIT_ROOT"
```

判定:

- `exit_code=0` かつ `receipt_journal_matches=true`: receipt で暗号学的に検証された journal と `journal.json` が一致
- `exit_code!=0` または `mismatches` が空でない: 不合格。以降の `journal.json` を proof-bound evidence として扱わない

結合を確認した後、Counted 段階の count と tally の必須条件を確認します。

```bash
jq '{excludedSlots, missingSlots, invalidPresentedSlots, rejectedRecords, totalExpected, treeSize, totalVotes, validVotes, verifiedTally}' bundle/journal.json

jq -e '.excludedSlots == 0 and .missingSlots == 0 and .invalidPresentedSlots == 0' bundle/journal.json >/dev/null \
  && echo 'integrity_counts=ok' \
  || echo 'integrity_counts=ng'

jq -e '.totalExpected == .treeSize' bundle/journal.json >/dev/null \
  && echo 'expected_vs_tree=ok' \
  || echo 'expected_vs_tree=ng'

jq -e '.totalVotes | type == "number" and . > 0 and floor == .' bundle/journal.json >/dev/null \
  && echo 'total_votes_positive=ok' \
  || echo 'total_votes_positive=ng'

jq -e '(.verifiedTally | add) == .validVotes' bundle/journal.json >/dev/null \
  && echo 'tally_sum=ok' \
  || echo 'tally_sum=ng'
```

`ng` が 1 つでも出力された場合は、現行の必須チェックを満たしていないため検証失敗として扱います。

## 7. 公開監査アーティファクトの整合性チェック

`public-input.json`、`election-manifest.json`、`close-statement.json` は `bundle.zip` に含まれる Counted 段階の必須チェック対象です。
次の 4 点を確認します（フィールド単位の詳細はスクリプト内の `checks` 参照）。

- `public-input.json` が現行 contract に沿い、vote entry、重複 index、commitment、`journal.json` の各フィールドと矛盾しない
- `election-manifest.json` の `electionConfigHash` 再計算値が宣言値、`public-input.json`、`journal.json` と一致する
- `close-statement.json` の `sthDigest` 再計算値が宣言値、`public-input.json`、`journal.json` と一致する
- `journal.json` と `public-input.json` の `methodVersion` が現行 contract と一致する

```bash
cd "$REPO_ROOT"

pnpm tsx -e "
import fs from 'node:fs';
import { buildCloseStatement, recomputeElectionManifestHash } from './packages/verification/src/verification/public-audit-artifacts';
import { parsePublicInputArtifact } from './packages/verification/src/verification/public-input-contract';
import { CURRENT_METHOD_VERSION } from './packages/zkvm-contract/src/zkvm/types';

const [manifestPath, closePath, journalPath, publicInputPath] = process.argv.slice(1);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
const closeStatement = JSON.parse(fs.readFileSync(closePath, 'utf-8'));
const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
const publicInput = JSON.parse(fs.readFileSync(publicInputPath, 'utf-8'));

const parsedPublicInput = parsePublicInputArtifact(publicInput, { source: 'bundle' });
const publicAuthority = parsedPublicInput.typedAuthority;

const normalizeHex = (value) => String(value).replace(/^0x/i, '').toLowerCase();
const sameHex = (left, right) =>
  typeof left === 'string' && typeof right === 'string' && normalizeHex(left) === normalizeHex(right);
const sameNumber = (left, right) => typeof left === 'number' && typeof right === 'number' && left === right;

const recomputedManifestHash = recomputeElectionManifestHash(manifest);
const rebuiltCloseStatement = buildCloseStatement({
  logId: closeStatement.logId,
  treeSize: closeStatement.treeSize,
  timestamp: closeStatement.timestamp,
  bulletinRoot: closeStatement.bulletinRoot,
});

const checks = {
  public_input_contract_ok: parsedPublicInput.valid && Boolean(publicAuthority),
  public_input_current_method_version_ok:
    journal.methodVersion === CURRENT_METHOD_VERSION && publicAuthority?.methodVersion === CURRENT_METHOD_VERSION,
  public_input_election_id_ok: String(publicAuthority?.electionId) === String(journal.electionId),
  public_input_config_hash_ok: sameHex(publicAuthority?.electionConfigHash, journal.electionConfigHash),
  public_input_bulletin_root_ok: sameHex(publicAuthority?.bulletinRoot, journal.bulletinRoot),
  public_input_tree_size_ok: sameNumber(publicAuthority?.treeSize, journal.treeSize),
  public_input_total_expected_ok: sameNumber(publicAuthority?.totalExpected, journal.totalExpected),
  public_input_votes_not_over_tree_size_ok:
    typeof publicAuthority?.votesCount === 'number' &&
    typeof publicAuthority?.treeSize === 'number' &&
    publicAuthority.votesCount <= publicAuthority.treeSize,
  public_input_tree_size_positive_ok:
    typeof publicAuthority?.treeSize === 'number' &&
    Number.isInteger(publicAuthority.treeSize) &&
    publicAuthority.treeSize > 0,
  public_input_bulletin_root_nonzero_ok:
    typeof publicAuthority?.bulletinRoot === 'string' &&
    !/^(?:0x)?0{64}$/i.test(publicAuthority.bulletinRoot),
  public_input_unique_indices_ok: publicAuthority?.uniqueIndices === true,
  public_input_unique_commitments_ok: publicAuthority?.uniqueCommitments === true,
  manifest_hash_ok: sameHex(recomputedManifestHash, manifest.electionConfigHash),
  manifest_election_id_ok:
    String(manifest.electionId) === String(publicAuthority?.electionId) &&
    String(manifest.electionId) === String(journal.electionId),
  manifest_total_expected_ok:
    sameNumber(manifest.totalExpected, publicAuthority?.totalExpected) &&
    sameNumber(manifest.totalExpected, journal.totalExpected),
  manifest_config_hash_ok:
    sameHex(manifest.electionConfigHash, publicAuthority?.electionConfigHash) &&
    sameHex(manifest.electionConfigHash, journal.electionConfigHash),
  close_digest_ok: sameHex(rebuiltCloseStatement.sthDigest, closeStatement.sthDigest),
  close_timestamp_ok: sameNumber(closeStatement.timestamp, publicAuthority?.timestamp),
  close_log_id_ok: sameHex(closeStatement.logId, publicAuthority?.logId),
  close_tree_size_ok:
    sameNumber(closeStatement.treeSize, publicAuthority?.treeSize) &&
    sameNumber(closeStatement.treeSize, journal.treeSize),
  close_bulletin_root_ok:
    sameHex(closeStatement.bulletinRoot, publicAuthority?.bulletinRoot) &&
    sameHex(closeStatement.bulletinRoot, journal.bulletinRoot),
  close_sth_digest_ok: sameHex(closeStatement.sthDigest, journal.sthDigest),
};

console.log(JSON.stringify({ checks, publicInputErrors: parsedPublicInput.errors }, null, 2));
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
" \
  "$AUDIT_ROOT/bundle/election-manifest.json" \
  "$AUDIT_ROOT/bundle/close-statement.json" \
  "$AUDIT_ROOT/bundle/journal.json" \
  "$AUDIT_ROOT/bundle/public-input.json"

echo "exit_code=$?"
```

判定:

- `exit_code=0` かつ全項目が `true`: 合格
- いずれかが `false`: 不合格（対応するチェック ID は [チェック一覧](../verification/checks-catalog.md) を参照）

## 8. inputCommitment 再計算

`public-input.json` から再計算した値が `journal.json` の `inputCommitment` と一致することを確認します。
Step 0 の Node.js と pnpm 前提を満たしてから実行してください。

```bash
RECALC="$(cd "$REPO_ROOT" && pnpm tsx -e "import fs from 'node:fs'; import { computeInputCommitmentFromPublicInput } from './packages/zkvm-contract/src/zkvm/types'; const p = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8')); console.log(computeInputCommitmentFromPublicInput(p));" "$AUDIT_ROOT/bundle/public-input.json")"
JOURNAL_COMMITMENT="$(jq -r '.inputCommitment' "$AUDIT_ROOT/bundle/journal.json")"

echo "recalculated=$RECALC"
echo "journal=$JOURNAL_COMMITMENT"

[ "${RECALC,,}" = "${JOURNAL_COMMITMENT,,}" ] && echo 'input_commitment=ok' || echo 'input_commitment=ng'
```

## 合格条件

- Step 3 の archive admission が `bundle_manifest="ok"` になる
- Step 4 で `EXPECTED_IMAGE_ID` を決定できる
- Step 5 から Step 8 の判定がすべて合格

いずれかが失敗した場合、Counted 段階または STARK 段階の必須チェックを満たしていないため `Verified` にはなりません。
すべて合格しても確認できたのは `bundle.zip` の不変条件までであり、`/verify` UI の総合 Verified 判定そのものの再現ではありません（範囲外や `bundle.zip` 単体では揃わない検証材料は [第三者検証ガイド](index.md) を参照）。

<!-- source: apps/web/src/routes/verify/page.tsx, apps/web/src/routes/verify/lib/verification-data.ts, apps/web/src/routes/verify/lib/download.ts, apps/api/src/server/api/handlers/verify.ts, apps/api/src/server/api/handlers/verificationBundles.ts, packages/node-adapters/src/verification-bundle.ts, packages/verification/src/verification/public-bundle-manifest.json, packages/verification/src/verification/public-bundle-manifest.ts, packages/verification/src/verification/verification-bundle.ts, packages/verification/src/verification/public-audit-artifacts.ts, packages/verification/src/verification/verification-checks.ts, packages/verification/src/verification/engine/evaluate-checks.ts, infra/docker/entrypoint.sh, verifier-service/Cargo.toml, verifier-service/src/lib.rs, public/imageId-mapping.json, packages/zkvm-contract/src/zkvm/types.ts -->
