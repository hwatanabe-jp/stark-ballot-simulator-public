# STARK Ballot Simulator - zkVM 最終設計書

**Version**: 2.0
**Status**: 現行実装契約 / コード例なし版
**Last reviewed**: 2026-04-25

---

## この文書の位置づけ

本文書は、STARK Ballot Simulator における zkVM / RISC Zero 連携の設計契約をまとめる。
実装チュートリアルではなく、設計上の不変条件、公開境界、検証責務、参照すべき実装ファイルを
明確にするための文書である。

この文書ではサンプルコードを掲載しない。フィールド名、チェック ID、ファイル名、コマンド名は
実装契約を示すためにインライン表記するが、処理例や実装例は現行コードとテストを参照する。

コードと文書が不一致の場合は、現行コードを優先する。特に検証フローの詳細は
`docs/current/verification/README.md` を実装寄りの補助資料として参照する。

## Source Of Truth

| 領域                                  | 参照先                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| zkVM 型・コミットメント計算           | `src/lib/zkvm/types.ts`                                                                               |
| zkVM guest 集計ロジック               | `zkvm/methods/guest/src/main.rs`                                                                      |
| Journal パース                        | `src/lib/verification/journal-parser.ts`                                                              |
| 検証チェック ID / required 判定の基礎 | `src/lib/verification/verification-checks.ts`                                                         |
| 検証チェック評価                      | `src/lib/verification/build-verification-checks.ts`, `src/lib/verification/engine/evaluate-checks.ts` |
| 検証ステップ生成                      | `src/lib/verification/build-verification-steps.ts`                                                    |
| overall verdict                       | `src/lib/verification/verification-summary.ts`, `src/app/(routes)/verify/page.tsx`                    |
| `/api/verify`                         | `src/server/api/handlers/verify.ts`                                                                   |
| server-side receipt verification      | `src/server/api/handlers/verificationRun.ts`, `verifier-service/`                                     |
| bitmap proof                          | `src/server/api/handlers/bitmapProof.ts`, `src/lib/verification/bitmap-verifier.ts`                   |
| 公開 bundle 生成                      | `src/lib/verification/verification-bundle.ts`, `docker/entrypoint.sh`                                 |
| bundle/report 配布                    | `src/server/api/handlers/verificationBundles.ts`                                                      |
| ImageID mapping / variant policy      | `public/imageId-mapping.json`, `src/lib/verification/image-id-policy.js`                              |

Contract cross-check (2026-04-25):

- `methodVersion = 12` and current ImageID mapping were checked against `public/imageId-mapping.json`.
- Slot/record count names (`missingSlots`, `invalidPresentedSlots`, `rejectedRecords`, `excludedSlots`) were checked against the current TypeScript/Rust contract.
- Required verification check IDs were checked against `src/lib/verification/verification-checks.ts`.
- Public/private bundle boundaries were checked against `docs/current/verification/README.md`.

## 最重要不変条件

- UI は、すべての required check が成功するまで `Verified` を表示してはならない。
- `excludedSlots > 0` は現行 contract の hard failure である。互換入力として legacy `excludedCount > 0` を受けた場合も、成功扱いにしてはならない。
- required check が `failed`, `not_run`, `pending`, `running` のままなら overall verdict は success にならない。
- `recorded_consistency_proof`, `counted_missing_indices_zero`, `counted_expected_vs_tree_size`, `counted_election_manifest_consistent`, `counted_close_statement_consistent`, `counted_my_vote_included`, `counted_input_commitment_match`, `stark_image_id_match`, `stark_receipt_verify` は、失敗時に `Verified` を阻止する。
- `input.json`, `verification.json`, `included-bitmap.json`, `seen-bitmap.json` は public `bundle.zip` に含めない。
- `RISC0_DEV_MODE=1` で生成される receipt は実 STARK proof ではない。公開環境の正当性根拠として扱わない。
- `Receipt::verify(expectedImageId)` の成否だけを STARK receipt verification の信頼できる判定基準にする。

---

## 1. 設計原則

zkVM は改ざんシナリオを知らない中立的な検証器である。アプリケーション層は教育用シナリオや
UI 表現を担当し、zkVM は「どの入力が検証に通り、どの集計結果が proof-bound か」を返す。

主要原則は次の通り。

| 原則        | 内容                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| 最小責務    | zkVM は tally correctness と入力整合性を検証する。シナリオ名やユーザー向け説明はアプリ層で扱う。       |
| 公開秘匿    | `choice` と `random` は witness として扱い、Journal と public bundle には出さない。                    |
| 検証可能性  | Journal、receipt、public input、manifest、close statement、bulletin artifacts から第三者が検証できる。 |
| 決定論性    | 同じ canonical input から同じ Journal と input commitment を得る。                                     |
| fail-closed | 証拠不足、bundle 不整合、未実行 check、dev receipt 混入は成功扱いにしない。                            |

---

## 2. zkVM I/O 契約

### 2.1 入力

zkVM input は witness を含む private artifact であり、public bundle に含めない。
公開可能な派生物は `public-input.json` として別に扱う。

| フィールド           | 公開範囲     | 役割                                                                   |
| -------------------- | ------------ | ---------------------------------------------------------------------- |
| `electionId`         | public       | election scope を固定する UUID。                                       |
| `bulletinRoot`       | public       | 集計対象の bulletin snapshot root。                                    |
| `treeSize`           | public       | `bulletinRoot` に対応する snapshot size。bitmap サイズの基準にもなる。 |
| `logId`              | public input | STH digest に含まれる bulletin log identifier。                        |
| `timestamp`          | public input | close statement / STH digest の時刻成分。                              |
| `totalExpected`      | public       | election config に固定された期待票数。                                 |
| `electionConfigHash` | public       | `totalExpected` など election config の binding。                      |
| `votes[].commitment` | public input | 掲示板に記録された vote commitment。                                   |
| `votes[].choice`     | witness      | tally に使う選択肢。Journal には出さない。                             |
| `votes[].random`     | witness      | commitment opening。Journal には出さない。                             |
| `votes[].index`      | public input | bulletin slot。bitmap と inclusion proof の位置。                      |
| `votes[].merklePath` | public input | CT-style inclusion proof。                                             |

`choice` と `random` は proof generation 時に host が zkVM に渡すため、現行 PoC ではサーバー秘匿ではない。
一方で、receipt と Journal を公開しても個票内容は公開されない。

### 2.2 Journal

現行 Journal contract は `methodVersion = 12` である。`methodVersion = 11` は legacy mapping として残るが、
current generation の proof/journal contract ではない。

| フィールド                                  | 意味                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `electionId`, `electionConfigHash`          | 入力から echo される election scope。                                                          |
| `bulletinRoot`, `treeSize`, `totalExpected` | 集計対象 snapshot と期待値。zkVM は両方を出力し、不一致を隠さない。                            |
| `sthDigest`                                 | `logId`, `treeSize`, `timestamp`, `bulletinRoot` の binding。                                  |
| `verifiedTally`                             | proof-bound tally。候補 A-E の集計結果。                                                       |
| `totalVotes`                                | guest に提示された vote record 数。                                                            |
| `validVotes`                                | 検証を通過し、tally に計上された record 数。                                                   |
| `invalidVotes`                              | 検証に失敗した record 数の互換フィールド。                                                     |
| `seenIndicesCount`                          | guest に提示された unique in-range index 数。                                                  |
| `missingSlots`                              | guest に提示されなかった bulletin slot 数。slot-based count。                                  |
| `invalidPresentedSlots`                     | 提示された in-range slot のうち、計上に失敗した slot 数。slot-based count。                    |
| `rejectedRecords`                           | reject された record 数。duplicate や out-of-range record を含む record-based count。          |
| `seenBitmapRoot`                            | presented-index bitmap root。現行 contract では必須。                                          |
| `includedBitmapRoot`                        | counted-index bitmap root。                                                                    |
| `excludedSlots`                             | `missingSlots + invalidPresentedSlots`。overall success を阻止する slot-based failure signal。 |
| `inputCommitment`                           | canonical public input binding。                                                               |
| `methodVersion`                             | 現行値は `12`。                                                                                |
| `imageId`                                   | host-provided comparison metadata。canonical proof output ではない。                           |

現行 canonical Journal は `missingIndices`, `invalidIndices`, `countedIndices`, `excludedCount` を持たない。
これらは legacy / stale cache 互換入力として正規化されることがあるが、current public contract として再公開しない。

### 2.3 Count Semantics

現行 contract では、slot-based count と record-based count を分離する。

| 種別         | フィールド              | 説明                                                                                       |
| ------------ | ----------------------- | ------------------------------------------------------------------------------------------ |
| slot-based   | `missingSlots`          | bulletin slot が prover に提示されなかったことを表す。                                     |
| slot-based   | `invalidPresentedSlots` | slot は提示されたが、commitment / opening / inclusion 等により計上されなかったことを表す。 |
| slot-based   | `excludedSlots`         | `missingSlots + invalidPresentedSlots`。`> 0` なら success ではない。                      |
| record-based | `rejectedRecords`       | duplicate や out-of-range を含む、reject された入力 record の個数。                        |

`validVotes + invalidPresentedSlots + missingSlots = treeSize` が slot partition の基本不変条件である。
`rejectedRecords` は record-based のため、`invalidPresentedSlots` より大きくなる場合がある。

### 2.4 `treeSize` と `totalExpected`

`treeSize` は STH / bulletin snapshot 由来の事実であり、`totalExpected` は election config に事前固定された期待値である。
zkVM はどちらも Journal に出力するが、不一致で proof generation を中断しない。

ただし verifier / UI は `counted_expected_vs_tree_size` を required hard failure として扱う。
`totalExpected != treeSize` の場合、overall verdict は success にならない。

---

## 3. Commitment と Canonical Encoding

### 3.1 Vote Commitment

vote commitment は domain-separated SHA-256 commitment である。domain tag は
`stark-ballot:commit|v1.0` に固定する。入力は、domain tag、`electionId` の 16 バイト表現、
1 バイトの `choice`、32 バイトの `random` をこの順で連結したものに固定する。

要件:

- `choice` は A-E に対応する `0..4` の範囲でなければならない。
- `random` は 32 バイトの暗号学的乱数でなければならない。
- `Math.random()` や時刻ベース seed は使わない。
- ブラウザでは Web Crypto の CSPRNG、サーバーでは OS entropy に基づく CSPRNG を使う。

### 3.2 Input Commitment

`inputCommitment` は public input の canonical binding である。同じ投票集合に対して異なる表現で別 hash を
作れないよう、固定順序・固定長・明示長を持つ encoding を使う。

要件:

- domain tag は `stark-ballot:input|v1.0`。
- format version は `10`。
- `electionId`, `bulletinRoot`, `treeSize`, `totalExpected`, `votesCount`, vote records を含める。
- vote records は canonical order に並べる。現行 TypeScript 実装は `index`、`commitment` bytes、
  Merkle path bytes の順で tie-break する。
- `treeSize` と `totalExpected` は little-endian 32-bit integer として固定する。
- commitment は 32 バイト固定、Merkle path は node count と 32 バイト node 列で固定する。

詳細な byte layout と互換テストは `src/lib/zkvm/types.ts` と
`src/lib/zkvm/__tests__/ts-rust-compatibility.test.ts` を参照する。

---

## 4. CT-style Bulletin Board

掲示板は RFC 6962 / Certificate Transparency スタイルの append-only Merkle log として扱う。
STARK Ballot Simulator では、CT エコシステム全体を再実装するのではなく、ハッシュ規則、inclusion proof、
consistency proof を検証可能な形で使う。

ハッシュ規則:

- leaf: `SHA256(0x00 || "stark-ballot:leaf|v1" || leafData)`
- internal node: `SHA256(0x01 || left || right)`

要件:

- leaf と internal node は domain separator で分離する。
- inclusion proof は leaf data、index、audit path、root、tree size に対して検証する。
- consistency proof は append-only 性を示す hard-failure signal である。
- `recorded_consistency_proof` が失敗、未実行、または証拠不足の場合は success にしない。
- 広く利用する場合は、監査済み実装や十分なテストベクタを優先する。現行実装は PoC と教育目的を含む。

---

## 5. 三段階検証モデル

STARK Ballot Simulator は E2E verifiable voting の三段階検証を UI と API の中心概念にする。

| 段階                | 目的                             | 現行実装                                                                                     |
| ------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| Cast-as-Intended    | 意図通りに投票されたか           | 部分実装。local receipt/opening と commitment の整合を検査する。Benaloh Challenge は未実装。 |
| Recorded-as-Cast    | 投票が掲示板に記録されたか       | CT-style inclusion proof と consistency proof で検証する。                                   |
| Counted-as-Recorded | 記録された票が正しく集計されたか | zkVM Journal、bitmap roots、public artifacts、server-side receipt verification で検証する。  |

UI 上はさらに `STARK Verification` を独立 stage として扱い、`Receipt::verify(expectedImageId)` の結果を
明示的に表示する。

### 5.1 Cast-as-Intended

現行実装は、ユーザーの browser-local receipt/opening から commitment を再計算し、投票時の commitment と
一致するかを確認する。これは「クライアントが保存した opening と記録済み commitment が整合する」ことの確認であり、
UI 自体が悪意を持つ場合の完全な Cast-as-Intended 保証ではない。

完全な Cast-as-Intended には、投票を cast するか challenge して開示・破棄するかを選べる
Benaloh Challenge などが必要である。これは将来課題であり、現行 PoC の保証範囲外である。

### 5.2 Recorded-as-Cast

Recorded-as-Cast では、ユーザー票の commitment が bulletin snapshot に含まれることと、その snapshot が
過去の cast-time root から append-only に進んだことを検証する。

要件:

- ユーザー票の exact cast-time artifact が store から再構成できる場合のみ inclusion proof を評価する。
- 証拠が欠ける場合は fail-closed に `not_run` / `missing_evidence` 側へ倒す。
- `recorded_sth_third_party` は通常 optional だが、STH sources が設定されている場合は required / blocking 扱いになる。

### 5.3 Counted-as-Recorded

Counted-as-Recorded では、zkVM が次の性質を proof-bound にする。

- 各 presented vote が index range、choice range、commitment opening、duplicate policy、CT inclusion proof を満たすこと。
- valid vote のみが `verifiedTally` に加算されること。
- presented index と counted index の bitmap root が Journal に含まれること。
- `missingSlots`, `invalidPresentedSlots`, `rejectedRecords`, `excludedSlots` が明示されること。
- `inputCommitment` が canonical public input と一致すること。
- `sthDigest` が close statement / STH に binding されること。

zkVM は不一致や除外があっても可能な限り Journal を返す。これにより、assert 失敗で証拠が失われるのではなく、
ユーザーが「なぜ Verified にならないか」を確認できる。

---

## 6. Verification Checks

`verificationChecks` の ID と base metadata は `src/lib/verification/verification-checks.ts` が単一ソースである。
ドキュメント上の一覧は説明用であり、変更時はコードとテストを優先する。

| Stage    | Checks                                                                                                                                                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cast     | `cast_receipt_present`, `cast_choice_range`, `cast_random_format`, `cast_commitment_match`                                                                                                                                                                                                                              |
| Recorded | `recorded_commitment_in_bulletin`, `recorded_index_in_range`, `recorded_root_at_cast_consistent`, `recorded_inclusion_proof`, `recorded_consistency_proof`, `recorded_sth_third_party`                                                                                                                                  |
| Counted  | `counted_input_sanity`, `counted_unique_indices`, `counted_unique_commitments`, `counted_tally_consistent`, `counted_missing_indices_zero`, `counted_expected_vs_tree_size`, `counted_election_manifest_consistent`, `counted_close_statement_consistent`, `counted_my_vote_included`, `counted_input_commitment_match` |
| STARK    | `stark_image_id_match`, `stark_receipt_verify`                                                                                                                                                                                                                                                                          |

Required / optional の扱い:

- Cast 4 checks は required。
- Recorded では `recorded_index_in_range`, `recorded_inclusion_proof`, `recorded_consistency_proof` が required。
- `recorded_commitment_in_bulletin` と `recorded_root_at_cast_consistent` は derived / optional metadata として扱われる。
- `recorded_sth_third_party` は通常 optional。ただし `NEXT_PUBLIC_STH_SOURCES` が設定されている場合は required 扱いになる。
- Counted 10 checks は required。
- STARK 2 checks は required。

`verificationSteps[].status` は、各 stage の required checks から導出する。手で管理した subset や表示都合の
状態を source of truth にしてはならない。

---

## 7. Verify Flow

現行の verify flow は次の責務分担を持つ。

| ステップ                     | 責務                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /api/verify`            | Journal、bundle 状態、bulletin 情報、verification checks / steps を組み立てる。                    |
| verify page                  | browser-local cast evidence を使って Cast checks を上書きし、UI sequence と verdict を制御する。   |
| `POST /api/verification/run` | server-side verifier-service を起動し、receipt verification report を生成する。                    |
| verifier-service             | `Receipt::verify(expectedImageId)` を実行し、receipt / journal / ImageID の検証結果を返す。        |
| summary logic                | required checks、hard failures、exclusion signals、pending state から overall verdict を導出する。 |

`GET /api/verify` は current finalized authority を復元できる場合、検証失敗を示すデータであっても原則として
payload を返す。unsupported artifact や corrupt artifact は fail-closed payload として扱う。

Session-scoped endpoint では capability token を要求する。検証系 endpoint で capability を緩める場合は、
契約文書、handler、caller、route tests を同時に更新する必要がある。

---

## 8. Bitmap Explainability

`seenBitmapRoot` と `includedBitmapRoot` は、個別 index の状態を説明するための proof-bound root である。

| Root                 | 意味                                        |
| -------------------- | ------------------------------------------- |
| `seenBitmapRoot`     | prover に提示された in-range index を表す。 |
| `includedBitmapRoot` | tally に計上された index を表す。           |

この 2 つを組み合わせることで、個票は次の 3 状態に説明できる。

| `seen` | `included` | 説明                                          |
| ------ | ---------- | --------------------------------------------- |
| 0      | 0          | prover に提示されなかった。                   |
| 1      | 0          | 提示されたが invalid として計上されなかった。 |
| 1      | 1          | 提示され、計上された。                        |

Bitmap contract:

- bitmap 長は `treeSize` bit。`totalExpected` ではない。
- bit order は LSB-first。
- 32 バイト chunk に pack し、不足分は zero padding する。
- chunk leaf は CT-style leaf hash を使う。
- private bitmap artifact は `/api/bitmap-proof` の trusted source であり、public bundle には含めない。

Privacy trade-off:

- 現行 proof は 32 バイト chunk を返すため、同じ chunk 内の近傍 index の counted / excluded 状態が見える。
- 漏れるのは「投票内容」ではなく「計上されたかどうか」の 1 bit 情報である。
- PoC では 64 票中 63 票が Bot であるため、ユーザー票の説明可能性と Bot 改ざん可視化を優先している。
- 一般利用を目指す場合は、1-bit leaf、Sparse Merkle Tree、vector commitment、明示同意ゲートを再検討する。

---

## 9. Bundle Contract

Public bundle は誰でも検証できる証拠を配布するための artifact であり、witness や protected verifier report を
含めてはならない。

### 9.1 生成物

| Artifact                 | 公開可否              | 用途                                          |
| ------------------------ | --------------------- | --------------------------------------------- |
| `public-input.json`      | public                | witness を除いた zkVM input。                 |
| `election-manifest.json` | public                | election config の説明と binding。            |
| `close-statement.json`   | public                | close 時点の log / root / timestamp binding。 |
| `journal.json`           | public                | zkVM の公開出力。                             |
| `receipt.json`           | public                | RISC Zero receipt。                           |
| `metadata.json`          | public in sync bundle | sync finalize の補助 metadata。               |
| `sth.json`               | optional public       | STH artifact。                                |
| `consistency-proof.json` | optional public       | append-only consistency proof。               |
| `input.json`             | private               | witness を含む zkVM input。                   |
| `verification.json`      | private/report        | verifier-service の検証結果。                 |
| `included-bitmap.json`   | private               | counted bitmap proof source。                 |
| `seen-bitmap.json`       | private               | presented bitmap proof source。               |

### 9.2 公開 Bundle

Sync public bundle:

- `public-input.json`
- `election-manifest.json`
- `close-statement.json`
- `receipt.json`
- `journal.json`
- `metadata.json`
- optional `sth.json`
- optional `consistency-proof.json`

Async public bundle:

- `public-input.json`
- `election-manifest.json`
- `close-statement.json`
- `receipt.json`
- `journal.json`

絶対に public `bundle.zip` に含めないもの:

- `input.json`
- `verification.json`
- `included-bitmap.json`
- `seen-bitmap.json`

`verification.json` は protected report artifact であり、capability-checked endpoint または短命な presigned URL の
対象にはなり得るが、public bundle member ではない。

---

## 10. ImageID と MethodVersion

ImageID は、証明が期待した zkVM guest program で生成されたことを確認するための trust anchor である。

現行の対応表は `public/imageId-mapping.json` が source of truth である。current mapping は
`methodVersion = 12` を指す。architecture-specific な ImageID 差分は
`src/lib/verification/image-id-policy.js` の明示 variant policy で選択する。未指定時は `default` variant として
`expectedImageID` を使い、`x86_64` は `EXPECTED_IMAGE_ID_VARIANT=x86_64` または呼び出し側の明示 option で選ぶ。
runtime / CLI の実際の解決経路は `src/lib/verification/expected-image-id.ts`,
`src/lib/verification/image-id-verifier.ts`, `scripts/tests/cli-e2e-voting-flow.ts`,
`verifier-service/scripts/read-image-id.mjs` を参照する。

要件:

- verifier は expected ImageID を明示的に渡して receipt を検証する。
- `stark_image_id_match` と `stark_receipt_verify` は required checks である。
- `RISC0_DEV_MODE=1` receipt は実 proof ではないため、公開環境の成功条件にしてはならない。
- guest / public input / journal format / methodVersion を変更する場合は、zkVM build、ImageID mapping、
  verifier-service、CLI/E2E tests、deployment references を lockstep で更新する。

---

## 11. 改ざんシナリオ

教育用シナリオは、暗号的に可能な攻撃と、表示上の改ざん説明を分けて扱う。

| シナリオ | 意味                             | 実装上の扱い                                                                      |
| -------- | -------------------------------- | --------------------------------------------------------------------------------- |
| `S0`     | 正常                             | 除外・発表結果改ざんなし。                                                        |
| `S1`     | ユーザー票の除外                 | prover input からユーザー票を除外する。                                           |
| `S2`     | ユーザー票に関する発表結果改ざん | zkVM input / Journal / receipt は正しいまま、claimed tally との不一致として扱う。 |
| `S3`     | Bot 票の除外                     | Bot 票を prover input から除外し、bitmap / count に反映する。                     |
| `S4`     | Bot 票に関する発表結果改ざん     | zkVM input / Journal / receipt は正しいまま、claimed tally との不一致として扱う。 |
| `S5`     | 複合改ざん                       | 主に除外シナリオとして扱う。                                                      |

SHA-256 commitment の第二原像困難性により、commitment 後に別の有効な `(choice, random)` へすり替えることは
計算上不可能である。そのため S2 / S4 は proof 自体の改ざんではなく、claimed tally tampering の教育用表現として扱う。

---

## 12. セキュリティモデル

### 12.1 暗号学的仮定

- SHA-256 の衝突耐性と第二原像困難性。
- RISC Zero STARK の soundness。
- expected ImageID と receipt verification の完全性。
- HTTPS / deployment channel の完全性。

### 12.2 システム仮定

- `public/imageId-mapping.json` が期待する guest binary と対応している。
- capability token が session-scoped endpoint へのアクセス境界として機能する。
- public bundle と protected report の配布境界が保たれる。
- private witness artifact は public bundle、公開ログ、チャット、リリースノートに漏れない。

### 12.3 プライバシー境界

実装済み:

- Journal と public bundle は `choice` / `random` を含まない。
- 第三者は `verifiedTally` と proof-bound metadata を検証できるが、個票内容は見えない。

未実装または PoC 制限:

- 現行の proof generation はサーバーが witness を扱うため、サーバーからの投票内容秘匿はない。
- receipt-freeness は完全ではない。投票者が opening を保持するため、第三者に投票内容を示せる余地がある。
- bitmap proof は近傍 index の counted/excluded 状態を漏らす可能性がある。
- 完全な Cast-as-Intended には Benaloh Challenge などが必要である。

### 12.4 重複ポリシー

- 同一 index の二重計上は禁止する。
- 同一 commitment の複数回計上は禁止する。
- commitment 重複は攻撃または運用ミスとして invalid 扱いにする。理論上の偶然衝突は無視できる前提で扱う。

---

## 13. API Surface

主要 API と責務は次の通り。

| Endpoint                                                     | Method | 責務                                          |
| ------------------------------------------------------------ | ------ | --------------------------------------------- |
| `/api/session`                                               | POST   | session 作成と capability token 発行。        |
| `/api/vote`                                                  | POST   | ユーザー投票を記録し、receipt 情報を返す。    |
| `/api/progress`                                              | GET    | Bot 投票進捗。                                |
| `/api/finalize`                                              | POST   | finalize / zkVM proof generation の開始。     |
| `/api/sessions/{sessionId}/status`                           | GET    | async finalize status。                       |
| `/api/finalize/callback`                                     | POST   | async prover callback。                       |
| `/api/finalize/cancel`                                       | POST   | finalize cancel。                             |
| `/api/verify`                                                | GET    | verification data, checks, steps を返す。     |
| `/api/verification/run`                                      | POST   | server-side receipt verification を実行する。 |
| `/api/verification/bundles/{sessionId}/{executionId}`        | GET    | public bundle を返す。                        |
| `/api/verification/bundles/{sessionId}/{executionId}/report` | GET    | protected verification report を返す。        |
| `/api/bulletin`                                              | GET    | session-scoped bulletin inspection。          |
| `/api/bulletin/{voteId}/proof`                               | GET    | session-authorized vote proof。               |
| `/api/bulletin/consistency-proof`                            | GET    | append-only consistency proof。               |
| `/api/bitmap-proof`                                          | GET    | included / seen bitmap proof material。       |
| `/api/zkvm-input-hash`                                       | GET    | zkVM input hash inspection。                  |
| `/api/botdata/{id}`                                          | GET    | Bot vote details for verification/debug。     |
| `/api/sth`                                                   | GET    | STH source for verification/tests。           |

`src/app/api/*/route.ts` は原則 thin wrapper であり、共有 handler と route registry を source of truth にする。

---

## 14. Runtime Modes

| Mode               | 用途                                                    | 注意                                        |
| ------------------ | ------------------------------------------------------- | ------------------------------------------- |
| Mock local         | UI iteration、mock E2E、通常の unit/integration tests。 | proof correctness の証明にはならない。      |
| Real zkVM dev      | TS / Rust contract smoke。                              | `RISC0_DEV_MODE=1` は fake receipt。        |
| Real zkVM prod     | proof contract の最終確認。                             | 高コスト。proof 入力や guest 変更時に使う。 |
| Async AWS finalize | SQS / Step Functions / ECS / S3 pipeline。              | async infra を触る場合のみ使う。            |

proof input、journal format、ImageID、bundle format を変更した場合は mock だけで完了扱いにしない。

---

## 15. テストと検証

変更範囲に応じて最小十分な検証を選ぶ。特に zkVM / proof contract / ImageID に関わる変更は、mock path だけで
完了としない。

推奨確認:

| 変更領域                       | 最小確認                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| TypeScript verification logic  | `pnpm type-check`, `pnpm test:run`                                                                      |
| UI verification flow           | `pnpm type-check`, `pnpm test:run`, 必要に応じて `pnpm test:e2e:mock --grep @smoke --reporter=list`     |
| API contract                   | `pnpm test:run`, route tests, `pnpm test:cli:mock`                                                      |
| zkVM input / journal / ImageID | `pnpm build:zkvm`, `pnpm test:run`, `pnpm test:cli:real-dev`, 必要に応じて `pnpm test:cli:real-prod:s0` |
| verifier-service               | `pnpm build:verifier-service`, Rust fmt/clippy/test, `pnpm test:stark-tamper`                           |
| broad risky changes            | `pnpm ci:verify`                                                                                        |

この文書だけを更新する場合は、Markdown の構造確認と古い contract 名の検索で十分なことが多い。

---

## 16. 将来の拡張

優先度の高い将来課題:

- Benaloh Challenge による Cast-as-Intended の強化。
- サーバーから投票内容を秘匿する準同型暗号、MPC、または client-side proof generation。
- bitmap proof の近傍漏洩を減らす 1-bit leaf / Sparse Merkle / vector commitment。
- 外部 timestamping、third-party STH source、多元的 ImageID mapping 配布。
- RISC Zero recursion や Succinct / Groth16 receipt による proof 配布・検証の軽量化。
- receipt-freeness と coercion resistance の強化。

---

## 付録 A. 用語

| 用語                 | 説明                                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| Journal              | zkVM の公開出力。receipt に含まれ、proof-bound な集計結果と metadata を持つ。 |
| Witness              | zkVM の秘密入力。`choice` と `random` を含む。                                |
| Receipt              | RISC Zero proof artifact。`Receipt::verify(expectedImageId)` の対象。         |
| ImageID              | guest program identity。別 binary による proof 差し替えを防ぐ trust anchor。  |
| Bulletin Board       | append-only Merkle log。vote commitment を記録する。                          |
| Inclusion Proof      | 特定 commitment が bulletin tree に含まれることの証明。                       |
| Consistency Proof    | bulletin tree が append-only に成長したことの証明。                           |
| STH                  | Signed Tree Head 相当の snapshot metadata。                                   |
| `seenBitmapRoot`     | prover に提示された index の bitmap root。                                    |
| `includedBitmapRoot` | tally に計上された index の bitmap root。                                     |
| `excludedSlots`      | slot-based exclusion signal。`> 0` なら success ではない。                    |

## 付録 B. ADR 要約

| ADR     | 決定                           | 理由                                                                       |
| ------- | ------------------------------ | -------------------------------------------------------------------------- |
| ADR-001 | SHA-256 commitment を採用      | zkVM 内外の互換性、監査容易性、既存ツールとの親和性。                      |
| ADR-002 | CT-style Merkle log を採用     | append-only 性と inclusion proof を説明しやすく、RFC 6962 の知見を使える。 |
| ADR-003 | tamper policy を zkVM から分離 | zkVM は事実のみを proof-bound にし、教育用ラベルはアプリ層で扱う。         |
| ADR-004 | mismatch 時も Journal を返す   | assert 失敗で証拠を失わず、fail-closed UI で説明できるようにする。         |
| ADR-005 | slot/record count を分離       | duplicate / out-of-range record と bulletin slot exclusion を混同しない。  |

## 付録 C. 参考文献

- RISC Zero Documentation: zkVM I/O, Receipts, Security Model, Proving Options。
- RFC 6962: Certificate Transparency。
- NIST / EAC: End-to-End Verifiable Voting 関連資料。
- `docs/current/verification/README.md`: 現行 verification bundle / verify flow contract。
- `zkvm/README.md`: guest / host build と proof generation。
- `verifier-service/README.md`: receipt verification service contract。
