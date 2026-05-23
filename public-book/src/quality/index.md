# 品質保証と形式手法

この部では、STARK Ballot Simulator の検証ロジックをどの品質境界で支えているかを説明します。

本プロジェクトは AI コーディングエージェントと協業して実装を進めました。実装速度を上げるだけでなく、AI 協業で混入しやすい次のような乖離を検出できる境界が必要です。

- 仕様と実装のドリフト
- 暗黙の fallback
- 公開してはいけないアーティファクトの混入
- `Verified` 判定ロジックの分散

## この部に含まれる章

- [単体・結合・E2E テスト](unit-integration-e2e.md) — example-based テストでの局所退行検出と CLI / E2E 経路
- [Property-based Testing](property-based-testing.md) — `fast-check` と Rust `proptest` による入力空間探索
- [Lean による形式化](lean-formalization.md) — 抽象モデルでの不変条件証明と CI 連携

## 想定読者と前提

- 想定読者: 実装に追従するテストや形式化の設計判断を確認したい開発者・監査者
- 前提: 単体テスト・結合テスト・E2E テストの一般的な区分、および Property-based Testing の基本概念を把握していること

## 品質保証のレイヤー

本書では、example-based tests、property-based testing、Lean による形式化、それらを CI に接続する仕組みを次のレイヤーで使い分けます。

| レイヤー   | 目的                                                    | 主な対象                                                                      |
| ---------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 単体テスト | 純粋関数、UI component、API helper の局所退行を検出     | `src/lib`, `src/components`, `src/app/api`                                    |
| 結合テスト | API route、store、finalization、bundle 境界を検査       | `src/server/api`, `src/lib/finalize`, `src/lib/store`, `src/lib/verification` |
| CLI / E2E  | session 作成から投票、集計、検証までの流れを検査        | `scripts/tests/cli-e2e-voting-flow.ts`, `tests/e2e`                           |
| PBT        | 手書き fixture では漏れやすい入力空間を property で探索 | `fast-check`, Rust `proptest`                                                 |
| Lean       | 抽象モデル上の重要な不変条件を証明                      | `formal/StarkBallotFormal`                                                    |
| CI / audit | 成果物 freshness、proof hygiene、公開境界を検査         | `formal:verify`, public safety scan, docs build checks                        |

## 中心に置く不変条件

最も重要な品質目標は、ユーザーに **Verified** と表示してよい条件を緩めないことです。

- required check が失敗・未実行・実行中なら Verified にしない
- `excludedSlots > 0` を成功状態にしない
- STARK receipt verification だけを根拠に全体成功としない
- `input.json`、`verification.json`、`included-bitmap.json`、`seen-bitmap.json` を公開配布対象に含めない
- mock / dev receipt / production STARK proof の違いをテスト階層で明示する

これらは [ゲーティングロジック](../verification/gating-logic.md) と [バンドル構造](../verification/bundle-structure.md) で説明した安全境界を、テストと形式化の側から支えるものです。

## 本章で扱わないもの

この部は、システム全体の完全な形式検証を主張するものではありません。SHA-256 や RISC Zero の暗号学的健全性、各種ランタイムや AWS の正しさ、本番選挙システムとしての安全性は対象外です。Lean が扱う射程と扱わない射程の詳細は [Lean による形式化 > 証明していないこと](./lean-formalization.md#証明していないこと) を参照してください。

## 関連する章

- [検証パイプライン](../verification/index.md) — テストと形式化が守る `Verified` 判定の本体
- [ゲーティングロジック](../verification/gating-logic.md) — 不変条件として品質保証が支える側のロジック
- [バンドル構造](../verification/bundle-structure.md) — 公開境界の判定に関わる安全境界

<!-- source: README.md, docs/current/formal/README.md, formal/README.md, package.json, .github/workflows/rust-tests.yml -->
