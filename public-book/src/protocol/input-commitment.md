<a id="入力コミットメント"></a>

# 証明と公開入力を結び付ける

サーバーが自分の B 票を外し、63 票で集計の証明を作ったとします。そのうえで、公開ファイルだけを元の 64 票に戻したらどうなるでしょうか。証明そのものは 63 票の計算について有効でも、公開された投票列はその計算を表していません。

この差し替えを見つけるため、ゲストは処理した入力の公開部分をハッシュにまとめ、ジャーナルの `inputCommitment` に記録します。検証者も `public-input.json` から同じハッシュを計算し、**検証済みレシートに結びついたジャーナル**と比較します。63 件を処理した実行に 64 件の公開入力を組み合わせれば、この値が一致しません。

## 入力コミットメントが解決する問題

これは「公開された投票列が、証明済み実行のものか」を確かめる仕組みです。公開ファイルも 63 票のままならハッシュは一致し得ます。その場合でも、掲示板は 64 スロットなのでゲストの `missingSlots` が 1 になり、完全性のチェックで失敗します。入力の同一性と、全票が提示されたことは別々に確認する必要があります。

選択肢と乱数はこのハッシュの入力に含めません。投票コミットメントを使ってその公開部分を結びつけ、opening の正しさはゲストが投票ごとに検査します。また、公開ファイルの全フィールドがこの一つのハッシュに入るわけでもありません。

## 正準エンコーディング

公開入力は JSON ですが、JSON の文字列をそのままハッシュしません。空白やキーの順で値が変わらないよう、対象フィールドを決まったバイト列へ変換します。

### バイトレイアウト

```text
input_commitment = SHA-256(
    UTF-8("stark-ballot:input|v1.0") // 23 バイト
    || version                      // u32 LE、固定値 10
    || election_id                  // UUID の 16 バイト
    || bulletin_root                // 32 バイト
    || tree_size                    // u32 LE
    || total_expected               // u32 LE
    || votes_count                  // u32 LE
    || vote_entry ...               // 下記の順序で正準化
)
```

ここでの `version=10` はハッシュ入力の形式を示す固定値です。`public-input.json` の `version` フィールドを取り込むものではなく、ゲストの `methodVersion` とも別です。

### 各投票のエンコーディング

```text
vote_entry =
    index             // u32 LE、4 バイト
    || commitment_len // u16 LE、2 バイト、固定値 32
    || commitment     // 32 バイト
    || path_len       // u16 LE、2 バイト
    || path_nodes     // path_len 個の 32 バイト値
```

`votes_count` は提示されたレコード数です。各レコードの `index` は掲示板上の位置であり、配列の何番目かに置き換えません。包含証明のパスノードも含むため、同じコミットメントでも別のパスを提示すればハッシュ入力は変わります。

### フィールド一覧

| 直接束縛するもの | 内容                                                      |
| ---------------- | --------------------------------------------------------- |
| 選挙と掲示板     | `electionId`、`bulletinRoot`、`treeSize`、`totalExpected` |
| 投票列           | 件数と各票の `index`、コミットメント、Merkle パス         |
| 形式の識別       | 固定ドメインタグと固定形式バージョン                      |

### `public-input.json` と公開監査アーティファクトとの関係

入力コミットメントの対象外のフィールドも、公開ファイルを受け取る境界や別のチェックで検証します。

| フィールド            | 別に行う確認                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `schema` / `version`  | 公開入力ファイルの現在の形式に合うことを検査                                               |
| `methodVersion`       | ジャーナルと照合。期待 Image ID の解決には検査済みジャーナルの値を使用                     |
| `electionConfigHash`  | `election-manifest.json`、ジャーナル等を `counted_election_manifest_consistent` で照合     |
| `logId` / `timestamp` | `close-statement.json` と STH ダイジェスト等を `counted_close_statement_consistent` で照合 |

これらのファイルは、[公開バンドル](../verification/bundle-structure.md)に同梱されます。一つのハッシュが一致しただけで全項目の確認を済ませず、それぞれが何と結びつくかをたどります。

## 正準化規則

### ソート規則

投票レコードは `index` の昇順に並べます。正常入力のインデックスは一意です。重複があった場合も同じバイト列を作れるよう、次にコミットメントのバイト列、さらに Merkle パスのバイト列を辞書順に比較します。パスの共通部分が同じなら短い方を先にします。重複をこの順序で並べられることと、重複票を有効として集計できることは別です。

この正準化はハッシュを計算するための順序です。ゲストが入力レコードを検査するときの先着処理を並べ替えるものではありません。

### エンディアン規則

整数はすべてリトルエンディアンです。`u16` は 2 バイト、`u32` は 4 バイトを使い、表現できない件数やパス長は拒否します。

### 16 進数正規化

UUID はハイフンを除いた 16 進数から 16 バイトへ変換します。コミットメント、ルート、パスノードは、`0x` があれば除去して 32 バイトへデコードします。文字列の大文字・小文字はデコード後の同じバイトを意味します。

## TypeScript と Rust の同期

サーバーの TypeScript とゲストの Rust は、この同じ並びを独立に計算します。入力順序を入れ替えてもハッシュが変わらない性質や、長さ・整数の境界は、[生成入力を使うテスト](../quality/property-based-testing.md)と [Lean が出力する入力コミットメントのベクトル](../quality/lean-formalization.md)で確認します。

アプリの `counted_input_commitment_match` はサーバー側での照合結果です。公開入力とレシートを入手した第三者は、[ローカル検証](../reproducibility/audit-bundle.md)で同じ対象フィールドの一致を再確認できます。これに成功しても、非公開の opening を公開したり、自票のブラウザ内データを再現したりすることにはなりません。

<!-- source: packages/zkvm-contract/src/zkvm/types.ts:computeInputCommitmentFromPublicInput, packages/verification/src/verification/public-input-contract.ts, zkvm/contract-core/src/encoding.rs, packages/verification/src/verification/verification-checks.ts, packages/verification/src/verification/engine/evaluate-checks.ts, packages/verification/src/verification/verification-bundle.ts -->
