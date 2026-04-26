# 設計判断

PoC として何を割り切り、構築を通じて何を学んだかを記録する部です。

「何を PoC 都合で割り切ったか」「構築を通じて何がわかったか」を明文化し、実装・運用・監査の前提を共有します。

## 判断の記録方針

各章は目的に応じて、記録軸を使い分けます。

| 章                 | 記録軸                                 |
| ------------------ | -------------------------------------- |
| PoC の意図的な制約 | 制約の内容 / 受け入れた理由 / 影響範囲 |
| 設計ふりかえり     | 背景 / 知見 / 改善方針                 |

## この部に含まれる章

- [PoC の意図的な制約](poc-relaxations.md) — 公開版で明示する 3 つの制約
- [設計ふりかえり](design-retrospective.md) — 構築を通じて得た構造上の知見

## 想定読者と前提

- 想定読者: 本システムを評価する監査者・採用検討者・実装の追従者
- 前提: 本書の [暗号プロトコル](../protocol/index.md) [zkVM 設計](../zkvm/index.md) [検証パイプライン](../verification/index.md) を一読し、PoC のスコープ（[はじめに](../introduction.md) 参照）を把握していること

## 関連する章

- [暗号プロトコル](../protocol/index.md) — 各プリミティブの仕様と安全性
- [AWS アーキテクチャ](../aws/index.md) — インフラ構成の詳細
- [検証パイプライン](../verification/index.md) — 検証ロジックとゲーティング
- [参考文献](../appendix/references.md) — 設計背景の一次資料一覧

<!-- source: public-book/src/decisions/poc-relaxations.md, docs/current/references/README.md -->
