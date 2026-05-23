# ZIP ローカル検証（Ubuntu）

この手順は、検証ページでダウンロードした `bundle.zip` を対象に、Ubuntu 上で第三者が行える最小監査のガイドです。

## 0. 前提

- 検証ページから `bundle.zip` をダウンロード済みであること
- Ubuntu 22.04 / 24.04
- このリポジトリ（`stark-ballot-simulator`）のソースを取得済みであること
- Node.js 24 と Corepack 経由の pnpm 11.x が利用可能で、`$REPO_ROOT` で `corepack enable` と `pnpm install --frozen-lockfile` を実行済みであること（Step 7–8 のみ必要）

> 手順の前提（ソース取得やビルドが必要なステップ）は、リポジトリが公開されるまで実行できません。詳細は [第三者検証ガイド](index.md) を参照してください。

ここで扱う `public` は「秘密データを含まない配布対象」を指し、無認証取得を意味しません。取得経路（capability エンドポイントと短命な presigned URL）と、現行レスポンスに含まれない旧 URL フィールドの扱いは、それぞれ [バンドル構造](../verification/bundle-structure.md) と [API エンドポイント一覧](../api/endpoints.md#現行-response-で返さない-legacy-フィールド) を参照してください。

以降の手順では、リポジトリルートを `REPO_ROOT` として扱います。実際のクローン先に合わせて先に設定してください。

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
cargo build --release
```

生成物:

- `verifier-service/target/release/verifier-service`

## 3. bundle.zip を展開

```bash
mkdir -p "$AUDIT_ROOT"
cp ~/Downloads/stark-ballot-verification-*.zip "$AUDIT_ROOT/bundle.zip"
cd "$AUDIT_ROOT"

unzip -o bundle.zip -d bundle
ls -1 bundle
```

最低限、以下のファイルが必要です。

- `bundle/receipt.json`
- `bundle/journal.json`
- `bundle/public-input.json`
- `bundle/election-manifest.json`
- `bundle/close-statement.json`

`metadata.json` は同期モードでのみ含まれる場合があります。

## 4. 期待 Image ID を決定

Step 4 では `receipt.json` の `image_id` が `public/imageId-mapping.json` のどの variant に該当するかを判定し、`verifier-service` に渡す Image ID を決めます。アプリ側と同様に `methodVersion` が `CURRENT_METHOD_VERSION` と一致しない場合は [fail-closed](../appendix/glossary.md#fail-closed) で停止します（アプリ内では `EXPECTED_IMAGE_ID` または `EXPECTED_IMAGE_ID_VARIANT=default|x86_64` で variant を選択します）。

```bash
METHOD_VERSION="$(jq -r '.methodVersion' bundle/journal.json)"
CURRENT_METHOD_VERSION="$(awk -F'= ' '/export const CURRENT_METHOD_VERSION/ {print $2; exit}' "$REPO_ROOT/src/lib/zkvm/types.ts" | tr -d ';[:space:]')"

if [ "$METHOD_VERSION" != "$CURRENT_METHOD_VERSION" ]; then
  echo "methodVersion=$METHOD_VERSION is not the current supported contract ($CURRENT_METHOD_VERSION)"
  exit 1
fi

RECEIPT_IMAGE_ID="$(jq -r '.image_id // .imageId // .receipt.image_id // .receipt.imageId // empty' bundle/receipt.json | tr '[:upper:]' '[:lower:]')"

ARM_IMAGE_ID="$(jq -r --arg v "$METHOD_VERSION" '.mappings[$v].expectedImageID // empty' "$REPO_ROOT/public/imageId-mapping.json" | tr '[:upper:]' '[:lower:]')"
X86_IMAGE_ID="$(jq -r --arg v "$METHOD_VERSION" '.mappings[$v].expectedImageID_x86_64 // empty' "$REPO_ROOT/public/imageId-mapping.json" | tr '[:upper:]' '[:lower:]')"

case "$RECEIPT_IMAGE_ID" in
  "$ARM_IMAGE_ID")
    EXPECTED_IMAGE_ID="$ARM_IMAGE_ID"
    ;;
  "$X86_IMAGE_ID")
    EXPECTED_IMAGE_ID="$X86_IMAGE_ID"
    ;;
  "")
    echo "receipt_image_id is missing; choose the expected Image ID manually"
    exit 1
    ;;
  *)
    echo "receipt_image_id is not present in imageId-mapping.json for methodVersion=$METHOD_VERSION"
    exit 1
    ;;
esac

echo "methodVersion=$METHOD_VERSION"
echo "receiptImageId=$RECEIPT_IMAGE_ID"
echo "expectedImageId=$EXPECTED_IMAGE_ID"
```

通常の本番 bundle では `expectedImageID`（ARM64）が選ばれ、ローカル x86_64 で生成した receipt では `expectedImageID_x86_64` が選ばれます。

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
- `exit_code=2` または `status="dev_mode"`: フェイクレシート（本番検証としては不合格）
- `exit_code=3` または `status="failed"`: 不合格

## 6. journal.json の完全性チェック

```bash
jq '{excludedSlots, missingSlots, invalidPresentedSlots, rejectedRecords, totalExpected, treeSize, totalVotes, validVotes, verifiedTally}' bundle/journal.json

jq -e '.excludedSlots == 0 and .missingSlots == 0 and .invalidPresentedSlots == 0' bundle/journal.json >/dev/null \
  && echo 'integrity_counts=ok' \
  || echo 'integrity_counts=ng'

jq -e '.totalExpected == .treeSize' bundle/journal.json >/dev/null \
  && echo 'expected_vs_tree=ok' \
  || echo 'expected_vs_tree=ng'

jq -e '(.verifiedTally | add) == .validVotes' bundle/journal.json >/dev/null \
  && echo 'tally_sum=ok' \
  || echo 'tally_sum=ng'
```

`excludedSlots > 0` または `missingSlots > 0` または `invalidPresentedSlots > 0` は、検証失敗として扱います。加えて `totalExpected != treeSize` も、現行の必須チェックでは検証失敗です。

## 7. 公開監査アーティファクトの整合性チェック

`public-input.json`、`election-manifest.json`、`close-statement.json` は `bundle.zip` に含まれる Counted 段階の必須チェック対象です。次の 4 点を確認します（フィールド単位の詳細はスクリプト内の `checks` 参照）。

- `public-input.json` が現行 contract に沿い、vote entry / 重複 index / commitment / `journal.json` 各フィールドと矛盾しない
- `election-manifest.json` の `electionConfigHash` 再計算値が宣言値・`public-input.json` / `journal.json` と一致する
- `close-statement.json` の `sthDigest` 再計算値が宣言値・`public-input.json` / `journal.json` と一致する
- `journal.json` と `public-input.json` の `methodVersion` が現行 contract と一致する

```bash
cd "$REPO_ROOT"

pnpm tsx -e "
import fs from 'node:fs';
import { buildCloseStatement, recomputeElectionManifestHash } from './src/lib/verification/public-audit-artifacts';
import { parsePublicInputArtifact } from './src/lib/verification/public-input-contract';
import { CURRENT_METHOD_VERSION } from './src/lib/zkvm/types';

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
- いずれかが `false`: Counted 段階の input sanity / unique index・commitment / election-manifest / close-statement 整合チェック、または public input authority の整合性失敗（チェック ID の対応は [チェック一覧](../verification/checks-catalog.md) 参照）

## 8. inputCommitment 再計算

`public-input.json` から再計算した値が `journal.json` の `inputCommitment` と一致することを確認します。Step 0 の Node.js / pnpm 前提を満たしてから実行してください。

```bash
RECALC="$(cd "$REPO_ROOT" && pnpm tsx -e "import fs from 'node:fs'; import { computeInputCommitmentFromPublicInput } from './src/lib/zkvm/types'; const p = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8')); console.log(computeInputCommitmentFromPublicInput(p));" "$AUDIT_ROOT/bundle/public-input.json")"
JOURNAL_COMMITMENT="$(jq -r '.inputCommitment' "$AUDIT_ROOT/bundle/journal.json")"

echo "recalculated=$RECALC"
echo "journal=$JOURNAL_COMMITMENT"

[ "${RECALC,,}" = "${JOURNAL_COMMITMENT,,}" ] && echo 'input_commitment=ok' || echo 'input_commitment=ng'
```

## 合格条件

- Step 4 で `EXPECTED_IMAGE_ID` を決定できる
- Step 5–8 の判定がすべて緑

いずれかが失敗した場合、Counted / STARK 段階の必須チェックを満たしていないため `Verified` にはなりません。範囲外や `bundle.zip` 単体では揃わない検証材料は [第三者検証ガイド](index.md) を参照してください。

<!-- source: src/app/(routes)/verify/page.tsx, src/app/(routes)/verify/lib/verification-data.ts, src/app/(routes)/verify/lib/download.ts, src/server/api/handlers/verify.ts, src/server/api/handlers/verificationBundles.ts, src/lib/verification/verification-bundle.ts, src/lib/verification/public-audit-artifacts.ts, src/lib/verification/verification-checks.ts, src/lib/verification/engine/evaluate-checks.ts, docker/entrypoint.sh, verifier-service/src/lib.rs, public/imageId-mapping.json, src/lib/zkvm/types.ts -->
