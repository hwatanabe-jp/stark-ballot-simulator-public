# zkVM 設計

投票集計の正当性を STARK 証明として外部に持ち出す zkVM パイプラインを扱う部です。

## この部に含まれる章

- [zkVM の基礎](foundations.md) — zkVM の概念、RISC Zero の選択理由、データフロー、保証境界
- [ゲストプログラム](guest-program.md) — zkVM 内で実行される検証・集計ロジック
- [ホストと証明生成](host-and-proving.md) — ホストプログラムと同期/非同期の証明パス
- [検証サービス](verifier-service.md) — Rust ベースのレシート検証
- [Image ID](image-id.md) — ゲストバイナリの暗号的識別子と管理

## 想定読者と前提

- 想定読者: 集計の正当性を STARK で証明したい実装者・運用者
- 前提: [暗号プロトコル](../protocol/index.md) の入力コミットメントと Merkle ツリーを把握していること

## 本章で扱わないもの

- RISC Zero SDK の API リファレンスやアップグレード手順
- STARK / FRI の数学的構成証明（概念のみ [zkVM の基礎](foundations.md) で扱う）
- ECS Fargate などインフラ側の構成（[AWS アーキテクチャ](../aws/index.md) を参照）

## 関連する章

- [暗号プロトコル](../protocol/index.md) — ゲストプログラムが入力として受け取るプリミティブ
- [検証パイプライン](../verification/index.md) — 生成されたレシートとジャーナルがどのように検証されるか
- [AWS アーキテクチャ](../aws/index.md) — 非同期プローバーの実行環境
- [第三者検証ガイド](../reproducibility/index.md) — `bundle.zip` でレシートをローカル監査する手順

<!-- source: zkvm/, src/lib/zkvm/, verifier-service/, docker/entrypoint.sh, amplify/functions/verifier-service-runner/, public/imageId-mapping.json -->
