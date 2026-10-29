# 検証モデルと判定条件

検証画面は、投票、掲示板、集計、STARK のチェック結果と実行状態に基づいて判定を表示します。Verified には必要なチェックすべての成功が必要です。掲示板・公開入力・得票数の照合を終えていても、STARK 検証が実行中なら、その完了を待ちます。

証拠の取得失敗は未確認、取得済み証拠の矛盾は不一致の検出として表示します。いずれも Verified を妨げる状態ですが、理由と追加で確認する対象を区別します。

表示には成功、失敗、待機、証拠不足、制限付きなどがあります。ブラウザが実行する投票内容の照合と、サーバーが報告する掲示板・集計・STARK の検証結果を区別したうえで、共通の規則で最終判定を導きます。

[4 段階検証モデル](four-stage-model.md)は各段階の確認対象、[実行フロー](design-and-flow.md)は処理の分担、[Verified の表示条件](gating-logic.md)は最終判定の規則を説明しています。

<!-- source: packages/verification/src/verification/, apps/api/src/server/api/handlers/verify.ts, apps/api/src/server/api/handlers/verificationRun.ts, apps/api/src/server/api/handlers/verificationObservation.ts, apps/api/src/server/api/handlers/verificationBundles.ts, apps/web/src/routes/verify/, apps/web/src/routes/verify/hooks/useVerificationObservation.ts -->
