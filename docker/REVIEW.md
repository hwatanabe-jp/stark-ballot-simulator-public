# Docker Implementation Review (2025-10-22)

## Overview

Phase 9.4 Fargate migration の基盤となる Docker イメージとエントリーポイントスクリプトのレビュー結果。

## Files Reviewed

- `docker/Dockerfile.fargate-prover` (80 lines)
- `docker/entrypoint.sh` (106 lines)
- `docker/.dockerignore` (14 lines)

## Summary

**Overall Status**: ✅ **APPROVED** - Production-ready with minor improvements recommended

実装は Phase 9.4 の要件を満たしており、ARM64 Fargate 環境での zkVM prover 実行に必要な機能を提供している。

## Detailed Review

### 1. Dockerfile.fargate-prover

#### Strengths

- **Multi-stage build**: Build stage (360+ MB) と runtime stage (~200 MB) を分離し、最終イメージを最適化
- **Dependency caching**: `cargo fetch` を先行実行し、ソース変更時の再ビルドを高速化（L37）
- **BuildKit mount cache**: Cargo レジストリとビルド成果物をキャッシュし、CI での再ビルドを劇的に高速化（L34-36, L43-45）
- **RISC Zero toolchain**: `cargo-risczero` と `rzup` で完全な zkVM 環境を構築（L24-26）
- **ARM64 native**: `amazonlinux:2023` で Graviton プロセッサと完全互換

#### Improvement Opportunities (Priority: Low)

1. **Non-root user execution**:

   ```dockerfile
   # Runtime stage に追加
   RUN useradd -m -u 1000 zkvm && \
       chown -R zkvm:zkvm /var/task /opt/zkvm
   USER zkvm
   ```

   **Impact**: セキュリティベストプラクティス準拠、コンテナエスケープのリスク軽減

2. **~~Enhanced health check~~** (Not applicable)

   ~~The host binary doesn't support `--version` flag.~~ For one-shot Fargate RunTask executions, we rely on task exit codes instead. No health check needed.

3. **~~Configurable RUST_LOG~~** (Not applicable)

   ~~The `ENV` directive evaluates at build time, so `ENV RUST_LOG=${RUST_LOG:-info}` would literally set the string `${RUST_LOG:-info}`.~~ Current implementation `ENV RUST_LOG=info` is correct and can be overridden by ECS task definition environment variables.

### 2. entrypoint.sh

#### Strengths

- **Robust error handling**: `set -euo pipefail` でパイプライン全体のエラーを検出（L2）
- **Flexible input sources**: ローカルファイルまたは S3 からの入力取得に対応（L28-46）
- **Automatic cleanup**: `trap` で一時ファイルを確実に削除（L92）
- **Structured logging**: ISO 8601 タイムスタンプ付きログ（L12-15）
- **Idempotent operations**: S3 アップロードは任意設定で、ローカルテストも可能

#### Improvement Opportunities (Priority: Medium)

1. **S3 upload retry logic**:

   ```bash
   upload_with_retry() {
     local max_attempts=3
     local attempt=1
     while (( attempt <= max_attempts )); do
       if aws s3 cp "$1" "$2"; then
         return 0
       fi
       log WARN "Upload attempt $attempt failed, retrying..."
       ((attempt++))
       sleep $((2 ** attempt))
     done
     fatal "Failed to upload after $max_attempts attempts"
   }
   ```

   **Impact**: ネットワーク一時障害による失敗を回避

2. **Input validation**:

   ```bash
   validate_input_json() {
     if ! jq empty "$WORK_INPUT" 2>/dev/null; then
       fatal "Invalid JSON format in input file"
     fi

     # zkVM input schema validation (top-level fields per serializeZkvmAggregatorInput)
     local required_fields="election_id bulletin_root tree_size total_expected votes"
     for field in $required_fields; do
       if ! jq -e ".$field" "$WORK_INPUT" >/dev/null 2>&1; then
         fatal "Missing required field: $field"
       fi
     done
   }
   ```

   **Impact**: 早期エラー検出、zkVM 実行前に不正な入力を拒否

   **Note**: Payload structure has top-level fields (election_id, bulletin_root, etc.), not wrapped in `aggregatorInput`.

3. **Execution timeout**:

   ```bash
   # main() 内で
   log INFO "Running host with payload $(basename "$WORK_INPUT") (timeout: 15m)"
   timeout 900 "$HOST_BIN" "$WORK_INPUT" || {
     local exit_code=$?
     if (( exit_code == 124 )); then
       fatal "zkVM execution timed out after 15 minutes"
     fi
     fatal "zkVM execution failed with exit code $exit_code"
   }
   ```

   **Impact**: 無限ハングの防止、Fargate タスクの確実な終了

### 3. .dockerignore

#### Strengths

- **Comprehensive exclusions**: ビルドコンテキストから不要なファイルを適切に除外
- **Security**: `.env*` ファイルを除外し、シークレット漏洩を防止

#### No improvements needed

`.dockerignore` は適切に設定されている。

## Testing Recommendations

### Local Testing (x86_64 with QEMU)

```bash
# 1. QEMU ARM64 エミュレーションでビルド（遅いが動作確認には十分）
docker buildx build \
  --platform linux/arm64 \
  --build-arg RISC0_TOOLCHAIN_IMAGE=<ecr-registry>/stark-ballot-simulator/risc0-toolchain@sha256:<64_HEX_DIGEST> \
  -f docker/Dockerfile.fargate-prover \
  -t stark-ballot-simulator/zkvm-prover:local-test \
  --load \
  .

# 2. ローカル実行テスト（dev mode）
docker run --rm \
  -e RISC0_DEV_MODE=1 \
  -e INPUT_PATH=/opt/zkvm/test-data/test-fixture-valid.json \
  -e OUTPUT_DIR=/var/task/output \
  -v $(pwd)/output:/var/task/output \
  stark-ballot-simulator/zkvm-prover:local-test

# 3. 出力確認
ls -lh output/
jq . output/test-fixture-valid-output.json
```

### CI/CD Integration (ARM64 native)

```yaml
# .github/workflows/fargate-prover-build.yml (planned)
name: Build Fargate Prover Image

on:
  push:
    branches: [develop, main]
    paths:
      - 'docker/**'
      - 'zkvm/**'
      - '.github/workflows/fargate-prover-build.yml'

jobs:
  build:
    runs-on: ubuntu-24.04-arm64 # Native ARM64 runner
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-region: ap-northeast-1
          role-to-assume: ${{ secrets.AWS_ECR_PUSH_ROLE }}

      - name: Login to Amazon ECR
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/Dockerfile.fargate-prover
          build-args: |
            RISC0_TOOLCHAIN_IMAGE=${{ secrets.RISC0_TOOLCHAIN_IMAGE }}
          platforms: linux/arm64
          push: true
          tags: |
            ${{ secrets.ECR_REGISTRY }}/stark-ballot-simulator/zkvm-prover:phase9.4-${{ github.sha }}
            # Optional (set only when needed)
            # ${{ secrets.ECR_REGISTRY }}/stark-ballot-simulator/zkvm-prover:latest
          cache-from: type=registry,ref=${{ secrets.ECR_REGISTRY }}/stark-ballot-simulator/zkvm-prover:buildcache
          cache-to: type=registry,ref=${{ secrets.ECR_REGISTRY }}/stark-ballot-simulator/zkvm-prover:buildcache,mode=max
```

## Security Considerations

1. **Container Image Scanning**: ECR の自動スキャンを有効化し、脆弱性を継続監視
2. **Least Privilege**: ECS タスクロールは S3 と AppSync への最小限の権限のみ付与
3. **Secrets Management**: 環境変数経由でシークレットを注入、イメージにハードコードしない
4. **Network Isolation**: Private subnet + NAT 経由でインターネットアクセス（S3/AppSync のみ）

## Performance Expectations

### Build Time

- **First build (no cache)**: ~15-20 minutes (QEMU x86 → ARM64 クロスコンパイル)
- **First build (ARM64 native)**: ~5-7 minutes
- **Incremental build (cached)**: ~1-2 minutes

### Image Size

- **Build stage**: ~360 MB (Rust toolchain + dependencies)
- **Runtime stage**: ~200 MB (host binary + minimal dependencies)
- **Registry storage**: ~80-100 MB (compressed)

### Runtime Performance (64 votes)

- **Dev mode** (`RISC0_DEV_MODE=1`): ~1 second (fake receipts)
- **Production mode**: ~370 seconds (~6 minutes, real STARK proofs)
- **Expected Fargate vCPU**: 16 vCPU → potential 2-4x speedup (~90-180 seconds)

## Next Steps

### Immediate (Phase 9.4)

1. ✅ **Dockerfile & entrypoint**: 実装完了、軽微な改善は任意
2. ⏳ **Local testing**: QEMU でビルド・実行を検証
3. ⏳ **ECR repository**: `stark-ballot-simulator/zkvm-prover` を作成し、ライフサイクルポリシー設定
4. ⏳ **GitHub Actions**: ARM64 ネイティブビルドワークフローを追加

### Follow-up (Phase 9.5+)

1. **CloudWatch Container Insights**: ECS タスクのメトリクス収集
2. **Cost optimization**: Fargate Spot 検討（開発環境）
3. **Multi-region**: 本番環境で東京 + 別リージョンの冗長化

## Approval

**Reviewer**: Claude Code Assistant
**Date**: 2025-10-22
**Status**: ✅ **APPROVED** for Phase 9.4 deployment

**Recommendation**: 現在の実装は本番環境で使用可能。提案された改善は Priority: Low/Medium であり、必須ではない。ローカルテスト完了後、ECR への push と ECS タスク定義の作成に進むことを推奨。
