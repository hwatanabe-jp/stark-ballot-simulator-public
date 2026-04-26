# References

`final_design.md` の設計判断に使う文献を管理するための一覧です。

対象ファイル:

- `docs/current/guides/6-zkvm_design/final_design.md`

## 0. 分類方針

- `主根拠 (P0)`:
  - 設計判断に直接効く論文（プロトコル・検証モデルの根拠）
- `背景資料 (P1)`:
  - 設計議論の補助になる論文
- `標準/仕様 (Non-paper)`:
  - 論文ではないが実装仕様として重要な資料

## 1. 主根拠 (P0)

### 1.1 End-to-end verifiability

- **Title**: End-to-end verifiability
- **Authors**: Peter Y. A. Ryan, Josh Benaloh, Ronald Rivest, Philip Stark, Vanessa Teague, Poorvi Vora
- **Year**: 2015 (arXiv:1504.03778)
- **Link**: https://arxiv.org/abs/1504.03778
- **Why in scope**:
  - E2E 検証可能投票の中核概念（Cast/Recorded/Tallied）を説明する基礎文献。
  - `final_design.md` の三段階検証の説明に対応。

### 1.2 Benaloh Challenge (Cast-as-Intended の中核)

- **Title**: Ballot Casting Assurance via Voter-Initiated Poll Station Auditing
- **Author**: Josh Benaloh
- **Venue**: EVT 2007 (USENIX/ACCURATE)
- **Link**: https://www.usenix.org/conference/evt-07/ballot-casting-assurance-voter-initiated-poll-station-auditing
- **Why in scope**:
  - Cast-as-Intended を実現する Benaloh challenge/cast-and-audit の代表文献。
  - `final_design.md` の「Benaloh Challenge 未実装」記述の根拠。

### 1.3 STARK を集計検証へ適用する設計根拠

- **Title**: On the Applicability of STARKs to Counted-as-Collected Verification in Existing Homomorphic E-Voting Systems
- **Authors**: Max Harrison, Thomas Haines
- **Venue**: FC 2024 Workshops (published 2025)
- **DOI**: 10.1007/978-3-031-69231-4_4
- **Why in scope**:
  - STARK を Counted-as-Collected/Recorded の検証に適用する際の設計論。
  - `Partially Private BB` の前提・継承元に位置する。

### 1.4 Partially Private Bulletin Board 拡張

- **Title**: End-To-End Verifiable Internet Voting with Partially Private Bulletin Boards
- **Authors**: Valeh Farzaliyev, Jan Willemson
- **Venue**: E-Vote-ID 2024 (published 2026)
- **DOI**: 10.1007/978-3-032-05036-6_5
- **File**: `2026-PartiallyPrivateBB-E2EVerifiable.pdf`
- **Link**: https://link.springer.com/chapter/10.1007/978-3-032-05036-6_5
- **Why in scope**:
  - STARK ベース E2E 投票の実装拡張（特に Cast-as-Intended と bulletin board 構成）を扱う。
  - `final_design.md` 付録「学術論文」で直接参照。

## 2. 背景資料 (P1)

### 2.1 VRLog

- **Title**: Cryptographic Verifiability for Voter Registration Systems
- **Authors**: Andrés Fábrega, Jack Cable, Michael A. Specter, Sunoo Park
- **Year**: 2025 (arXiv:2503.03974)
- **File**: `2025-VRLog-VerifiableVoterRegistration.pdf`
- **Link**: https://arxiv.org/abs/2503.03974
- **Note**:
  - 追記専用ログ設計の背景として有益。
  - ただし、`final_design.md` の主設計判断の一次根拠ではないため P1 扱い。

### 2.2 SoK: SNARK 実装脆弱性

- **Title**: SoK: What Don't We Know? Understanding Security Vulnerabilities in SNARKs
- **Authors**: Stefanos Chaliasos et al.
- **Venue**: USENIX Security 2024
- **Link**: https://www.usenix.org/conference/usenixsecurity24/presentation/chaliasos
- **Note**:
  - SNARK 実装リスクの整理として有益。
  - STARK Ballot のプロトコル設計そのものの一次根拠ではないため P1 扱い。

## 3. 標準/仕様 (Non-paper)

以下は論文ではなく標準・仕様文書。

- RFC 6962 (Certificate Transparency): https://datatracker.ietf.org/doc/html/rfc6962
- EAC E2E guidance: https://www.eac.gov/voting-equipment/end-end-e2e-protocol-evaluation-process
- RISC Zero docs (I/O): https://dev.risczero.com/api/zkvm/tutorials/io
- RISC Zero docs (Receipts): https://dev.risczero.com/api/zkvm/receipts
- RISC Zero docs (Security model): https://dev.risczero.com/api/security-model

## 4. 用語メモ

- **Cast-as-Intended** は一般的な E2E 投票の用語。
- 典型的には `Cast as Intended / Recorded as Cast / Tallied (or Counted) as Recorded` の3分割で用いられる。
