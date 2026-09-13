# シナリオとチェック結果の対応

[各シナリオ](scenarios.md)で生じる差を、検証結果の ID と照合するための表です。実 API の検査を通過した証拠が揃い、STARK が成功した時点を示します。

<a id="主要チェック-id-マトリクスstark-解決後の-raw-サーバーチェック"></a>

## 主要チェックの対応（STARK 解決後のサーバー評価）

| チェック                         | S0     | S1     | S2     | S3     | S4     | S5       |
| -------------------------------- | ------ | ------ | ------ | ------ | ------ | -------- |
| `cast_commitment_match`          | 未実行 | 未実行 | 未実行 | 未実行 | 未実行 | 未実行   |
| `counted_tally_consistent`       | 成功   | 成功   | 失敗   | 成功   | 失敗   | 成功     |
| `counted_missing_indices_zero`   | 成功   | 失敗   | 成功   | 失敗   | 成功   | 失敗     |
| `counted_my_vote_included`       | 成功   | 失敗   | 成功   | 成功   | 成功   | 対象依存 |
| `counted_input_commitment_match` | 成功   | 成功   | 成功   | 成功   | 成功   | 成功     |

API の Cast 4 件は常にブラウザの再計算待ちです。手元の証拠が有効なら、ブラウザが再計算した後の Cast は成功します。表の「未実行」はシナリオによる失敗ではありません。

自票のビットマップ証明が不足すると、`counted_my_vote_included` は失敗の代わりに `not_run` となる場合があります。S5 で対象がユーザー票なら自票チェックも失敗し、ボット票なら通常成功します。

## 4 段階と最終理由

| 段階・理由               | S0                              | S1                   | S2                         | S3               | S4                         | S5                                   |
| ------------------------ | ------------------------------- | -------------------- | -------------------------- | ---------------- | -------------------------- | ------------------------------------ |
| Cast（ブラウザ再計算後） | 成功                            | 成功                 | 成功                       | 成功             | 成功                       | 成功                                 |
| Recorded                 | 成功                            | 成功                 | 成功                       | 成功             | 成功                       | 成功                                 |
| Counted                  | 成功                            | 失敗                 | 失敗                       | 失敗             | 失敗                       | 失敗                                 |
| STARK                    | 成功                            | 成功                 | 成功                       | 成功             | 成功                       | 成功                                 |
| 主な最終理由             | 完全な証拠なら `fully_verified` | `user_vote_excluded` | `published_tally_mismatch` | `votes_excluded` | `published_tally_mismatch` | 除外対象に応じて S1 または S3 と同じ |

Recorded が成功できるのは、各シナリオが掲示板の既存エントリを削除しないためです。STARK が成功できる理由と、S2 / S4 の ZIP だけでは表示改変を検出できない理由は、[シナリオ本文](scenarios.md)で説明しています。

S0 でも、STH 未設定など補助チェックが未実行なら `verified_with_limitations` です。一票除外が分かっていて自票の状態が確認できなければ、`votes_excluded_unknown` とします。除外が見つからず必須証拠が足りない場合は `missing_evidence` です。

## 証明の完了を待つ間

STARK が `not_run` / `running` の間、依存する Counted チェックは通常 `not_run` / `pending` です。公開入力の形式・重複は先に確認でき、正の除外数や異常なカウントも先に失敗を示せます。STARK 自体が失敗すると、それに依存するチェックも失敗になります。正確な対象 ID は [STARK 結果への依存](../verification/checks-catalog.md#stark-結果への依存)に示します。

これらは集約前のチェック結果です。最終表示には、ブラウザでの Cast、証拠不足、開発用レシート、表示準備の状態も反映します。[Verified の表示条件](../verification/gating-logic.md)に従い、サーバーの STARK `success` だけから成功ラベルを出すことはありません。

<!-- source: packages/api-contract/src/routes/inventory.ts, packages/api-contract/src/schemas/finalizations.ts, packages/api-contract/src/schemas/verification.ts, apps/api/src/server/api/handlers/verify.ts, apps/web/src/routes/verify/lib/local-cast-evidence.ts, apps/web/src/routes/verify/lib/verification-data.ts, packages/verification/src/verification/scenario-projection.ts, packages/verification/src/verification/engine/evaluate-checks.ts, packages/verification/src/verification/verification-checks.ts, packages/verification/src/verification/verification-summary.ts, packages/verification/src/verification/verification-presentation-policy.ts, packages/application/src/finalize/usecases/finalize-session.ts, packages/application/src/finalize/usecases/finalize-sync.ts, packages/application/src/finalize/finalization-result.ts, infra/lambdas/finalization-writer/handler.ts, apps/web/src/mock-api/fetcher.ts -->
