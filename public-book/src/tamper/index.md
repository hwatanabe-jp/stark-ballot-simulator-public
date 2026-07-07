# 改ざんシナリオ

STARK Ballot Simulator は、E2E 検証可能投票の教育的デモとして、正常系 `S0` と改ざんシナリオ `S1` から `S5` を提供します。
`S1` から `S5` は特定の異常ケースを模擬し、検証パイプラインがどのチェックで異常を検出するかを示します。

## この部で読む章

- [シナリオ一覧](scenarios.md): `S0` から `S5` の定義、データフロー、実装上の扱い
- [検出メカニズム](detection-mechanism.md): シナリオ別に失敗するチェックと最終判定

## 想定読者と前提

想定読者は、検証パイプラインの教育的デモを試したい技術者です。
読む前に、[検証パイプライン](../verification/index.md) の 4 段階モデルを把握していることを前提にします。

## 本章で扱わないもの

- 実世界の投票システムに対する攻撃手法の一般論
- 本番投票システム向けの脅威モデリングや対策ガイド
- `S2` と `S4` を proof-tampering とみなすなど、PoC スコープを超える攻撃シナリオ

## 関連する章

- [検証パイプライン](../verification/index.md): 各シナリオに対応するチェックの一覧
- [第三者検証ガイド](../reproducibility/index.md): シナリオごとに生成された `bundle.zip` を監査する手順
- [用語集](../appendix/glossary.md): シナリオと改ざんに関する用語定義

<!-- source: packages/domain/src/lib/finalize/scenario-application.ts -->
