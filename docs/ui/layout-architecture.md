# レイアウトアーキテクチャ

ページ本文と知識パネルを一つの通常フローで読み進める。画面幅やスクロール位置によって
知識パネルを別の場所へ移さず、主操作やフッターに重ならない配置にする。
実装の責務は [LayoutProvider.tsx](../../apps/web/src/components/LayoutProvider.tsx) と
[LayoutProvider.css](../../apps/web/src/components/LayoutProvider.css) が持つ。

## 共通構造

```text
Header
StepIndicatorHorizontal（ホーム・法務ページでは非表示）
main
  ページ本文
  KnowledgePanel（ホーム・法務ページでは非表示）
Footer
```

知識パネルは `main` の末尾に一度だけ描画する。PCとモバイルで同じコンポーネントを
使用し、通常のページスクロールで到達する。浮遊パネル、ドッキング判定用の要素、
高さ計測に応じたスペーサー、モバイルのボトムシートは使用しない。
画面幅の変化で再マウントしないため、パネル自身が持つ開閉状態を引き継げる。

[Header](../../apps/web/src/components/layout/Header.tsx) と
[Footer](../../apps/web/src/components/layout/Footer.tsx) は、それぞれの既存コンポーネントが
表示と操作を所有する。共通の [SiteChrome.css](../../apps/web/src/components/layout/SiteChrome.css)
で白地、黒い罫線、最大1080pxの内容幅を指定する。両方とも通常フローに置き、狭幅では
操作とリンクを折り返す。ヘッダーの言語切替・リセットとフッターのリンクを、
レイアウト側に再実装しない。法務リンクは有効なセッションがある場合に別タブで開き、
セッションがない場合は同じタブで開く既存の動作を維持する。
セッション有無は作成・消去と他タブのstorage変更を購読し、フッターを再マウントせずに更新する。
storageへのアクセスが拒否される場合は、別タブで開く既存の安全側の既定値を使う。

## 本文幅と余白

幅は画面全体に引き伸ばさず、ページの内容に合わせた最大幅で中央に置く。
各ページ内の選択欄・図・文章には、そのコンポーネントがさらに狭い幅を指定できる。

| ルート                           | `main` の最大幅 | 知識パネル | ステップナビ |
| -------------------------------- | --------------- | ---------- | ------------ |
| `/`                              | 640px           | 非表示     | 非表示       |
| `/vote`、`/aggregate`、`/result` | 760px           | 本文の後   | 表示         |
| `/verify` とその配下             | 840px           | 本文の後   | 表示         |
| `/privacy`、`/terms` とその配下  | 768px           | 非表示     | 非表示       |

左右には最低36px、幅540px以下では最低20pxの余白を確保する。`main` の上余白は30px、
幅540px以下では26px、下余白は48px。知識パネルの手前には30pxの余白を置く。
ページ内部の余白は各ページの担当範囲であり、この値に含まない。

`LayoutProvider.css` の `--app-content-width` がレイアウト内の幅を保持する。
ステップナビもこの変数を継承して同じ最大幅を使い、ナビ内部の描画を再実装しない。
レイアウトは白地と黒文字を基本にし、紙のテクスチャやパネル浮遊用の装飾を持たない。

## ステップナビとルート遷移

[StepIndicatorHorizontal](../../apps/web/src/components/step/StepIndicatorHorizontal.tsx) が
ホーム・投票・集計・結果・検証の現在位置をパスから求める。末尾スラッシュと
`/verify/*` などの配下パスの照合は同コンポーネントが所有する。

完了済みステップは既存の遷移操作を使い、未到達ステップを先へ進める操作にはしない。
完了済みホームの操作では、既存の確認を経て共通のリセットを呼ぶ。
ナビの現在位置はUI上の進行状態であり、暗号学的な検証の成功資格ではない。
見た目は既存のステップ名を短い横並びの一覧にし、現在位置を淡い黄色で示す。
数字の丸、完了チェックの登場演出、点滅、固定追従は使わない。既存の
`data-step-id`・`data-status`・現在位置のARIAとナビゲーションの意味は維持する。

パスが変わった時点で、ページを先頭へ即時スクロールする。初回マウントだけでは
スクロールしない。言語の変更は `document.documentElement.lang` にも反映する。

## ホームと投票の本文

[HomePage](../../apps/web/src/routes/HomePage.tsx) は既存インフォグラフィックの主題を
見出しに使い、短い既存説明と装飾の [HomeIllustration](../../apps/web/src/components/home/HomeIllustration.tsx)
を並べ、その下に開始操作を中央配置する。絵には文字・数値・成功状態を含めず、
読み上げ対象にしない。比較は内容幅に合わせ、四ステップ・検証項目・改ざん説明は
既存見出しで開く三つの `details` に置く。セッション作成と必要なTurnstileは
既存の実処理を使い、処理中とエラーも現行文言を維持する。

[投票画面](../../apps/web/src/routes/vote/page.tsx) は最大420pxの選択欄を中央に配置する。
[RadioGroup](../../apps/web/src/components/ui/RadioGroup.tsx) は実際のラジオボタンを表示し、
既存ラベルと説明を関連付ける。初期状態は未選択で、選択後もページを強制スクロールしない。
投票の送信・無効状態・CAPTCHA・セッション固定の条件は
[VoteForm](../../apps/web/src/components/vote/VoteForm.tsx) が維持する。

[BotVotingProgress](../../apps/web/src/components/vote/BotVotingProgress.tsx) は既存の待機見出しと
「処理中...」を表示する。APIをポーリングして既存の完了条件を満たすまで待ち、完了後は
演出のための待機を入れず集計画面へ進む。架空の票分布、十秒間の棒グラフ演出、
フェードインは使わない。セッション置換後やアンマウント後の応答では遷移しない。

## 知識の表示境界

レイアウトは既存の `filterKeys` を知識パネルに渡す。値がstoreに存在することと、
その画面に表示できることは別であり、配置変更を理由に表示対象を増やさない。

| 画面             | レイアウトが渡す対象               |
| ---------------- | ---------------------------------- |
| ホーム           | パネルを描画しない                 |
| 投票・集計       | 既存の `session`、`vote` グループ  |
| 結果             | 上記と `result`、`public` グループ |
| 検証・自分の表示 | `VERIFY_MY_KNOWLEDGE_KEYS`         |
| 検証・ボット表示 | `VERIFY_BOT_KNOWLEDGE_KEYS`        |
| 法務ページ       | パネルを描画しない                 |

グループ定義は [KnowledgeGroup](../../apps/web/src/components/knowledge/KnowledgeGroup.tsx)、
共有の可視性定義は [visibility.ts](../../apps/web/src/knowledge/visibility.ts) が所有する。
明示したルート以外への既存のグループ解決も維持する。非表示キーの除外と検証開始前の
受領データ・包含証明の制限は、知識側の既存境界を通して適用する。

[KnowledgePanel](../../apps/web/src/components/knowledge/KnowledgePanel.tsx) がグループの
開閉を所有し、[KnowledgeHighlightProvider](../../apps/web/src/components/knowledge/KnowledgeHighlightContext.tsx)
が検証項目との連動を受け渡す。レイアウトは開閉状態、パネル内部のスクロール位置、
浮遊状態の複製を持たない。表示項目、既存値の見せ方、選択時の展開については
[知識パネルの契約](./knowledge-panel.md) を参照する。

## リセットと共有状態

共通のリセットはセッションと知識を消去し、検証タブを `my` に戻してホームへ遷移する。
ホームに入った時も知識と検証タブをリセットする。法務ページではヘッダーのリセットを
表示しない。これらの処理と表示フィルタは、レスポンシブな配置から独立して維持する。

ホームのsession作成、投票送信、集計開始、結果取得は、画面を離れた時にその通信を中断する。
応答が中断後に解決しても、知識・session・表示・ナビゲーションへ適用しない。既存sessionを使う
操作は、await後も送信時のidentityに一致することを確認する。Bot進捗は前の取得が終わるまで
次の取得を開始しない。これらの通信制御は、集計の6分基準の推定進捗とは独立している。

全体の `Verified` 表示条件はレイアウトで決めない。
[検証ページ](./verify-page/verify-page.md) と共有の検証表示ポリシーに従う。

## 確認範囲

[LayoutProvider.test.tsx](../../apps/web/src/components/LayoutProvider.test.tsx) は、本文・知識・
フッターの順序、パネルが一度だけ描画されること、ルート移動時のパネル維持、
ホームと法務ページの非表示、画面・検証タブごとのフィルタ、リセット、言語、
ルート変更時のスクロールを確認する。

CSSによる実寸、狭幅での折り返し、本文とパネルが重ならないこと、キーボードでの
到達と開閉はブラウザで確認する。jsdomの構造テストをレイアウトの実描画証拠と扱わない。
実施コマンドとサーバー管理は [E2Eガイド](../../tests/e2e/README.md) に従う。
