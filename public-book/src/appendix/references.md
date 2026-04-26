# 参考文献

本システムの設計領域に関連する主要な文献を掲載しています。

---

**[1]** J. Benaloh, R. Rivest, P. Y. A. Ryan, P. Stark, V. Teague, P. Vora.
"End-to-end verifiability," arXiv:1504.03778, 2015.
<https://arxiv.org/abs/1504.03778>

E2E 検証可能投票の基本モデル（Cast-as-Intended / Recorded-as-Cast / Counted-as-Recorded）を定義した文献。本システムの 4 段階検証モデルはこのフレームワークと同じ構造を採用している。

**[2]** M. Harrison, T. Haines.
"On the Applicability of STARKs to Counted-as-Collected Verification in Existing Homomorphic E-Voting Systems,"
in _Financial Cryptography and Data Security: FC 2024 International Workshops_, LNCS, Springer, 2024.
<https://doi.org/10.1007/978-3-031-69231-4_4>

STARK 証明を投票集計の検証に適用する設計根拠を示した論文。本システムの Counted-as-Recorded 段階における zkVM 証明設計と関連が深い。

**[3]** V. Farzaliyev, J. Willemson.
"End-To-End Verifiable Internet Voting with Partially Private Bulletin Boards,"
in _Electronic Voting: E-Vote-ID 2025_, LNCS, vol. 16028, Springer, 2025.
<https://doi.org/10.1007/978-3-032-05036-6_5>

[2] の研究を拡張し、STARK ベースの E2E 検証可能投票において Cast-as-Intended 検証と掲示板のプライバシー設計を統合した論文。本システムの掲示板構成と検証パイプライン設計に関連するテーマを扱っている。

**[4]** B. Laurie, A. Langley, E. Kasper.
"Certificate Transparency," RFC 6962, IETF, 2013.
<https://datatracker.ietf.org/doc/html/rfc6962>

追記専用 Merkle ツリーの包含証明・整合性証明を定義した標準仕様。本システムの掲示板は、この仕様のハッシュ規則（`0x00` リーフ / `0x01` ノード）と証明アルゴリズムに基づく CT スタイル実装を採用している。
