# 暗号プロトコル

投票の検証可能性を支える暗号プリミティブをまとめる部です。

公開データに対する投票の秘匿性（hiding）と束縛性（binding）を支えるコミットメントスキームから、RFC 6962 に基づく CT スタイルの Merkle ツリー、zkVM 入力の正準エンコーディングまで、検証可能性の基盤となる暗号構成要素を網羅します。

## この部に含まれる章

- [コミットメントスキーム](commitment.md) — 投票コミットメントの構成と安全性
- [CT Merkle ツリー](ct-merkle.md) — CT スタイルの追記専用掲示板
- [入力コミットメント](input-commitment.md) — zkVM 入力の正準エンコーディング
- [STH ダイジェスト](sth-digest.md) — 分割ビュー緩和のためのツリーヘッドダイジェスト
- [ビットマップ Merkle](bitmap-merkle.md) — 投票カウント証明のためのビットマップツリー

## 想定読者と前提

- 想定読者: 暗号プリミティブの仕様を実装・監査する技術者
- 前提: SHA-256 ハッシュ計算と Merkle ツリーの基本概念を把握していること

## 関連する章

- [zkVM 設計](../zkvm/index.md) — このプロトコルが zkVM 入力としてどう使われるか
- [検証パイプライン](../verification/index.md) — このプロトコルに対応する検証チェック
- [用語集](../appendix/glossary.md) — 暗号プリミティブの用語定義

<!-- source: src/lib/zkvm/types.ts, src/lib/zkvm/bitmap.ts, src/lib/merkle/, src/lib/bulletin/, src/lib/verification/sth-verifier.ts -->
