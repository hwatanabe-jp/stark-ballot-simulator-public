# Summary

[はじめに](introduction.md)
[投票して、結果を確かめる](usage-flow.md)
[一票を結果までつなぐ](overview.md)

---

- [投票の記録を確かめる](protocol/index.md)
  - [投票コミットメント](protocol/commitment.md)
  - [掲示板に票が残っていることを確かめる](protocol/ct-merkle.md)
  - [掲示板の見え方を照合する](protocol/sth-digest.md)

- [集計の計算を確かめる](zkvm/index.md)
  - [zkVM の基礎](zkvm/foundations.md)
  - [ゲストが票を調べ、数える](zkvm/guest-program.md)
  - [計算するプログラムを指定する](zkvm/image-id.md)
  - [証明と公開入力を結び付ける](protocol/input-commitment.md)
  - [自票の採用状況を確かめる](protocol/bitmap-merkle.md)
  - [ホストと証明生成](zkvm/host-and-proving.md)
  - [検証サービス](zkvm/verifier-service.md)

- [証拠をつないで結果を判定する](verification/index.md)
  - [4 段階検証モデル](verification/four-stage-model.md)
  - [検証の実行フロー](verification/design-and-flow.md)
  - [Verified の表示条件](verification/gating-logic.md)

- [改ざんして、検出を確かめる](tamper/index.md)
  - [シナリオごとに何が食い違うか](tamper/scenarios.md)
  - [シナリオとチェック結果の対応](tamper/detection-mechanism.md)

- [証拠を持ち帰って確かめる](reproducibility/index.md)
  - [公開できる証拠と、手元に残す情報](verification/public-boundary.md)
  - [バンドル構造](verification/bundle-structure.md)
  - [手元で証拠を検証する（Ubuntu）](reproducibility/audit-bundle.md)

- [AWS で証明生成を動かす](aws/index.md)
  - [ブラウザから AWS へ入る](aws/runtime-boundary.md)
  - [処理を分けて待ち時間を引き受ける](aws/design-and-services.md)
  - [状態と証拠をどこへ保存するか](aws/topology.md)
  - [非同期プローバー](aws/async-prover.md)
  - [起動するコンテナを確かめる](aws/image-signing.md)
  - [変更する内容を計画と承認に結び付ける](aws/terraform.md)
  - [待ち時間と失敗の原因を調べる](aws/observability.md)

- [検証する実装を、どう確かめるか](quality/index.md)
  - [単体、結合、E2E テスト](quality/unit-integration-e2e.md)
  - [入力を生成して、性質を試す](quality/property-based-testing.md)
  - [Lean による形式化](quality/lean-formalization.md)

- [API リファレンス](api/index.md)
  - [エンドポイント一覧](api/endpoints.md)
  - [セッションの保存と継続](api/session-lifecycle.md)
- [チェック一覧](verification/checks-catalog.md)

---

- [用語集](appendix/glossary.md)
- [参考文献](appendix/references.md)
- [ライセンス](appendix/license.md)
