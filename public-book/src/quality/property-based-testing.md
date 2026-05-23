# Property-based Testing

Property-based Testing (PBT) は、少数の fixture では見落としやすい境界条件を、生成入力と「常に成り立つべき性質」で検査するために使います。

本プロジェクトでは、Merkle tree、bitmap packing、input commitment、journal count のように、順序・境界・改ざん耐性が重要なロジックに PBT を置いています。

## PBT を導入した理由

example-based tests は既知のシナリオを守ります。PBT はそれに加えて、次のような仕様レベルの性質を入力空間全体に近い形で探索します。

- 同じ vote multiset なら入力順序を変えても input commitment が変わらない
- root、leaf、index、proof node を改ざんすると Merkle proof が失敗する
- LSB-first bitmap packing の bit address が境界で崩れない
- journal count の分解式が常に成立する

PBT は証明ではありませんが、実装に対して広い入力空間を継続的に探索できるため、暗号周辺の encoding drift や境界条件の退行を早期に検出できます。

## TypeScript 側の PBT

### RFC 6962 Merkle tree

対象:

- `src/lib/merkle/rfc6962-merkle-tree.property.test.ts`

検査する性質:

- 任意の leaf set について inclusion proof が round-trip する
- root、leaf、index、proof node を改ざんすると検証に失敗する
- append-only consistency proof が old size / new size の組み合わせで検証できる
- 奇数サイズ tree の代表ケースを固定 regression として保持する

### Bitmap Merkle

対象:

- `src/lib/merkle/bitmap-merkle-tree.property.test.ts`

検査する性質:

- 生成した bitmap の任意 index について proof が round-trip する
- proof から抽出した `included` が元の bit と一致する
- leaf chunk や audit path の改ざんを拒否する
- 0, 1, 7, 8, 255, 256, 257, 511, 512 bit などの境界を固定ケースで検査する

### Input commitment

対象:

- `src/lib/zkvm/__tests__/input-commitment.property.test.ts`

検査する性質:

- 同じ vote multiset の順序を入れ替えても input commitment が変わらない
- duplicate index がある異常入力でも deterministic tie-break により順序が安定する
- election ID、bulletin root、tree size、total expected を変えると commitment が変わる
- vote の index、commitment、Merkle path を変えると commitment が変わる

### Journal invariants

対象:

- `src/lib/zkvm/__tests__/journal-invariants.property.test.ts`

検査する性質:

- `totalVotes = validVotes + rejectedRecords`
- `invalidVotes = rejectedRecords`
- `seenIndicesCount = validVotes + invalidPresentedSlots`
- `validVotes + invalidPresentedSlots + missingSlots = treeSize`
- `excludedSlots = missingSlots + invalidPresentedSlots`
- included bitmap の `true` は seen bitmap の `true` を含意する

## Rust 側の PBT

対象:

- `zkvm/methods/guest/src/property_tests.rs`

検査する性質:

- input commitment が vote order に対して permutation invariant
- duplicate index の tie-break を含めても permutation invariant
- RFC 6962 inclusion proof が reference tree と一致する
- root / leaf / path 改ざんを拒否する
- bitmap root が reference oracle と一致する
- bit flip で bitmap root が変わる

Rust 側の PBT は、zkVM guest / contract-core で使う低レベル実装に近い場所で、TypeScript 側と同じ性質を別実装として検査します。

## Lean との関係

PBT は実装に対して広い入力空間を探索し、Lean は同種の不変条件を抽象モデル上で証明します。両者の役割分担と、Lean から出力した generated vectors を介して実装テストに接続する仕組みは [Lean による形式化 > 実装との接続](./lean-formalization.md#実装との接続) に整理しています。

## 限界

- PBT は数学的証明ではない
- 生成範囲は CI 実行時間とのバランスで制限する
- SHA-256 の衝突困難性は PBT では証明しない
- RISC Zero receipt soundness も PBT の対象ではない
- 生成器に含めていない入力領域は探索されない

そのため、PBT は example-based tests や Lean formalization を置き換えるものではなく、境界条件と実装 drift を検出する追加レイヤーとして扱います。

<!-- source: src/lib/merkle/rfc6962-merkle-tree.property.test.ts, src/lib/merkle/bitmap-merkle-tree.property.test.ts, src/lib/zkvm/__tests__/input-commitment.property.test.ts, src/lib/zkvm/__tests__/journal-invariants.property.test.ts, zkvm/methods/guest/src/property_tests.rs, docs/current/formal/README.md -->
