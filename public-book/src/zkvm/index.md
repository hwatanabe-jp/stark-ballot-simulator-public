# zkVM による集計証明

STARK Ballot Simulator は、投票の検査と集計を zkVM という仮想マシン内で実行し、その計算の証明を生成します。投票が掲示板に記録されていることだけでは、集計されたことは確認できません。どのプログラムがどの入力を処理し、何を出力したかを証拠で確認します。

zkVM 内で計算するプログラムをゲスト、入力を準備してゲストを実行し、証明を生成するプログラムをホストと呼びます。検証者は、期待するゲストの識別子である Image ID を事前に選び、そのゲストの実行証明かを検証します。

ゲストの公開出力には、候補ごとの得票数、提示されなかったスロット数、計上した位置の記録を含めます。たとえば、64 スロットの掲示板からユーザー票を除いた入力を正しく集計しても、1 スロットの未提示が証明に結び付いた出力に残ります。このため、有効な証明があっても投票結果を Verified と判定できるとは限りません。

<!-- source: zkvm/, packages/zkvm-contract/src/zkvm/, verifier-service/, infra/docker/entrypoint.sh, infra/lambdas/verification-worker/, public/imageId-mapping.json -->
