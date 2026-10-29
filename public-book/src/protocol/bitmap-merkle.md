# ビットマップ Merkle 証明

ゲストは、掲示板の各位置について、票の提示と計上の有無をそれぞれ 1 ビットで記録します。この記録がビットマップです。集計件数だけでは特定できない、個票の採用状況を表します。

ジャーナルには二つのビットマップの Merkle ルートを記録します。投票者は自票の位置のビットと Merkle 証明を取得し、レシートに結び付いたルートと照合できます。

## 提示・計上状態の定義

`seenBitmap[i]` は範囲内の位置 `i` が提示されたこと、`includedBitmap[i]` はその位置の票を有効と認めて計上したことを表します。インデックス 0 のユーザー票は、それぞれの先頭ビットに対応します。

| `seen[0]` | `included[0]` | 意味                                       |
| --------- | ------------- | ------------------------------------------ |
| 1         | 1             | 提示され、集計に含まれた                   |
| 1         | 0             | 提示されたが、検査に通らず計上されなかった |
| 0         | 0             | ゲストへ提示されなかった                   |
| 0         | 1             | 正しいゲスト出力では成立しない組           |

S1 のように自票を入力から外せば、掲示板は 64 スロットのままで、位置 0 のビットは両方 0 になります。S2 のように表示の得票数だけを変えた場合は、ゲストへの入力が元の 64 票なので、位置 0 のビットは両方 1 のままです。表示の改変は、別の得票数照合で検出します。

Merkle 証明で確かめるのは、取得したビットがジャーナルのルートに結びつくことです。そのルートをゲストの計算結果として信頼するには、期待 Image ID に対するレシート検証も必要です。アプリの検証画面では、サーバーがこの個票証明を評価して結果を返します。

## ビットマップの構造

ビット数は `treeSize` と同じです。64 スロットなら 64 ビット、すなわち 8 バイトです。

### LSB-first ビットパッキング

位置 0 を最初のバイトの最下位ビットへ置き、位置が一つ進むごとに上位ビットへ進めます。8 ビット分を埋めたら次のバイトへ移ります。

```text
byte[i / 8] の bit (i % 8) が、位置 i の状態

64 票すべてを計上: ff ff ff ff ff ff ff ff
位置 0 だけ未計上: fe ff ff ff ff ff ff ff
```

上の除算は整数除算です。最初の `fe` は、最下位ビットだけが 0 であることを示します。これは実装規則から作った説明用の値で、実行結果の採取例ではありません。

### 32 バイトチャンク分割

パックしたバイト列を 32 バイトずつ区切り、最後は 0 で埋めます。1 チャンクに 256 スロットが入るので、64 票のデモは 8 バイトの記録と 24 バイトのゼロからなる 1 チャンクです。このチャンクが Merkle ツリーのリーフになります。

## Merkle ツリーの構築

ハッシュ規則は[掲示板の CT Merkle](ct-merkle.md#rfc-6962-参照ハッシュ規則)と同じですが、リーフの中身は投票コミットメントではなく 32 バイトのチャンクです。

```text
LeafHash(chunk) = SHA-256(0x00 || UTF-8("stark-ballot:leaf|v1") || chunk)
NodeHash(left, right) = SHA-256(0x01 || left || right)
```

各チャンクをハッシュし、隣同士を左右の子としてまとめます。奇数個で最後に余ったノードは、ハッシュを加えず次の段へ持ち上げます。1 リーフしかない 64 票のデモでは、そのリーフハッシュがそのままルートです。

## Merkle 証明の生成と検証

### 証明の構造

`GET /api/sessions/:sessionId/finalizations/current/bitmap-proofs/:kind/:voteIndex` は、現在の集計について次の証明材料を返します。

| `data` のフィールド | 内容                                              |
| ------------------- | ------------------------------------------------- |
| `leafChunk`         | 対象ビットを含む 32 バイトのチャンク、16 進数表記 |
| `auditPath`         | 兄弟ハッシュとその `left` / `right` 位置の配列    |

応答は標準の `{ data, meta: { requestId } }` 形式です。`kind=included` は計上、`kind=seen` は提示の証明を選びます。セッションの capability が必要で、要求できる `voteIndex` は自票の位置だけです。リーフ位置やビット位置は応答を信用して受け取るのではなく、要求した `voteIndex` から導出します。

### 検証手順

1. 証明に結びついたジャーナルから、正の整数 `treeSize` と、対象の 32 バイトルートを得ます。`0 <= voteIndex < treeSize` を確認します。
2. `leafIndex = floor(voteIndex / 256)`、`bitOffset = voteIndex % 256`、`leafCount = ceil(treeSize / 256)` を計算します。
3. チャンクと各兄弟ハッシュが 32 バイトであること、パスの長さと左右の並びが `leafIndex` と `leafCount` から決まるツリー形状に合うことを確認します。
4. 最後のチャンクのうち `treeSize` より後の未使用ビットが、すべて 0 であることを確認します。
5. リーフハッシュから始め、パスをたどってルートを再計算します。兄弟が左なら `NodeHash(sibling, current)`、右なら `NodeHash(current, sibling)` を使います。
6. `includedBitmapRoot` または `seenBitmapRoot` と一致した場合に、対象ビットを状態として読みます。

64 票の 1 リーフ構成では、空の `auditPath` と、チャンク長・位置の範囲・ゼロ埋め・ルートの照合を使って検証します。パスが空の場合も、これらの条件を満たす必要があります。

### ビット抽出

```text
byteIndex = floor(bitOffset / 8)
bitInByte = bitOffset % 8
value = (chunk[byteIndex] AND (1 << bitInByte)) != 0
```

`included=false` だけでは未提示と無効を区別できません。検証できた `seen` の証明を組み合わせて分類します。`seen` の証拠を取得・検証できなければ、理由は `unknown_excluded` として扱い、推測で決めません。

## サーバーのビットマップデータ管理

ジャーナルに入るのは二つのルートで、ビットマップ全体ではありません。ホストは入力からビットマップを再構成し、ゲストのルートと一致した場合に非公開の補助ファイルを出力します。サーバーも保存・復元時に長さ `treeSize` とルートを照合し、集計成功と同じ保存処理で採用します。

`included-bitmap.json` と `seen-bitmap.json` は個票証明の生成元ですが、公開 ZIP には含めません。証拠が保存されていなければ、件数やルートだけから中身を推測して補いません。証拠不足と、取得済み証明の不一致ではチェック結果も異なります。正確な分岐は [`counted_my_vote_included`](../verification/checks-catalog.md#counted_my_vote_included)に定義しています。

## プライバシーに関する注意

API が要求を自票の位置に制限しても、返すのはその位置を含むチャンク全体です。したがって同じチャンク内のほかの位置の状態も読めます。64 票のデモでは全票の計上・提示状態が一つのチャンクに入ります。開示されるのはチャンク内の計上・提示状態で、選択肢や乱数は含まれません。

チャンクを小さくすれば開示範囲を減らせる一方、ツリーのリーフ数、証明パス、ゲスト内のハッシュ計算は増えます。現行のデモはユーザー 1 票とボット 63 票を対象に、32 バイト単位を使っています。

ビット境界、ゼロ埋め、ルート計算は、[Property-based Testing](../quality/property-based-testing.md)と [Lean のビットマップベクトル](../quality/lean-formalization.md)で検査します。

<!-- source: packages/api-contract/src/routes/inventory.ts, packages/api-contract/src/schemas/artifacts.ts, packages/zkvm-contract/src/zkvm/bitmap.ts, packages/zkvm-contract/src/zkvm/types.ts, packages/verification/src/merkle/bitmap-merkle-tree.ts, packages/verification/src/verification/bitmap-verifier.ts, apps/api/src/server/api/handlers/bitmapProof.ts, packages/application/src/finalize/usecases/finalize-sync.ts, packages/aws-adapters/src/aws/bundle-restore.ts, zkvm/host/src/main.rs -->
