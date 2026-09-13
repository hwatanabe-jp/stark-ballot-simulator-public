# チェック一覧

検証画面で示す四段階は、22 個のチェックで構成します。結果や実装で見かけた ID を調べられるよう、ここに全定義と個別の判定条件をまとめます。全体の表示は [Verified の表示条件](gating-logic.md)で決まります。

## チェックの属性

チェックの定義には ID、所属段階、証拠種別、重要度、他のチェックから派生する場合の元 ID があります。結果には、その時点の評価状態を付けます。

### 証拠種別

| 種別     | 意味                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| `local`  | 投票者の端末に保存した投票意図などを使う                                           |
| `public` | 秘密を含まない掲示板や公開入力の記録を使う。取得には capability が必要な場合がある |
| `zk`     | ジャーナル、レシート検証結果、ビットマップルートに結びつく証拠を使う               |
| `demo`   | 開発用レシートを明示的に許可した際、表示上の `zk` を置き換える証拠種別             |

定義が持つのは `local` / `public` / `zk` です。`demo` は実行時の証拠を示し、本番用 STARK 証明の成功には数えません。

### 重要度

`required` は必須確認です。`optional` は補助確認ですが、その失敗・未実行があれば最終表示は Warning になります。`recorded_sth_third_party` はソース設定時に必須へ昇格します。

## 全チェック早見表

| #   | チェック ID                            | カテゴリ | 証拠     | 重要度   | 派生元                       |
| --- | -------------------------------------- | -------- | -------- | -------- | ---------------------------- |
| 1   | `cast_receipt_present`                 | Cast     | `local`  | required | —                            |
| 2   | `cast_choice_range`                    | Cast     | `local`  | required | —                            |
| 3   | `cast_random_format`                   | Cast     | `local`  | required | —                            |
| 4   | `cast_commitment_match`                | Cast     | `local`  | required | —                            |
| 5   | `recorded_commitment_in_bulletin`      | Recorded | `public` | optional | `recorded_inclusion_proof`   |
| 6   | `recorded_index_in_range`              | Recorded | `public` | required | —                            |
| 7   | `recorded_root_at_cast_consistent`     | Recorded | `public` | optional | `recorded_consistency_proof` |
| 8   | `recorded_inclusion_proof`             | Recorded | `public` | required | —                            |
| 9   | `recorded_consistency_proof`           | Recorded | `public` | required | —                            |
| 10  | `recorded_sth_third_party`             | Recorded | `public` | optional | —                            |
| 11  | `counted_input_sanity`                 | Counted  | `public` | required | —                            |
| 12  | `counted_unique_indices`               | Counted  | `public` | required | —                            |
| 13  | `counted_unique_commitments`           | Counted  | `public` | required | —                            |
| 14  | `counted_tally_consistent`             | Counted  | `zk`     | required | —                            |
| 15  | `counted_missing_indices_zero`         | Counted  | `zk`     | required | —                            |
| 16  | `counted_expected_vs_tree_size`        | Counted  | `zk`     | required | —                            |
| 17  | `counted_election_manifest_consistent` | Counted  | `public` | required | —                            |
| 18  | `counted_close_statement_consistent`   | Counted  | `public` | required | —                            |
| 19  | `counted_my_vote_included`             | Counted  | `zk`     | required | —                            |
| 20  | `counted_input_commitment_match`       | Counted  | `public` | required | —                            |
| 21  | `stark_image_id_match`                 | STARK    | `zk`     | required | —                            |
| 22  | `stark_receipt_verify`                 | STARK    | `zk`     | required | —                            |

## Cast-as-Intended（4 チェック）

ブラウザは、保存した `electionId` / `myVote` / `myRand` と、検証応答の `voterEvidence` が `available` の場合に得られる `voteReceipt` を使います。API 上の Cast は `not_run` で、ブラウザの計算後に置き換えます。

### `cast_receipt_present`

`voteReceipt` に `voteId` と `commitment` が存在することを確認します。このチェック単体では UUID や hex の形式まで検査しません。

### `cast_choice_range`

保存した選択肢が `A`〜`E` のいずれかであることを確認します。範囲外は `failed` です。

### `cast_random_format`

乱数が 32 バイト、すなわち 64 文字の hex であることを確認します。`0x` プレフィックスは正規化して扱います。

### `cast_commitment_match`

選挙 ID、選択肢、乱数から[投票コミットメント](../protocol/commitment.md)を再計算し、レシートと照合します。

## Recorded-as-Cast（6 チェック）

包含証明と整合性証明は、投票時の `voteReceipt` と `userVote.proof` を使います。まず `leafIndex`、`treeSize`、`bulletinRootAtCast` がレシートと整合することを確認します。完全な投票時証跡が取得できない場合は `not_run` です。部分的に壊れた証跡の受理を意味するものではありません。

### `recorded_commitment_in_bulletin`

`recorded_inclusion_proof` から派生します。包含証明の成功が、コミットメントの存在を裏付けます。

### `recorded_index_in_range`

レシートのインデックスが `0 <= index < treeSize` に収まることを確認します。

### `recorded_root_at_cast_consistent`

`recorded_consistency_proof` から派生します。整合性証明の成功が、投票時のツリーが最終ツリーの先頭部分として残っていることを裏付けます。

### `recorded_inclusion_proof`

コミットメントと RFC 6962 の Merkle パスから投票時のルートを再計算し、レシートの `bulletinRootAtCast` と照合します。証明の `treeSize` は `voteReceipt.bulletinIndex + 1` と一致しなければなりません。

### `recorded_consistency_proof`

投票時と集計時のツリーサイズ・ルートが期待値と一致し、RFC 6962 の整合性証明が成立することを確認します。投票時の証明の `treeSize` は包含証明と同じ条件です。

証拠取得が `unavailable` なら `not_run`、`malformed` または `transport_failed` なら `failed` です。取得と形式検査を行った後の証拠を評価器へ渡すので、評価器自身は URL や認証情報を扱いません。

### `recorded_sth_third_party`

設定したソースから取得した比較可能な STH 応答について、`matchingSources >= minMatches`（既定値 2）と、比較対象間の全会一致を要求します。単なる多数決ではありません。

各応答の `sthDigest` をジャーナルの期待値と照合します。応答に `bulletinRoot` / `treeSize` がある場合は、それも照合します。設定済みソースの取得失敗、不正な応答、利用不能が一つでもあれば成功にしません。未設定なら `not_run`、設定した場合は必須確認です。

外部 HTTPS 応答は `sthDigest` を必須とする flat object で、任意キーは `bulletinRoot` / `treeSize` / `timestamp` / `logId` だけです。指定された値は形式を検査し、未知キー、別名キー、API の wrapper を受理しません。同一オリジンの API テンプレートと外部 HTTPS の取得形式・独立性の違いは [STH ダイジェスト](../protocol/sth-digest.md)に示します。

## Counted-as-Recorded（10 チェック）

公開入力は、形式検査を通した後、評価に必要な要約へ変換します。以下の「公開入力」は、この内部の確認済み要約を指します。検証 API がそのまま配布する値ではありません。

### `counted_input_sanity`

公開入力があり、スキーマ検査に成功し、`treeSize` が正の整数、`votesCount <= treeSize`、`bulletinRoot` がゼロではない 32 バイト hex であることを要求します。

### `counted_unique_indices`

公開入力の各票のインデックスが重複していないことを確認します。入力が取得できなければ `not_run` です。

### `counted_unique_commitments`

公開入力の各コミットメントが重複していないことを確認します。入力が取得できなければ `not_run` です。

### `counted_tally_consistent`

表示する `tally.counts` と `verifiedTally` を候補ごとに比較し、後者の合計が表示側の `tally.totalVotes` と一致することを確認します。ジャーナルが存在して `totalVotes = 0` なら、一票も処理していないため `failed` です。

表示集計を持たない評価入力では、ジャーナル内の `verifiedTally` の合計と `validVotes` の整合を確認します。必要な値もなければ `not_run` です。この内部の合計確認だけで、表示集計との比較を済ませたことにはなりません。正式な公開リソースの成功条件は、表示と証明側の両方を照合します。

### `counted_missing_indices_zero`

除外スロット数がゼロであることを確認します。ジャーナルがある場合は、その `excludedSlots` を使い、先に `excludedSlots` / `missingSlots` / `invalidPresentedSlots` / `validVotes` が非負整数であることも検査します。

ジャーナルを省略した評価入力では、明示的な `excludedSlots`、次に `missingSlots + invalidPresentedSlots` の順で値を求めます。解決できないときはゼロを仮定せず `not_run` にします。正の除外数や異常なジャーナルカウントは、STARK の待機状態より先に失敗と判定します。

`rejectedRecords` はスロットの除外数を求める計算には使いません。ただし、[公開リソースの Verified 条件](gating-logic.md#公開-resource-の整合性)では、この値もゼロを要求します。現行ジャーナルの形式は厳密に検査し、別のフィールド名から修復して評価することはありません。

### `counted_expected_vs_tree_size`

`totalExpected` と `treeSize` の一致を確認します。明示的に渡された値を優先し、なければジャーナルの対応値を使います。必要な値がない、または整数でなければ `not_run`、不一致なら `failed` です。

### `counted_election_manifest_consistent`

マニフェストから `electionConfigHash` を再計算し、宣言値と照合します。そのうえで `electionId` と設定ハッシュが、セッション、公開入力、ジャーナルの対応値と矛盾しないことを確認します。マニフェストがなければ `not_run` です。

### `counted_close_statement_consistent`

締切ステートメントから `sthDigest` を再計算して宣言値と照合し、`timestamp` が公開入力と一致することを確認します。`logId` / `treeSize` / `bulletinRoot` / `sthDigest` も検証入力やジャーナルと照合します。必要なステートメントや公開入力の時刻がなければ `not_run`、再計算できない値や不一致は `failed` です。

### `counted_my_vote_included`

`includedBitmapRoot` に対する Merkle 証明を検証し、自票のインデックスのビットが 1 であることを確認します。証明に必要なレシート、ルート、ツリーサイズ、証明材料がなければ `not_run` です。

`seenBitmapRoot` と対応する証明も利用できれば、「提示されて計上された」「提示されたが計上されなかった」「提示されなかった」を区別して説明します。証明を取得する API は `GET /api/sessions/:sessionId/finalizations/current/bitmap-proofs/:kind/:voteIndex` で、`kind` は `included` または `seen`、インデックスは当該セッションのユーザー票に限定します。

### `counted_input_commitment_match`

公開入力から再計算した値を、ジャーナルの `inputCommitment` と比較します。ジャーナルが省略された評価入力では、別途渡された同名の値を使います。入力、比較値、再計算値がなければ `not_run` です。[対象フィールドと正準エンコーディング](../protocol/input-commitment.md)が一致することを確認し、JSON 全体のハッシュとして扱いません。

## STARK Verification（2 チェック）

### `stark_image_id_match`

STARK の成功後、期待 Image ID、検証サービスが確認したレシートの Image ID、ホストの主張値が整合することを確認します。ホストの JSON に書かれた値だけを、検証済み ID とみなしません。レポートに必要な値がない場合を含む条件は [Image ID](../zkvm/image-id.md)に示します。

### `stark_receipt_verify`

Rust 検証サービスが `Receipt::verify(expectedImageId)` を実行した結果を反映します。`dev_mode` の正規化と最終表示の制限は [STARK 検証のゲーティング](gating-logic.md#stark-検証のゲーティング)に従います。

## STARK 結果への依存

次の六つは、STARK が未開始・実行中・失敗なら、個別の照合に先立ってそれぞれ `not_run`・`pending`・`failed` になります。

- `counted_tally_consistent`
- `counted_expected_vs_tree_size`
- `counted_election_manifest_consistent`
- `counted_close_statement_consistent`
- `counted_my_vote_included`
- `counted_input_commitment_match`

`counted_missing_indices_zero` も STARK に依存しますが、異常カウントや正の除外数が分かれば先に `failed` にします。公開入力の形式と二つの重複確認は、STARK の完了前に評価できます。

## チェックステータスの解決

| 状態      | 意味                                   |
| --------- | -------------------------------------- |
| `not_run` | 必要なデータが未取得、または検証未開始 |
| `pending` | 依存する検証の完了待ち                 |
| `running` | 検証実行中                             |
| `success` | 確認成功                               |
| `failed`  | 確認失敗                               |

各チェックは独立した永続状態機械ではなく、その時点の証拠から再評価する結果です。証拠や STARK の状態が更新されると、`not_run` / `pending` から `success` / `failed` へ直接変わることがあります。

<!-- source: packages/verification/src/verification/verification-checks.ts, packages/verification/src/verification/build-verification-checks.ts, packages/verification/src/verification/engine/evaluate-checks.ts, packages/verification/src/verification/verification-summary.ts, packages/verification/src/verification/excluded-count.ts, packages/verification/src/verification/fail-closed-status.ts -->
