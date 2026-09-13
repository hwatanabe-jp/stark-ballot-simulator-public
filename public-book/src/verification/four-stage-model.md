# 4 段階検証モデル

投票の記録、掲示板、集計、計算の証明は、それぞれ違う疑問に答えます。検証画面の四つの段階は、その違いを表しています。

## Stage 1: Cast-as-Intended

最初の問いは「B を選んだ自分の操作と、サーバーが受け付けた記録が一致するか」です。

ブラウザは、保存しておいた選挙 ID、選択肢 B、32 バイトの乱数から [コミットメント](../protocol/commitment.md)を再計算します。それがサーバーから取得した投票レシートの値と一致すれば、手元の投票内容と受理記録を結びつけられます。選択肢の範囲、乱数の形式、レシートの存在も確認します。

この確認では、投票した端末に残る情報が必要です。`localStorage` を消した場合や別の端末で開いた場合、サーバーの集計結果が正常でも、投票時の意図との照合はできません。また、手元のブラウザや保存データ自体が正しく動作することは前提です。

## Stage 2: Recorded-as-Cast

レシートの値が正しくても、その記録が集計まで掲示板に残っているとは限りません。そこで二つの Merkle 証明をつなぎます。

**包含証明**は、自分のコミットメントが投票時のツリーにあることを確かめます。インデックス 0 の票なら、その時点のツリーサイズは 1 です。証明から計算したルートを、レシートに残る投票時のルートと照合します。

**整合性証明**は、投票時のツリーが、集計時の 64 スロットのツリーの先頭部分として残っていることを確かめます。二つの時点を比較し、その間に既存の記録が差し替えられず、追記だけが行われたかを検証します。[CT Merkle ツリー](../protocol/ct-merkle.md)には、この二つの証明の計算規則を示しています。

ただし、自分に示された二つのツリーが整合していても、別の人にも同じツリーが示されたとは限りません。設定された STH ソースがある場合は、集計時のツリー状態を他の応答と照合します。この確認は STH のダイジェストなどの一致を見るもので、電子署名の検証ではありません。同じサーバーの応答同士を照合しても、独立した観測者による裏付けにはなりません。独立性と照合条件は [STH ダイジェスト](../protocol/sth-digest.md)で説明します。

## Stage 3: Counted-as-Recorded

記録が掲示板に残っていても、サーバーがそれを集計プログラムへ渡すとは限りません。ゲストは掲示板の全スロットを基準に、受け取った票と計上した票を数えます。

たとえば、インデックス 0 を渡さず、残り 63 票だけを正しく集計すると、ジャーナルには「未提示 1、除外 1」が残ります。得票数の計算が正しくても、掲示板全体の集計としては失敗です。さらに [ビットマップ証明](../protocol/bitmap-merkle.md)を使うと、その除外に自分の票が含まれるかを確かめられます。全体の除外数と自票の状態を併用することで、「自票は数えられたが、他の票が欠けた」という場合も検出できます。

集計値の比較もこの段階の役目です。画面に出す A〜E の得票数を、ジャーナルの `verifiedTally` と候補ごとに照合します。B から一票減らして別の候補へ加える操作は、総数が 64 のままでも検出できます。

そのほかに、公開入力の形式、インデックスとコミットメントの重複、想定票数とツリーサイズ、選挙設定、締切時の掲示板状態を確認します。[入力コミットメント](../protocol/input-commitment.md)を再計算して、公開された入力側の記録とゲストが使った入力を結びつけます。入力コミットメントに含まれないフィールドは、対応する選挙マニフェストや締切ステートメントとの照合で確認します。

## Stage 4: STARK Verification

ここまで何度も使ったジャーナルについて、最後に必要なのが「指定した集計プログラムが、実際にこの出力を計算した」という裏付けです。

Rust の検証サービスが、期待する [Image ID](../zkvm/image-id.md) を指定して STARK レシートを検証します。成功したレシートに結びつくジャーナルを使うことで、集計値、除外数、入力コミットメント、ビットマップルートをゲストの計算結果として扱えます。

この成功は、ゲストへ渡された入力に対する計算の正しさを示します。入力が掲示板全体を表すか、手元の票と一致するか、表示された得票数が同じかは、前の三段階との照合で確かめます。開発モードのフェイクレシートには、本番用 STARK 証明としての裏付けがありません。

四段階をどう最終表示へまとめるかは、[Verified の表示条件](gating-logic.md)で定めています。ここまでの順序は証拠の関係を説明する順序です。実際の画面は STARK の完了を待ってから各段階を順に表示します。

<!-- source: packages/api-contract/src/routes/inventory.ts, packages/api-contract/src/schemas/verification.ts, apps/api/src/server/api/handlers/verify.ts, apps/api/src/server/api/adapters/sthProvider.ts, packages/verification/src/verification/engine/evaluate-checks.ts, packages/verification/src/verification/verification-checks.ts, packages/verification/src/verification/build-verification-steps.ts, packages/verification/src/verification/verification-presentation-policy.ts, apps/web/src/routes/verify/lib/local-cast-evidence.ts, apps/web/src/routes/verify/hooks/useVerificationData.ts, apps/web/src/routes/verify/hooks/useVerificationSequence.ts, packages/verification/src/verification/consistency-verifier.ts -->
