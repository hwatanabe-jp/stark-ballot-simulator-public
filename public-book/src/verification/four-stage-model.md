# 4 段階検証モデル

検証画面では、投票内容と受理記録の一致、掲示板への記録、集計の完全性と得票数、zkVM の計算結果を四段階に分けて確認します。

## Stage 1: Cast-as-Intended

Cast-as-Intended は、投票者が選んだ内容とサーバーの受理記録の一致を確認する段階です。

ブラウザは、保存済みの選挙 ID、選択肢、32 バイトの乱数から [コミットメント](../protocol/commitment.md)を再計算します。サーバーから取得した投票レシートの値と一致すれば、保存済みの投票内容が受理記録に対応すると確認できます。選択肢の範囲、乱数の形式、レシートの存在も確認します。

この確認では、投票した端末に残る情報が必要です。`localStorage` を消した場合や別の端末で開いた場合、サーバーの集計結果が正常でも、投票時の意図との照合はできません。また、手元のブラウザや保存データ自体が正しく動作することは前提です。

## Stage 2: Recorded-as-Cast

Recorded-as-Cast は、投票記録が集計まで掲示板に保持されたことを二つの Merkle 証明で確認する段階です。レシートの値の確認だけでは、掲示板での記録保持を検証できません。

包含証明では、投票者のコミットメントが投票時のツリーにあることを確かめます。インデックス 0 の票なら、その時点のツリーサイズは 1 です。証明から計算したルートを、レシートに残る投票時のルートと照合します。

整合性証明では、投票時のツリーが、集計時の 64 スロットのツリーの先頭部分として残っていることを確かめます。二つの時点を比較し、その間に既存の記録が差し替えられず、追記だけが行われたかを検証します。二つの証明の計算規則は [CT Merkle ツリー](../protocol/ct-merkle.md)に示しています。

この二つの証明が確認するのは、一人の投票者に示されたツリー間の整合性です。別の投票者にも同じツリーが示されたかを確かめるには、別の観測との照合が必要です。STH ソースが設定されている場合は、集計時のツリー状態を他の応答のダイジェストなどと照合します。これは電子署名の検証ではありません。同じサーバーの応答同士の一致と、独立した観測者による裏付けの違いは [STH ダイジェスト](../protocol/sth-digest.md)で説明します。

## Stage 3: Counted-as-Recorded

Counted-as-Recorded は、掲示板にある票の集計への包含、入力の完全性、表示された得票数を確認する段階です。掲示板に記録された票が集計入力から欠ける場合もあるため、ゲストは掲示板の全スロットを基準に、受け取った票と計上した票を数えます。

たとえば、インデックス 0 を渡さず、残り 63 票だけを正しく集計すると、ジャーナルには「未提示 1、除外 1」が残ります。得票数の計算が正しくても、掲示板全体の集計としては失敗です。さらに [ビットマップ証明](../protocol/bitmap-merkle.md)を使うと、その除外に自分の票が含まれるかを確かめられます。全体の除外数と自票の状態を併用することで、「自票は数えられたが、他の票が欠けた」という場合も検出できます。

画面に表示された A〜E の得票数は、ジャーナルの `verifiedTally` と候補ごとに照合します。たとえば B から一票減らして別の候補へ加える操作は、総数が 64 のままでも検出できます。

そのほかに、公開入力の形式、インデックスとコミットメントの重複、想定票数とツリーサイズ、選挙設定、締切時の掲示板状態を確認します。[入力コミットメント](../protocol/input-commitment.md)を再計算して、公開された入力側の記録とゲストが使った入力を結びつけます。入力コミットメントに含まれないフィールドは、対応する選挙マニフェストや締切ステートメントとの照合で確認します。

## Stage 4: STARK Verification

STARK Verification は、指定した集計プログラムがジャーナルの出力を計算したことを確認する段階です。

Rust の検証サービスが、期待する [Image ID](../zkvm/image-id.md) を指定して STARK レシートを検証します。成功したレシートに結びつくジャーナルを使うことで、集計値、除外数、入力コミットメント、ビットマップルートをゲストの計算結果として扱えます。

STARK 検証の成功は、ゲストへ渡された入力に対する計算の正しさを示します。入力が掲示板全体を表すか、投票者の保存した票と一致するか、表示された得票数が同じかは、Cast / Recorded / Counted の照合で確かめます。開発モードのフェイクレシートには、本番用 STARK 証明としての裏付けがありません。

四段階の結果に基づく最終表示は、[Verified の表示条件](gating-logic.md)で定めています。この章の順序は証拠の関係を説明するためのものです。実際の画面は、必要に応じて STARK 検証を待ってから、四段階の判定結果をまとめて表示します。

<!-- source: packages/api-contract/src/routes/inventory.ts, packages/api-contract/src/schemas/verification.ts, apps/api/src/server/api/handlers/verify.ts, apps/api/src/server/api/adapters/sthProvider.ts, packages/verification/src/verification/engine/evaluate-checks.ts, packages/verification/src/verification/verification-checks.ts, packages/verification/src/verification/build-verification-steps.ts, packages/verification/src/verification/verification-presentation-policy.ts, apps/web/src/routes/verify/lib/local-cast-evidence.ts, apps/web/src/routes/verify/hooks/useVerificationData.ts, apps/web/src/routes/verify/hooks/useVerificationSequence.ts, packages/verification/src/verification/consistency-verifier.ts -->
