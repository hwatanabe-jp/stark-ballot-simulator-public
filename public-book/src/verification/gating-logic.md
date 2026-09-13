# Verified の表示条件

全 64 票について正しい計算の証明があり、表示された得票数も同じだったとしても、投票時の手元データを失っていれば「自分が選んだ B と一致するか」は確認できません。反対に、自票が正しく数えられていても、別の一票が除外されていれば、集計全体の検証は失敗です。

**Verified は、必要な確認がすべて終わり、その結果が矛盾なく揃ったときだけ表示します。** STARK レシートの検証成功は、その条件の一つです。

## 最終判定の種類

| 表示                          | 意味                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| **Verified**（緑）            | 必須確認がすべて成功し、補助確認にも不足・失敗がなく、本番用 STARK 証明で裏付けられている |
| **Verification Failed**（赤） | 証明、投票記録、集計の完全性、表示値などに失敗や不一致を検出した                          |
| **Warning**（黄）             | まだ検証中、必要な証拠が不足、または補助確認に制限がある                                  |
| **Demo Only**（黄）           | 必須条件は満たすが、開発モードのフェイクレシートを使っている                              |

「不明」と「不正を検出した」は分けます。どちらも緑にはなりませんが、Warning を改ざんの証明として説明することもありません。

### 必須確認と補助確認

[チェック一覧](checks-catalog.md)の `required` は必須確認です。既知の必須チェックが一件でも欠けている、`not_run`、`pending`、`running`、`failed` のいずれかなら、Verified にはなりません。

`optional` は補助確認です。失敗や未実行だけで必須確認の失敗にはしませんが、`verified_with_limitations` として Warning を表示します。たとえば STH ソースが未設定なら、そのチェックは未実行の補助確認になります。STH ソースを設定した場合は必須へ昇格し、取得・照合に成功することが必要です。補助確認でも `pending` / `running` が残る間は、最終ラベルの表示を待ちます。

チェックが空、または未知のチェックしかない場合は、集約結果を作れません。既知チェックと未知チェックが混在する場合も、その未知部分を成功と解釈せず、失敗や進行中の判定がなければ証拠不足とします。API から受け取る正式なリソースでは、そもそも定義外・重複・不正なチェック構成を拒否します。

### ステータスの判定順序

まず、チェック結果を集約して「どの理由を伝えるか」を決めます。次に、その集約結果だけでなく証拠と表示準備も調べ、「そのラベルを表示してよいか」を決めます。集約値の `summary` が `fully_verified` でも、後者の条件を満たさなければ Verified は表示しません。

複数の状態が同時に現れたとき、集約は次の順で理由を選びます。

| 優先順 | 条件                                                                                                                  | 集約結果                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1      | 必須チェックが `pending` / `running`                                                                                  | `in_progress`                                                                                                             |
| 2      | 証明の検証に失敗                                                                                                      | `proof_verification_failed`                                                                                               |
| 3      | 集計の完全性に失敗                                                                                                    | 自票も除外なら `user_vote_excluded`、自票は含まれるなら `votes_excluded`、自票の状態が未確認なら `votes_excluded_unknown` |
| 4      | Recorded の必須チェックに失敗                                                                                         | `recorded_integrity_failed`                                                                                               |
| 5      | 表示集計が不一致で、証明・完全性・自票包含・入力整合性・Recorded の必要条件が成功し、必須証拠不足や未知チェックもない | `published_tally_mismatch`                                                                                                |
| 6      | Counted または Cast の必須チェックに失敗                                                                              | `counted_integrity_failed` または `cast_integrity_failed`                                                                 |
| 7      | 必須チェックの未実行・欠落、必要な役割の不足、未知チェックの混在                                                      | `missing_evidence`                                                                                                        |
| 8      | 開発モードまたは `demo` の証拠がある                                                                                  | `demo_only`                                                                                                               |
| 9      | 補助チェックが失敗または未実行                                                                                        | `verified_with_limitations`                                                                                               |
| 10     | 以上のどれにも当たらない                                                                                              | `fully_verified`                                                                                                          |

### 画面へ表示する条件

API とブラウザは共通の `deriveVerificationPresentationPolicy` を使います。ブラウザは Cast を手元で再計算したあと、この規則を適用します。

最終ラベルは、検証開始済み、段階表示の完了、全チェックの `pending` / `running` の解消を待って表示します。表示内容は、明示的な実行失敗、証拠から分かる重大な失敗、上表の集約結果、進行中の警告の順に選びます。タイムアウトや検証シーケンスの失敗も、明示的な実行失敗です。

票の除外は、集約結果だけに頼らず確認します。`missingSlots`、`invalidPresentedSlots`、`excludedSlots` のいずれかが正数、不正な数値、または三値の関係が矛盾する場合は、重大な失敗とします。整合性証明、完全性、期待票数、選挙マニフェスト、締切ステートメント、STARK レシートの失敗と、設定済み STH の失敗もこの経路で確認します。Image ID とレシートの失敗は、明示的な証明失敗としても扱います。

したがって `summary = fully_verified` という値だけを書き換えても、Verified を許可しません。四段階がすべて成功し、開発用の証拠がなく、失敗信号もなく、表示準備が完了している必要があります。

<a id="公開-resource-の整合性"></a>

### 公開 API 応答の整合性

API 応答の成功フラグも検査対象です。チェック定義と状態、段階の状態、投票者の証拠、レポート、付属ジャーナル、改ざん情報が互いに矛盾しないことを確認し、同じ規則で表示資格を再計算します。

Verified を主張するリソースには、特に次の事実を要求します。

- シナリオは S0、STARK は本番用の `success`、改ざん検出はなく、改ざん数はゼロ。
- 投票者の証拠が利用でき、票の ID、コミットメント、投票時の位置とツリーサイズが集計側の値と整合する。
- `missingSlots = invalidPresentedSlots = rejectedRecords = excludedSlots = 0`。
- `seenIndicesCount = treeSize = totalExpected` で、seen / included のビットマップルートが一致する。
- 表示集計と検証済み集計が候補ごとに一致し、その合計も `totalExpected` と一致する。
- 必須チェック、四段階、表示資格と準備状態が整合する。

レポートがある場合は、その状態と期待 Image ID・レシートの Image ID も照合します。STARK の `success` という状態だけでは、Image ID の確認成功は満たせません。

`rejectedRecords` は「何スロットが除外されたか」を数える値とは異なりますが、上記の成功条件ではゼロを要求します。[ゲストのスロットとレコード](../zkvm/guest-program.md#スロット--レコード分離モデル)の区別を、成功条件からこの値を外してよい理由にはしません。

## STARK 検証のゲーティング

STARK の検証状態に応じて、ジャーナルを使うチェックを待機させます。これを実装では `zkGate` と呼びます。

| STARK の状態 | 依存するチェックの扱い         |
| ------------ | ------------------------------ |
| `not_run`    | `not_run`                      |
| `running`    | `pending`                      |
| `failed`     | `failed`                       |
| `success`    | 証拠を使って通常どおり評価する |

公開入力の形式と二つの重複確認は、STARK の完了前にも評価できます。また、すでに除外や異常なカウントが見えている場合、その失敗は待機状態で隠しません。対象のチェック ID と例外は [チェック一覧](checks-catalog.md#stark-結果への依存)にまとめています。

開発用の `dev_mode` は、core evaluator で明示的に許可された場合に `success`、それ以外は `not_run` に正規化して扱います。現在の GET の表示用組み立てでは、許可されない開発モードは `failed` として扱います。許可した場合も証拠には開発用であることが残り、最終表示は Verified にはなりません。

## ステップとチェックの対応関係

四つのステップは、それぞれに属する必須チェックから状態を導きます。Cast は 4 件、Counted は 10 件、STARK は 2 件です。Recorded は包含・位置・整合性の 3 件が基本で、STH ソースの設定時は STH も加わります。包含と整合性から派生する二つの補助チェックは、単独でステップの状態を決めません。

集約の優先順は `failed`、`running`、`pending`、全件成功の `success`、それ以外の `not_run` です。表示上の入力ハイライトは、必須に限らず、その段階の全チェック定義から導きます。

サーバーのステップ構築には追加条件があります。Counted はジャーナルがない場合、必須失敗がなければ `not_run` にします。Recorded は投票時の証明の `treeSize` がなければ `not_run` にします。Cast はサーバー応答では `not_run` とし、ブラウザがローカル結果を反映します。

## 不変条件のまとめ

Verified に必要なのは、完全な必須チェック集合、その成功、除外のない整合した集計、本番用の証明、そして表示準備の完了です。不足、不正形式、未知のデータ、開発用の証拠を、成功の代わりに使うことはできません。

この表示規則は [テスト](../quality/unit-integration-e2e.md)と [Lean のモデル・実装対応確認](../quality/lean-formalization.md)で継続して検査しています。[改ざんシナリオ](../tamper/scenarios.md)では、何を変えるとこの条件を満たさなくなるかを実際の証拠で示します。

<!-- source: apps/api/src/server/api/handlers/verify.ts, apps/web/src/routes/verify/page.tsx, apps/web/src/routes/verify/hooks/useVerificationData.ts, apps/web/src/routes/verify/lib/verification-presentation.ts, packages/api-contract/src/schemas/verification.ts, packages/verification/src/verification/verification-presentation-policy.ts, packages/verification/src/verification/verification-summary.ts, packages/verification/src/verification/verification-checks.ts, packages/verification/src/verification/fail-closed-status.ts, packages/verification/src/verification/engine/evaluate-checks.ts, packages/verification/src/verification/engine/derive-stages.ts, packages/zkvm-contract/src/zkvm/journal-guards.ts, packages/zkvm-contract/src/zkvm/public-journal.ts -->
