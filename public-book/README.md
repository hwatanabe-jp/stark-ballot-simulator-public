# public-book

公開向けドキュメントをまとめた `mdBook` です。既存の `docs/` とは分離して運用します。

## セットアップ

```bash
cargo install --locked mdbook --version 0.5.3
cargo install --locked mdbook-mermaid --version 0.17.0
```

Mermaid のアセットをインストール:

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

前提:

- GitHub Pages の `Build and deployment` が `GitHub Actions` に設定されていること

private/source repository から GitHub Pages へ公開する場合の初回セットアップ:

1. GitHub の `Settings > Pages` を開く
2. `Build and deployment` の `Source` を `GitHub Actions` に設定
3. 必要に応じて Actions の `mdBook Pages Deploy` を手動実行（`Use workflow from` は `main` を選択）

private/source repository の deploy workflow のトリガー条件:

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

制約:

- `X-Frame-Options` や `X-Content-Type-Options` などの **HTTP ヘッダ** は GitHub Pages 単体では制御できません。

## 更新日の管理

ドキュメント内容を更新した際は `src/introduction.md` 冒頭の「最終更新」日付もあわせて更新してください。

## 日本語検索

mdBook 標準の elasticlunr.js はホワイトスペースでトークン分割するため日本語検索が機能しません。
本プロジェクトでは [fzf-for-js](https://github.com/ajitid/fzf-for-js) で elasticlunr の検索を置き換え、日本語の文字単位マッチングを実現しています。

- `fzf.umd.js` — fzf ライブラリ（vendored, v0.5.2）
- `elasticlunr-fzf.js` — elasticlunr.Index.load を fzf に差し替えるパッチ
