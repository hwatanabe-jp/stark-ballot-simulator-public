# zkVM 設計

この章群では、投票集計の正当性を RISC Zero zkVM で検証し、レシートとジャーナルを検証パイプラインへ渡す流れを説明します。
mock、`RISC0_DEV_MODE=1`、production STARK proof は、それぞれ異なる検証前提として区別します。

## 章の構成

- [zkVM の基礎](foundations.md) では、zkVM の概念、RISC Zero の選択理由、データフロー、保証境界を扱います。
- [ゲストプログラム](guest-program.md) では、zkVM 内で実行される検証と集計ロジックを扱います。
- [ホストと証明生成](host-and-proving.md) では、ホストプログラムと同期または非同期の証明パスを扱います。
- [検証サービス](verifier-service.md) では、Rust ベースのレシート検証を扱います。
- [Image ID](image-id.md) では、ゲストバイナリの暗号的識別子と管理を扱います。

## 想定読者と前提

- 想定読者は、集計の正当性を STARK で証明したい実装者と運用者です。
- 前提は、[暗号プロトコル](../protocol/index.md) の入力コミットメントと Merkle ツリーを把握していることです。

## 本章で扱わないもの

- RISC Zero SDK の API リファレンスやアップグレード手順
- STARK / FRI の数学的構成証明
- ECS Fargate などインフラ側の構成

STARK / FRI の概念は [zkVM の基礎](foundations.md) で扱います。
インフラ側の構成は [AWS アーキテクチャ](../aws/index.md) を参照してください。

## 関連する章

- [暗号プロトコル](../protocol/index.md) は、ゲストプログラムが入力として受け取るプリミティブを説明します。
- [検証パイプライン](../verification/index.md) は、生成されたレシートとジャーナルの検証方法を説明します。
- [AWS アーキテクチャ](../aws/index.md) は、非同期プローバーの実行環境を説明します。
- [第三者検証ガイド](../reproducibility/index.md) は、`bundle.zip` でレシートをローカル監査する手順を説明します。

<!-- source: zkvm/, packages/zkvm-contract/src/zkvm/, verifier-service/, infra/docker/entrypoint.sh, infra/lambdas/verification-worker/, public/imageId-mapping.json -->
