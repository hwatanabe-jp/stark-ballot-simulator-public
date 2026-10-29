# public-book

公開向けドキュメントをまとめた `mdBook` です。既存の `docs/` とは分離して運用します。

## 編集方針

本文は敬体で、定義、処理、条件を直接説明します。問いかけや進行説明を避け、各ページの冒頭に対象と用途を示します。具体例は仕様の説明と区別し、前章の例を読んでいなくても理解できるようにします。

概念の章は定義・形式・処理・制約、手順の章は前提・操作・期待結果・失敗時の対応を基本の順序とします。短いページに項目を一律追加せず、比較や状態の対応には表、操作の順序には番号付きリストを使います。見出しは対象が分かる短い名前にします。

詳しい規則は担当する章にまとめ、他のページにも解釈に必要な前提と制約を残します。必須と補助、未実行と失敗、受付と完了などの区別は省略しません。コード、識別子、数値、条件、保証範囲は実装と照合します。

章内リンクには現在の見出しから生成される ID を使います。見出しを変更するときは、目次・参照ラベル・参照元リンクを更新します。旧見出しとの後方互換性は維持せず、互換用のアンカータグは残しません。

主張の対象と条件は、その主張の近くに示します。後続の否定で冒頭の説明を狭めている場合は、段落全体を読み比べ、冒頭から適用範囲が分かるように直します。否定が続く箇所は、用途・条件・結果の対応を整理します。禁止、未確認、保証の限界を伝える否定は、意味と強さを保って残します。

日本語の推敲には [yomiyasu 2.4.0 の指針](https://github.com/nanaism/yomiyasu/blob/41e5aec228f080fe24e5f795efee2ac3fda61839/skills/yomiyasu/SKILL.md)を参照します。文長や箇条書きの割合、lint の指摘は見直しの候補として扱い、意味の保持と実際の読みやすさで判断します。

## セットアップ

```bash
cargo install --locked mdbook --version 0.5.4
cargo install --locked mdbook-mermaid --version 0.17.1
```

Mermaid のアセットをインストールします。

```bash
pnpm docs:book:mermaid:install
```

## 開発

```bash
pnpm docs:book:serve
```

## ビルド

```bash
pnpm docs:book:build
```

## GitHub Pages 公開

private/source repository では `mdBook` 公開用に `.github/workflows/mdbook-pages-test.yml`
（workflow 名: `mdBook Pages Deploy`）を用意しています。この workflow は GitHub Pages へ deploy します。

公開 repository snapshot では private workflow は除外され、生成された
`.github/workflows/public-docs-checks.yml` が `mdBook` のビルドとセキュリティタグ検証を実行します。
この public-only workflow はチェック用であり、GitHub Pages への deploy は行いません。

GitHub Pages の `Build and deployment` を `GitHub Actions` に設定する必要があります。
private/source repository から初めて公開する場合は、次の手順で設定します。

1. GitHub の `Settings > Pages` を開く
2. `Build and deployment` の `Source` を `GitHub Actions` に設定
3. 必要に応じて Actions の `mdBook Pages Deploy` を手動実行（`Use workflow from` は `main` を選択）

private/source repository の deploy workflow は、次の条件で実行します。

- `main` ブランチへの push（`public-book/**` または `scripts/docs/**` に変更がある場合）
- `workflow_dispatch`（手動実行）
- 実行ブランチは `main` のみ（それ以外はエラー終了）

### GitHub Pages 前提のセキュリティ対策

GitHub Pages ではレスポンスヘッダを任意に設定できないため、
`pnpm docs:book:build`、Pages workflow、public docs checks workflow で次の処理を自動実行します。

- `scripts/docs/harden-mdbook-output.sh`
  - 各 HTML に `Content-Security-Policy` (meta), `referrer` (meta) を挿入
  - best-effort の frame-busting スクリプトを挿入
- `scripts/docs/check-mdbook-security-tags.sh`
  - 上記タグが全 HTML に入っていることを検証

`X-Frame-Options` や `X-Content-Type-Options` などの HTTP ヘッダーは GitHub Pages 単体では制御できません。

## 更新日の管理

ドキュメント内容を更新した際は `src/introduction.md` 冒頭の「最終更新」日付もあわせて更新してください。

## 図の表示

説明用のフローチャートは上から下へ進む配置を基本にします。
`mermaid-init.js` は図を幅に合わせて縮小せず、`diagrams.css` が横長の図だけを
図の中でスクロールできるようにします。スマートフォンでも文字サイズを保つためです。

## 日本語検索

mdBook 標準の elasticlunr.js はホワイトスペースでトークン分割するため日本語検索が機能しません。
本プロジェクトでは [fzf-for-js](https://github.com/ajitid/fzf-for-js) で elasticlunr の検索を置き換え、日本語の文字単位マッチングを実現しています。

| ファイル             | 用途                                             |
| -------------------- | ------------------------------------------------ |
| `fzf.umd.js`         | fzf ライブラリ（vendored, v0.5.2）               |
| `elasticlunr-fzf.js` | elasticlunr.Index.load を fzf に差し替えるパッチ |
