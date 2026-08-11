# 入力コミットメント

この章では、zkVM 入力のうち公開検証に使うフィールドを正準エンコーディングで束縛し、ジャーナルから再計算できる入力コミットメントを定義します。

入力コミットメントは、「証明されたデータセット」と「主張されたデータセット」の一致を検証可能にします。
バイトレベルの正準化は、TypeScript と Rust が同じ入力から決定的に同じ値を計算するための前提です。

## 概要

入力コミットメントは、公開可能な検証フィールドにドメインタグとバージョンを加えて正準連結し、SHA-256 で集約したハッシュ値です。

このハッシュ値は zkVM のジャーナル（公開出力）にコミットされます。
第三者は、ジャーナルに記録された入力コミットメントと、`public-input.json` などの公開可能な検証データから再計算した値を照合できます。
この照合により、zkVM が実際にどのデータセットを処理したかを独立に検証できます。

```mermaid
flowchart TB
  IN["入力データ<br/>electionId / bulletinRoot / treeSize<br/>/ totalExpected / votes (index 昇順)"]
  SPEC["固定値<br/>domainTag: stark-ballot:input|v1.0<br/>version: 10"]

  IN --> ENC[正準エンコーディング]
  SPEC --> ENC
  ENC --> H[SHA-256]
  H --> IC[入力コミットメント<br/>32 バイト]
  IC --> CMP["第三者照合<br/>再計算値 = journal.inputCommitment"]
```

## 入力コミットメントが解決する問題

zkVM の STARK 証明は、「ゲストプログラムが正しく実行された」ことを証明します。
一方で、「どの入力に対して実行されたか」は STARK 証明単体のスコープ外です。
入力コミットメントがなければ、悪意あるサーバーは次の攻撃が可能です。

1. 投票を除外した入力で zkVM を実行し、有効な STARK 証明を取得する
2. 公開用の入力データには除外されていない投票を含めて提示する
3. 第三者は STARK 証明が有効であることを確認できるが、実際に処理された入力は異なる

入力コミットメントをジャーナルに含めることで、第三者は「公開データから再計算した入力コミットメント」と「ジャーナルに記録された入力コミットメント」を照合できます。
不一致があれば、公開データと証明された入力の食い違いを検出できます。

## 正準エンコーディング

入力コミットメントの計算では、すべてのフィールドを決定的な順序とエンコーディングで連結します。

### バイトレイアウト

```text
input_commitment = SHA-256(
    domain_tag       ← "stark-ballot:input|v1.0" (23 バイト, UTF-8)
    || version       ← u32 リトルエンディアン (4 バイト) = 10
    || election_id   ← UUID v4 バイナリ (16 バイト)
    || bulletin_root ← 32 バイト
    || tree_size     ← u32 リトルエンディアン (4 バイト)
    || total_expected← u32 リトルエンディアン (4 バイト)
    || votes_count   ← u32 リトルエンディアン (4 バイト)
    || [投票データ]  ← インデックス昇順でソートされた各投票
)
```

### 各投票のエンコーディング

投票配列の各要素は次の形式でエンコードされます。

```text
vote_entry =
    index            ← u32 リトルエンディアン (4 バイト)
    || commitment_len← u16 リトルエンディアン (2 バイト) = 32 (固定)
    || commitment    ← 32 バイト
    || path_len      ← u16 リトルエンディアン (2 バイト)
    || path_nodes    ← path_len × 32 バイト
```

### フィールド一覧

| フィールド         | サイズ       | エンコーディング | 説明                         |
| ------------------ | ------------ | ---------------- | ---------------------------- |
| ドメインタグ       | 23 バイト    | UTF-8 固定文字列 | `"stark-ballot:input\|v1.0"` |
| バージョン         | 4 バイト     | u32 LE           | v1.0 = `10`                  |
| 選挙 ID            | 16 バイト    | UUID バイナリ    | 選挙スコープの識別子         |
| 掲示板ルート       | 32 バイト    | ハッシュ値       | 最終的な Merkle ルート       |
| ツリーサイズ       | 4 バイト     | u32 LE           | 掲示板のリーフ数             |
| 期待投票数         | 4 バイト     | u32 LE           | 想定される総投票数           |
| 投票数             | 4 バイト     | u32 LE           | 実際に含まれる投票数         |
| 各投票インデックス | 4 バイト     | u32 LE           | 掲示板上の位置               |
| コミットメント長   | 2 バイト     | u16 LE           | 固定値 32                    |
| コミットメント     | 32 バイト    | ハッシュ値       | 投票コミットメント           |
| パス長             | 2 バイト     | u16 LE           | Merkle パスのノード数        |
| パスノード         | 各 32 バイト | ハッシュ値       | 包含証明の兄弟ハッシュ       |

### `public-input.json` と公開監査アーティファクトとの関係

**要点**: `public-input.json` の全フィールドが入力コミットメントに束縛されるわけではありません。
残りのフィールドは、別のチェックで補完的に検証されます。

`public-input.json` は、zkVM 検証に使う秘密データを含まない検証用レコードです。
現行実装では `schema`、`version`、`electionId`、`electionConfigHash`、`bulletinRoot`、`treeSize`、`totalExpected`、`logId`、`timestamp`、`methodVersion` を含みます。
各投票については、`index`、コミットメント値、Merkle パスを含みます。

入力コミットメントが直接束縛するのは、[フィールド一覧](#フィールド一覧)に示した対象のみです。
`schema`、`version`、`electionConfigHash`、`logId`、`timestamp`、`methodVersion` は対象外です。
対象外のフィールドは、proof bundle 内の `election-manifest.json` や `close-statement.json` を組み合わせて、次のように照合されます。

- `electionConfigHash` → `counted_election_manifest_consistent`（manifest と journal 等を照合）
- `logId` と `timestamp` → `counted_close_statement_consistent`（close statement と journal 等を照合）
- `schema`、`version` → `public-input.json` の管理対象 artifact format として artifact 採用時に検証
- `methodVersion` → `public-input.json` 採用時に journal と照合
  Image ID 解決では正規化済み journal 値を使用

## 正準化規則

エンコーディングの決定性を保つために、次の規則を使います。

### ソート規則

投票はエンコーディング前にインデックスの昇順にソートします。
各投票の `index` は一意であることが前提です。
この規則により、同じ投票集合から常に同一のバイト列が生成されます。
この規則に違反すると、TypeScript と Rust で異なるハッシュ値が計算され、検証が失敗します。

> **異常系の補助**: 重複インデックスはプロトコル違反です。
> TS/Rust 双方は決定性のために `commitment` / `merklePath` で tie-break しますが、正常系仕様は `index` 昇順のままです。

### エンディアン規則

すべての整数フィールドはリトルエンディアンでエンコードされます。

| 型  | バイト数 | エンコーディング   |
| --- | -------- | ------------------ |
| u16 | 2        | リトルエンディアン |
| u32 | 4        | リトルエンディアン |

### 16 進数正規化

コミットメント値やパスノードなどの 16 進数表現は、`0x` プレフィックスを除去した上でバイト列にデコードされます。
16 進数文字列のまま連結するのではなく、常にバイナリ表現を使用します。

## TypeScript と Rust の同期

入力コミットメントは TypeScript（サーバー側）と Rust（zkVM ゲスト内）の双方で独立に計算されます。
両者の結果は一致する必要があります。

```mermaid
flowchart LR
  subgraph TypeScript
    TS_IN[public-input.json から抽出した<br/>入力コミットメント対象フィールド] --> TS_CALC[正準エンコーディング<br/>+ SHA-256]
    TS_CALC --> TS_IC[入力コミットメント A]
  end

  subgraph "Rust (zkVM ゲスト)"
    RS_IN[ゲスト入力] --> RS_CALC[正準エンコーディング<br/>+ SHA-256]
    RS_CALC --> RS_IC[入力コミットメント B]
  end

  TS_IC --> CMP{A = B ?}
  RS_IC --> CMP
  CMP -->|一致| OK[検証成功]
  CMP -->|不一致| NG[検証失敗:<br/>入力データが異なる]
```

同期が破壊される典型的な原因は次のとおりです。

- ソート順序の不一致
- エンディアンの不一致
- ドメインタグの文字列差異
- バージョン番号の不一致
- 16 進数正規化規則の差異（大文字/小文字、`0x` プレフィックスの有無）

## 検証パイプラインにおける役割

入力コミットメントは、Counted-as-Recorded 段階の検証チェック `counted_input_commitment_match` で使用されます。

| チェック ID                      | 検証内容                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `counted_input_commitment_match` | 公開可能な検証データから再計算した入力コミットメントがジャーナルの値と一致するか |

このチェックが失敗すると、zkVM が処理した入力データと、公開可能な検証データから再構成される対象フィールドが食い違うことを意味します。
その場合、結果の信頼性は根本的に損なわれます。
対象外フィールドの補完検証は[上記](#public-inputjson-と公開監査アーティファクトとの関係)のとおりです。

各チェックの判定ロジックは [チェック一覧 > Counted-as-Recorded](../verification/checks-catalog.md#counted-as-recorded10-チェック) を参照してください。

## 注意事項

入力コミットメントには、投票者の秘密データ（選択肢や乱数）は含まれません。
したがって、入力コミットメントの公開は投票の秘密性を損ないません。

入力順序に依存しない正準エンコーディングは、[Property-based Testing](../quality/property-based-testing.md) の permutation invariance と、[Lean による形式化](../quality/lean-formalization.md) の input-commitment vectors で検査します。

<!-- source: packages/zkvm-contract/src/zkvm/types.ts:computeInputCommitmentFromPublicInput, packages/verification/src/verification/public-input-contract.ts, zkvm/contract-core/src/encoding.rs, packages/verification/src/verification/verification-checks.ts, packages/verification/src/verification/engine/evaluate-checks.ts, packages/verification/src/verification/verification-bundle.ts -->
