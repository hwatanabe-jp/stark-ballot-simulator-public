# Summary

[はじめに](introduction.md)
[全体像](overview.md)
[アーキテクチャ語彙マップ（試験的）](architecture-map.md)

---

- [暗号プロトコル](protocol/index.md)
  - [コミットメントスキーム](protocol/commitment.md)
  - [掲示板 (CT Merkle ツリー)](protocol/ct-merkle.md)
  - [入力コミットメント](protocol/input-commitment.md)
  - [STH ダイジェスト](protocol/sth-digest.md)
  - [ビットマップ Merkle](protocol/bitmap-merkle.md)

- [zkVM 設計](zkvm/index.md)
  - [zkVM の基礎](zkvm/foundations.md)
  - [ゲストプログラム](zkvm/guest-program.md)
  - [ホストと証明生成](zkvm/host-and-proving.md)
  - [検証サービス](zkvm/verifier-service.md)
  - [Image ID](zkvm/image-id.md)

- [検証パイプライン](verification/index.md)
  - [設計と実行フロー](verification/design-and-flow.md)
  - [4 段階検証モデル](verification/four-stage-model.md)
  - [チェック一覧](verification/checks-catalog.md)
  - [バンドル構造](verification/bundle-structure.md)
  - [ゲーティングロジック](verification/gating-logic.md)

- [改ざんシナリオ](tamper/index.md)
  - [シナリオ一覧](tamper/scenarios.md)
  - [検出メカニズム](tamper/detection-mechanism.md)

- [品質保証と形式手法](quality/index.md)
  - [単体・結合・E2E テスト](quality/unit-integration-e2e.md)
  - [Property-based Testing](quality/property-based-testing.md)
  - [Lean による形式化](quality/lean-formalization.md)

- [AWS アーキテクチャ](aws/index.md)
  - [現行構成とサービス一覧](aws/design-and-services.md)
  - [トポロジー](aws/topology.md)
  - [非同期プローバー](aws/async-prover.md)
  - [イメージ署名](aws/image-signing.md)
  - [Terraform](aws/terraform.md)

- [API リファレンス](api/index.md)
  - [エンドポイント一覧](api/endpoints.md)
  - [セッションライフサイクル](api/session-lifecycle.md)

- [第三者検証ガイド](reproducibility/index.md)
  - [ZIP ローカル検証（Ubuntu）](reproducibility/audit-bundle.md)

- [設計判断](decisions/index.md)
  - [PoC の意図的な制約](decisions/poc-relaxations.md)
  - [設計ふりかえり](decisions/design-retrospective.md)

---

- [用語集](appendix/glossary.md)
- [参考文献](appendix/references.md)
- [ライセンス](appendix/license.md)
