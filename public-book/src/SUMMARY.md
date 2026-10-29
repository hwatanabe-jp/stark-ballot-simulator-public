# Summary

[はじめに](introduction.md)
[基本操作](usage-flow.md)
[システム概要](overview.md)

---

- [投票記録と掲示板](protocol/index.md)
  - [投票コミットメント](protocol/commitment.md)
  - [CT Merkle ツリー](protocol/ct-merkle.md)
  - [STH ダイジェスト](protocol/sth-digest.md)

- [zkVM による集計証明](zkvm/index.md)
  - [zkVM の基礎](zkvm/foundations.md)
  - [ゲストプログラム](zkvm/guest-program.md)
  - [Image ID とゲストの識別](zkvm/image-id.md)
  - [入力コミットメント](protocol/input-commitment.md)
  - [ビットマップ Merkle 証明](protocol/bitmap-merkle.md)
  - [ホストと証明生成](zkvm/host-and-proving.md)
  - [検証サービス](zkvm/verifier-service.md)

- [検証モデルと判定条件](verification/index.md)
  - [4 段階検証モデル](verification/four-stage-model.md)
  - [検証の実行フロー](verification/design-and-flow.md)
  - [Verified の表示条件](verification/gating-logic.md)

- [改ざんシナリオ](tamper/index.md)
  - [シナリオの変更内容と検出結果](tamper/scenarios.md)
  - [シナリオとチェック結果の対応](tamper/detection-mechanism.md)

- [証拠の取得と独立検証](reproducibility/index.md)
  - [公開証拠と非公開情報](verification/public-boundary.md)
  - [バンドル構造](verification/bundle-structure.md)
  - [ローカル監査手順（Ubuntu）](reproducibility/audit-bundle.md)

- [AWS 実行基盤](aws/index.md)
  - [実行環境とリクエスト境界](aws/runtime-boundary.md)
  - [AWS サービスの役割分担](aws/design-and-services.md)
  - [データ配置と保存先](aws/topology.md)
  - [非同期プローバー](aws/async-prover.md)
  - [コンテナイメージの署名検証](aws/image-signing.md)
  - [Terraform とデプロイ管理](aws/terraform.md)
  - [監視と障害調査](aws/observability.md)

- [テストと形式検証](quality/index.md)
  - [単体、結合、E2E テスト](quality/unit-integration-e2e.md)
  - [プロパティベーステスト](quality/property-based-testing.md)
  - [Lean による形式化](quality/lean-formalization.md)

- [API リファレンス](api/index.md)
  - [エンドポイント一覧](api/endpoints.md)
  - [セッションの保存と継続](api/session-lifecycle.md)
- [チェック一覧](verification/checks-catalog.md)

---

- [用語集](appendix/glossary.md)
- [参考文献](appendix/references.md)
- [ライセンス](appendix/license.md)
