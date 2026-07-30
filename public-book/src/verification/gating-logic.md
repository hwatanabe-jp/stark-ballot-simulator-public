# ゲーティングロジック

この章は、「Verified」を表示してよい条件と、表示を必ず阻止する不変条件を定義します。

「必要な検証が未実行または失敗なら Verified を表示しない」という原則のもと、各チェックの結果がどう最終判定に集約されるかを定式化します。

この章での Verified は、UI の最終表示が緑色の `Verified` になってよいかだけを指します。
`verificationStatus='success'` や `stark_receipt_verify=success` は STARK receipt 検証成功の信号にすぎず、単独で overall verification の成功を意味しません。

## 最終判定の種類

検証パイプラインの結果は、主経路では `deriveVerificationSummary` によって集約され、UI 上は次のステータスに整理されます。
ただし、`/verify` ページには STARK タイムアウト時の失敗表示など、集約結果に対する限定的な上書きがあります。

| 表示ステータス      | 主な条件                                                                                                    | UI 表示 |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | ------- |
| Verified            | required 条件が満たされ、optional チェックの劣化もない（`fully_verified`）                                  | 緑色    |
| Verification Failed | 証明失敗、票除外、Recorded/Counted/Cast の必須失敗、または公開集計値と検証済み tally の不一致が確定した場合 | 赤色    |
| Warning             | required チェックが進行中、証拠不足がある、または optional チェックのみ劣化している場合                     | 黄色    |
| Demo Only           | required 条件は満たしたが dev-mode receipt を含む場合（`demo_only`）                                        | 黄色    |

Verified の必要条件は [不変条件のまとめ](#不変条件のまとめ) に集約しています。
要点は、既知の required check がすべて存在してすべて `success` であること、票除外（`excludedSlots > 0`）がないこと、dev-mode receipt を production STARK proof として扱っていないことです。

### ステータスの判定順序

| 優先順 | 判定条件                                                                                                                       | 最終ステータス                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| 1      | required チェックに `pending` / `running` がある                                                                               | `Warning` (`in_progress`)                          |
| 2      | STARK 証明系ロールが `failed`                                                                                                  | `Verification Failed`                              |
| 3      | completeness ロールが `failed`（`user_vote_excluded` / `votes_excluded` / `votes_excluded_unknown`）                           | `Verification Failed`                              |
| 4      | Recorded-as-Cast の required チェックが `failed`                                                                               | `Verification Failed`                              |
| 5      | tally consistency だけが失敗し、proof / completeness / user inclusion / input integrity / Recorded required が成功             | `Verification Failed` (`published_tally_mismatch`) |
| 6      | Counted-as-Recorded または Cast-as-Intended の required チェックが `failed`                                                    | `Verification Failed`                              |
| 7      | (a) required に `not_run` がある (b) 必須ロール不足 (c) 既知チェックと混在する未知チェック (d) required 定義の未解決のいずれか | `Warning` (`missing_evidence`)                     |
| 8      | dev-mode evidence がある、または check evidence に `demo` がある                                                               | `Demo Only` (`demo_only`)                          |
| 9      | optional チェックに `failed` / `not_run` がある                                                                                | `Warning` (`verified_with_limitations`)            |
| 10     | 上記いずれにも該当しない                                                                                                       | `Verified`                                         |

この表は `deriveVerificationSummary` の集約結果です。
チェックが空、または未知チェックだけで既知チェックが 1 件も解決できない場合、summary は `null` になり、Verified ではなく最終サマリー未表示として扱われます。

未知チェックが既知チェックと混在する場合も、summary は `missing_evidence` になります。
これは将来のチェック追加や API drift を成功として解釈しないための fail-closed ルールです。

現行 `/verify` ページでは、`pending` / `running` のチェックが残っている間は最終サマリー自体を表示せず、ステップ表示が完了したあとに summary を表示します。
UI レベルの最終表示は (1) 明示的なサーバー失敗、(2) hard-failure fallback、(3) summary、(4) pending warning の順で解決されます。

## STARK 検証のゲーティング

STARK 検証は整合性検証とは独立に評価されます。

| STARK ステータス | 説明                         | 最終判定への影響                                                                         |
| ---------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| `success`        | 暗号学的に検証成功           | 他の必須チェックも `success` なら Verified 可能                                          |
| `failed`         | 検証失敗                     | Verified をブロック                                                                      |
| `dev_mode`       | 開発モードのフェイクレシート | core evaluator では `allowDevModeVerification=true` なら `success`、それ以外は `not_run` |
| `not_run`        | 未実行                       | `missing_evidence`（Warning）扱い。Verified をブロック                                   |
| `running`        | 実行中                       | `in_progress`（Warning）扱い。Verified をブロック                                        |

`stark_receipt_verify` は required check ですが、単独では十分条件ではありません。
`stark_receipt_verify=success` でも、他の required checks（`stark_image_id_match`、`counted_my_vote_included` / `counted_input_commitment_match`、各段階の required checks）のいずれかが失敗、未実行、または進行中なら fully verified にはなりません。
STARK が `not_run` のまま、または整合性チェックだけで Verified に到達する経路もありません（[不変条件のまとめ](#不変条件のまとめ)を参照）。

### zkGate: STARK 結果に基づく Counted チェックの制御

STARK 検証の結果は、Counted-as-Recorded 段階のチェック評価にも影響します。
これを zkGate と呼びます。

| STARK 解決後ステータス | Counted チェックへの反映 |
| ---------------------- | ------------------------ |
| `running`              | `pending`                |
| `not_run`              | `not_run`                |
| `failed`               | `failed`                 |
| `success`              | ゲートなしで通常評価     |

core evaluator では、`dev_mode` は事前に `success` または `not_run` に正規化されてから zkGate に入力されます。
一方、現行 `/api/verify` の表示用ステータス組み立てでは、dev mode が許可されていない場合は [fail-closed](../appendix/glossary.md#fail-closed) の `failed` として反映されます。

## ステップとチェックの対応関係

UI に表示される 4 つのステップは、現行実装では 22 個のチェック定義から派生します。

ただし、`verificationSteps[].status` は「その stage で required 扱いになるチェック群」から導出されます。
`verificationSteps[].inputs` は stage 内の **全チェック定義** から集約されます。

| ステップ            | required として集約されるチェック ID                                                                                                                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cast-as-Intended    | `cast_receipt_present`, `cast_choice_range`, `cast_random_format`, `cast_commitment_match`                                                                                                                                                                                                                              |
| Recorded-as-Cast    | `recorded_index_in_range`, `recorded_inclusion_proof`, `recorded_consistency_proof`、および STH source 設定時の `recorded_sth_third_party`                                                                                                                                                                              |
| Counted-as-Recorded | `counted_input_sanity`, `counted_unique_indices`, `counted_unique_commitments`, `counted_tally_consistent`, `counted_missing_indices_zero`, `counted_expected_vs_tree_size`, `counted_election_manifest_consistent`, `counted_close_statement_consistent`, `counted_my_vote_included`, `counted_input_commitment_match` |
| STARK Verification  | `stark_image_id_match`, `stark_receipt_verify`                                                                                                                                                                                                                                                                          |

補足:

- `recorded_commitment_in_bulletin` は `recorded_inclusion_proof` から、`recorded_root_at_cast_consistent` は `recorded_consistency_proof` から導出される表示用チェックです。
  チェック一覧には現れますが、単独では step status を決定しません。
- `recorded_sth_third_party` は通常は optional ですが、STH source が設定されている場合だけ required に昇格し、Recorded-as-Cast の step status と最終判定をブロックし得ます。

ステップのステータスは、required 扱いになったチェックのステータスから次の順序で集約されます。

| 集約ルール | 条件                                                     |
| ---------- | -------------------------------------------------------- |
| `failed`   | required チェックのいずれかが `failed`                   |
| `running`  | `failed` がなく、required チェックのいずれかが `running` |
| `pending`  | `failed`/`running` がなく、いずれかが `pending`          |
| `success`  | required チェックがすべて `success`                      |
| `not_run`  | 上記のいずれにも該当しない                               |

さらに現行実装には、単純集約だけではない 3 つの補正があります。

- `counted_as_recorded` は `journal` が存在しない場合、required チェックに `failed` がない限り `not_run` に補正されます。
- `recorded_as_cast` は `userVote.proof.treeSize` がない場合、`not_run` に補正されます。
- `/api/verify` は `castSource='client'` で `verificationSteps` / `verificationChecks` を組み立てるため、API 応答上の Cast-as-Intended はいったん `not_run` です。
  その後ブラウザ側で保存済みセッション情報から Cast チェックを再評価して上書きし、最終的な UI 表示と summary にはそのローカル結果が反映されます。

## 補助判定のゲーティング（`validateVotingIntegrity`）

`validateVotingIntegrity` は、現行 `/verify` の最終判定では使われない内部 helper です。
この helper は、整合性証明、完全性、第三者 STH 合意、ユーザーインデックス範囲を順に評価し、いずれかが失敗すれば `canShowVerified = false` を返します。
意味論は [チェック一覧](checks-catalog.md) の `recorded_index_in_range` / `recorded_consistency_proof` / `counted_missing_indices_zero` / `counted_expected_vs_tree_size` / `recorded_sth_third_party` に対応します。

検証実行と UI 表示の時系列（ポーリングとステップ表示の順序）は [設計と実行フロー](design-and-flow.md) を参照してください。

## 不変条件のまとめ

以下の不変条件は、コードの変更によっても決して緩和してはなりません。

| 不変条件                                                                                                     | 根拠                                                  |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| required check の `failed` / `not_run` / `pending` / `running` → Verified を表示しない                       | 必須証拠の失敗、不在、未完了を成功として扱わない      |
| 空 check set、未知チェックだけ、未知チェック混在、required 定義の欠落 → Verified を表示しない                | API drift や未対応チェックを fail-closed にする       |
| `excludedSlots > 0` → successful overall verification を許さない                                             | 投票除外は最も深刻な不正                              |
| legacy count alias（`excludedCount` など）→ fail-closed compatibility signal としてのみ扱う                  | 旧フィールドを公開成功契約として復活させない          |
| `recorded_consistency_proof` の失敗 → Verified を表示しない                                                  | 追記専用性が保証されない                              |
| STH 合意の不成立（有効時） → Verified を表示しない                                                           | スプリットビュー攻撃の可能性                          |
| `counted_missing_indices_zero` / `counted_expected_vs_tree_size` の失敗 → Verified を表示しない              | tally completeness と入力境界が保証されない           |
| `counted_election_manifest_consistent` / `counted_close_statement_consistent` の失敗 → Verified を表示しない | 公開 manifest / close statement との binding が崩れる |
| `counted_my_vote_included` / `counted_input_commitment_match` の失敗 → fully verified をブロックする         | ユーザー inclusion と proof input binding が崩れる    |
| `stark_image_id_match` / `stark_receipt_verify` の失敗 → fully verified をブロックする                       | 期待 guest image と receipt の正当性が保証されない    |
| `stark_receipt_verify=success` だけでは Verified にしない                                                    | STARK receipt は必要条件であり十分条件ではない        |
| dev-mode receipt → production STARK proof として扱わず、緑色の Verified を表示しない                         | `RISC0_DEV_MODE=1` は実証用の fake receipt            |
| 非公開アーティファクトをバンドルに含めない                                                                   | 投票の秘匿性を維持                                    |

これらの不変条件は、改ざんシナリオ（S0〜S5）の検出を保証する基盤です。
各シナリオがどの不変条件によって検出されるかは、[改ざんシナリオ](../tamper/index.md) を参照してください。

この fail-closed モデルは、[単体、結合、E2E テスト](../quality/unit-integration-e2e.md) で「Verified を誤表示しない」ケースを継続的に検査しています。
形式化側では [Lean による形式化](../quality/lean-formalization.md) の verification summary / display vectors を通じて、モデルと実装の対応を確認します。

<!-- source: apps/api/src/server/api/handlers/verify.ts, apps/web/src/routes/verify/hooks/useVerificationData.ts, apps/web/src/routes/verify/lib/overall-status.ts, packages/verification/src/verification/consistency-verifier.ts:validateVotingIntegrity, packages/verification/src/verification/verification-summary.ts, packages/verification/src/verification/verification-checks.ts, packages/verification/src/verification/engine/evaluate-checks.ts, packages/verification/src/verification/engine/derive-stages.ts -->
