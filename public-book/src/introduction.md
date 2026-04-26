# はじめに

> **最終更新:** 2026-04-26

このドキュメントは、`STARK Ballot Simulator` の公開向けガイドです。

## 目的

- システムの全体像を短時間で把握できるようにする
- 暗号プロトコルと検証パイプラインの設計根拠を説明する
- 検証手順を再現できる情報を提供する

## 想定読者

- 暗号検証・監査に関心のある技術者
- 本アプリケーションに興味のある技術者

## 公開状態

本書はライブデモと公開用ソース snapshot の読者に向けたドキュメントです。ソースコードへのアクセスが必要な再現手順は、対象リリースの公開 repository snapshot と照合して実行してください。`bundle.zip` だけで実行できる確認範囲は [第三者検証ガイド](reproducibility/index.md) にまとめています。

## 本書の読み方

### 標準ルート

1. まず [全体像](overview.md) でシステムの概要を掴む
2. [暗号プロトコル](protocol/index.md) でコミットメント・Merkle ツリー等の基盤を理解する
3. [zkVM 設計](zkvm/index.md) でゲストプログラムと証明生成の仕組みを学ぶ
4. [検証パイプライン](verification/index.md) で 4 段階検証モデルの全体を把握する
5. [改ざんシナリオ](tamper/index.md) で教育的シミュレーションの動作を確認する
6. [AWS アーキテクチャ](aws/index.md) で非同期証明インフラを理解する
7. [API リファレンス](api/index.md) でエンドポイント仕様を参照する
8. 実際に検証する場合は [第三者検証ガイド](reproducibility/index.md) で `bundle.zip` を使ったローカル検証手順を実行する
9. 設計上の判断については [設計判断](decisions/index.md) を参照する
10. 設計根拠の一次資料は [参考文献](appendix/references.md) を参照する

### 読者別ルート

- 監査者向け: [全体像](overview.md) → [検証パイプライン](verification/index.md) → [第三者検証ガイド](reproducibility/index.md) → [API リファレンス](api/index.md) → [用語集](appendix/glossary.md)
- 実装者向け: [暗号プロトコル](protocol/index.md) → [zkVM 設計](zkvm/index.md) → [検証パイプライン](verification/index.md) → [API リファレンス](api/index.md)
- 運用者向け: [AWS アーキテクチャ](aws/index.md) → [バンドル構造](verification/bundle-structure.md) → [第三者検証ガイド](reproducibility/index.md) → [API リファレンス](api/index.md)
