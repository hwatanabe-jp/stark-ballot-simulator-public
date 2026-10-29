# プロパティベーステスト

Property-based Testing（PBT）は入力を多数生成し、すべての入力で成り立つと期待する性質を実装に対して試す方法です。TypeScript には `fast-check`、Rust には `proptest` を使います。失敗が見つかると、原因を追いやすい小さな入力へ縮めます。

Merkle ツリーの分岐やビットのバイト配列への格納処理には、大きさが一つ変わるだけで処理が変わる箇所があります。64 票で包含証明が通っても、63 票や 65 票で正しく動くとは限りません。

## 入力コミットメントの順序不変性

[入力コミットメント](../protocol/input-commitment.md) は、同じ票の集合なら入力順を変えても同じ値になる設計です。PBT では票を生成して並べ替え、元の入力と計算結果を比較します。

正常な票だけでは、同じインデックスを持つ異常なレコードの並び方を確かめられません。そのため重複インデックスも生成し、追加の比較規則によって順序が一定になるかを試します。一方、選挙 ID、掲示板ルート、票数、各票のコミットメントや Merkle パスを変えた場合は、試したケースでハッシュが変わることを確認します。

このテストは実装の並べ替えやバイト列化の誤りを探します。SHA-256 の衝突困難性を証明するものではありません。

## ビットマップの境界値

自票が採用されたかを示すビットマップでは、7 と 8 の間でバイトが変わり、255 と 256 の間で 256 ビットの区画が変わります。境界の前後でビットを取り違えると、別の票の採用状況を表示してしまいます。

生成したビットマップから証明を作り、任意のインデックスで元のビットと一致するかを確かめます。区画の内容や証明パスを変更すれば拒否されること、論理的な票数を越えた位置を証明として使えないこと、末尾の埋め草が非ゼロなら拒否されることも試します。

固定ケースには 0、1、7、8、255、256、257、511、512、513、1025 ビットを残しています。生成テストに加えて、重要な境界は毎回必ず通すためです。

## 検査する性質と実装

| 対象               | 主な性質                                                                                     | TypeScript のテストファイル                                            |
| ------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 掲示板             | 生成した包含証明が通り、葉・ルート・位置・パスの改ざんを拒否する。追記前後の整合性証明が通る | `packages/merkle/src/rfc6962-merkle-tree.property.test.ts`             |
| ビットマップ       | 証明から取り出したビットが元と一致し、改ざん・範囲外・不正な埋め草を拒否する                 | `packages/verification/src/merkle/bitmap-merkle-tree.property.test.ts` |
| 入力コミットメント | 同じ票の並べ替えで値が変わらず、結び付けるフィールドの変更を検出する                         | `packages/zkvm-contract/src/zkvm/input-commitment.property.test.ts`    |
| ジャーナルの票数   | レコード数と掲示板上の位置数を、それぞれ矛盾なく分解できる                                   | `packages/node-adapters/src/zkvm/journal-invariants.property.test.ts`  |

ジャーナルでは、次の式と「採用済みの位置は提示済みでもある」という関係を検査します。

```text
totalVotes = validVotes + rejectedRecords
invalidVotes = rejectedRecords
seenIndicesCount = validVotes + invalidPresentedSlots
validVotes + invalidPresentedSlots + missingSlots = treeSize
excludedSlots = missingSlots + invalidPresentedSlots
```

Rust 側の `zkvm/methods/guest/src/property_tests.rs` でも、入力の並べ替え、Merkle 証明、ビットマップ、ゲストの集計数と重複処理を検査します。Merkle ツリーやビットマップは比較用の実装と照合し、同じ誤りをそのまま期待値にしてしまう可能性を減らします。

## 生成テストの範囲と形式証明

PBT が確認できるのは、生成器が作り、実際に実行したケースです。実行時間を増やしても、生成器が作らない種類の入力は試せません。

すべてのモデル入力について同じ性質が成り立つことを示す場合は、[Lean による形式化](lean-formalization.md)を使います。入力コミットメントやビットマップなど、対応する生成テストケースを持つモデルでは、そのケースを介して実装との対応も確かめます。

<!-- source: packages/merkle/src/rfc6962-merkle-tree.property.test.ts, packages/verification/src/merkle/bitmap-merkle-tree.property.test.ts, packages/zkvm-contract/src/zkvm/input-commitment.property.test.ts, packages/node-adapters/src/zkvm/journal-invariants.property.test.ts, zkvm/methods/guest/src/property_tests.rs, docs/formal/README.md -->
