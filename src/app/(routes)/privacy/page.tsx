'use client';

import { useLanguage } from '@/lib/hooks/useLanguage';
import {
  LegalPageLayout,
  LegalSection,
  LegalSubSection,
  LegalList,
  LegalTable,
} from '@/components/legal/LegalPageLayout';

/**
 * PrivacyPolicyPage - プライバシーポリシーページ
 *
 * 日本語/英語コンテンツをハードコード。useLanguage() で言語切替。
 */

const content = {
  ja: {
    title: 'プライバシーポリシー（STARK Ballot Simulator）',
    effectiveDateLabel: '施行日',
    effectiveDate: '2026-01-18',
    intro:
      '本ポリシーは、stark-ballot-sim.hwatanabe.dev で提供する「STARK Ballot Simulator」（以下「本サービス」）における情報の取り扱いを説明します。',
    sections: {
      nature: {
        title: '1. 本サービスの性質',
        content: '本サービスは、暗号技術を用いた検証可能な投票の学習・デモ目的の概念実証（PoC）です。',
      },
      collection: {
        title: '2. 収集する情報',
        userInput: {
          title: '2.1 あなたが入力する情報',
          items: ['投票選択肢（A〜E）'],
          note: '本サービスは、氏名・メールアドレス等の個人情報の入力を求めません。',
        },
        automatic: {
          title: '2.2 自動的に収集される情報',
          items: [
            'IPアドレス: 不正アクセス防止のため、レート制限に一時的に使用',
            'アクセスログ: リクエスト日時、User-Agent、アクセス先URL、エラー情報',
          ],
        },
        browser: {
          title: '2.3 端末に保存される情報（Cookie / Local Storage / Session Storage）',
          items: [
            'セッション情報: セッションの識別情報、投票内容、コミットメント、検証用データ（localStorage）',
            'タブ競合防止のロック情報: セッションを現在のタブに紐づけるための情報（sessionStorage）',
            'ナレッジパネル: 検証プロセスの記録（教育目的の表示用、localStorage）',
            '言語設定: 表示言語の選択（日本語/英語、cookie および localStorage）',
            '実行履歴: zkVM集計の実行回数（レート制限用、localStorage。次回アクセス時に24時間超は削除）',
          ],
        },
      },
      purpose: {
        title: '3. 利用目的',
        items: [
          '本サービスの提供（投票・集計・検証フローの実行）',
          '不正アクセス・スパム対策（レート制限）',
          '障害解析・品質改善',
        ],
      },
      retention: {
        title: '4. データの保存期間',
        server: {
          title: 'サーバー側',
          headers: ['データ', '保持期間'],
          rows: [
            ['セッション・投票データ', '投票中: 30分 / 検証中: 24時間'],
            ['IPアドレス（レート制限）', '最大24時間'],
            ['証明データ（S3）', '30日'],
            ['APIログ', '14日'],
            ['監査ログ（CloudTrail）', '90日'],
          ],
        },
        browser: {
          title: 'ブラウザ側',
          headers: ['データ', '保持期間'],
          rows: [
            ['セッション情報', '投票中: 30分 / 検証中: 24時間'],
            ['ナレッジパネル', '削除するまで保持'],
            ['言語設定', '削除するまで保持'],
            ['実行履歴', '次回アクセス時に24時間超は削除'],
          ],
        },
        note: '実行履歴は次回アクセス時に24時間超のものを削除します（ナレッジパネル・言語設定を除く）。ブラウザに保存されたデータは、ブラウザの設定から削除できます。',
      },
      thirdParty: {
        title: '5. 第三者サービスの利用',
        intro: '本サービスは以下のサービスを利用しています。これらのサービスにデータが送信・保存される場合があります。',
        services: [
          'Cloudflare: 不正アクセス対策（Turnstile）。ウィジェット表示および検証のため、トークン、IPアドレスを含むリクエスト情報がCloudflareに送信される場合があります。',
          'Amazon Web Services (AWS): インフラ基盤。データはAWSのサーバー（東京リージョン）に保存されます。',
        ],
        note: '個人情報を第三者に販売することはありません。',
      },
      amendment: {
        title: '6. 改定',
        content: '本ポリシーは必要に応じて改定します。改定後の内容は本サービス上で公表した時点から適用されます。',
      },
    },
  },
  en: {
    title: 'Privacy Policy (STARK Ballot Simulator)',
    effectiveDateLabel: 'Effective Date',
    effectiveDate: '2026-01-18',
    intro:
      'This policy explains how I handle information in "STARK Ballot Simulator" (the "Service") provided at stark-ballot-sim.hwatanabe.dev.',
    sections: {
      nature: {
        title: '1. Nature of the Service',
        content:
          'This Service is a proof of concept (PoC) for educational and demonstration purposes, showcasing verifiable voting using cryptographic technology.',
      },
      collection: {
        title: '2. Information I Collect',
        userInput: {
          title: '2.1 Information You Provide',
          items: ['Vote choice (A through E)'],
          note: 'This Service does not require you to provide personal information such as your name or email address.',
        },
        automatic: {
          title: '2.2 Automatically Collected Information',
          items: [
            'IP address: Temporarily used for rate limiting to prevent unauthorized access',
            'Access logs: Request timestamps, User-Agent, accessed URLs, error information',
          ],
        },
        browser: {
          title: '2.3 Information Stored on Your Device (Cookies / Local Storage / Session Storage)',
          items: [
            'Session information: Session identifiers, vote content, commitments, and verification data (localStorage)',
            'Tab lock information: Data used to bind the active session to the current tab (sessionStorage)',
            'Knowledge panel: Records of the verification process for educational display (localStorage)',
            'Language preference: Display language selection (Japanese/English, stored in cookies and localStorage)',
            'Execution history: zkVM aggregation count for rate limiting (localStorage; entries older than 24 hours are removed on the next visit)',
          ],
        },
      },
      purpose: {
        title: '3. Purpose of Use',
        items: [
          'Providing the Service (executing voting, aggregation, and verification flows)',
          'Preventing unauthorized access and spam (rate limiting)',
          'Troubleshooting and quality improvement',
        ],
      },
      retention: {
        title: '4. Data Retention Period',
        server: {
          title: 'Server-side',
          headers: ['Data', 'Retention Period'],
          rows: [
            ['Session/voting data', 'During voting: 30 min / During verification: 24 hours'],
            ['IP address (rate limiting)', 'Up to 24 hours'],
            ['Proof data (S3)', '30 days'],
            ['API logs', '14 days'],
            ['Audit logs (CloudTrail)', '90 days'],
          ],
        },
        browser: {
          title: 'Browser-side',
          headers: ['Data', 'Retention Period'],
          rows: [
            ['Session information', 'During voting: 30 min / During verification: 24 hours'],
            ['Knowledge panel', 'Until manually deleted'],
            ['Language preference', 'Until manually deleted'],
            ['Execution history', 'Removed on next visit if older than 24 hours'],
          ],
        },
        note: 'Execution history entries older than 24 hours are removed on the next visit (except for the knowledge panel and language preference). Data stored in your browser can be deleted through your browser settings.',
      },
      thirdParty: {
        title: '5. Third-Party Services',
        intro:
          'This Service uses the following services. Your data may be transmitted to and stored by these services.',
        services: [
          'Cloudflare: For security measures (Turnstile). Tokens and request information, including IP addresses, may be sent to Cloudflare for widget rendering and verification.',
          'Amazon Web Services (AWS): Infrastructure platform. Data is stored on AWS servers (Tokyo region).',
        ],
        note: 'I do not sell personal information to third parties.',
      },
      amendment: {
        title: '6. Amendments',
        content:
          'This policy may be amended as necessary. Amended content will take effect upon publication on this Service.',
      },
    },
  },
} as const;

export default function PrivacyPolicyPage(): React.ReactElement {
  const { language } = useLanguage();
  const c = content[language];
  const s = c.sections;

  return (
    <LegalPageLayout title={c.title} effectiveDate={c.effectiveDate} effectiveDateLabel={c.effectiveDateLabel}>
      <p>{c.intro}</p>

      {/* 1. 本サービスの性質 */}
      <LegalSection title={s.nature.title}>
        <p>{s.nature.content}</p>
      </LegalSection>

      {/* 2. 収集する情報 */}
      <LegalSection title={s.collection.title}>
        <LegalSubSection title={s.collection.userInput.title}>
          <LegalList items={s.collection.userInput.items} />
          <p className="mt-2 text-text-muted">{s.collection.userInput.note}</p>
        </LegalSubSection>

        <LegalSubSection title={s.collection.automatic.title}>
          <LegalList items={s.collection.automatic.items} />
        </LegalSubSection>

        <LegalSubSection title={s.collection.browser.title}>
          <LegalList items={s.collection.browser.items} />
        </LegalSubSection>
      </LegalSection>

      {/* 3. 利用目的 */}
      <LegalSection title={s.purpose.title}>
        <LegalList items={s.purpose.items} />
      </LegalSection>

      {/* 4. データの保存期間 */}
      <LegalSection title={s.retention.title}>
        <LegalSubSection title={s.retention.server.title}>
          <LegalTable headers={s.retention.server.headers} rows={s.retention.server.rows} />
        </LegalSubSection>

        <LegalSubSection title={s.retention.browser.title}>
          <LegalTable headers={s.retention.browser.headers} rows={s.retention.browser.rows} />
        </LegalSubSection>

        <p className="mt-2 text-text-muted">{s.retention.note}</p>
      </LegalSection>

      {/* 5. 第三者サービスの利用 */}
      <LegalSection title={s.thirdParty.title}>
        <p>{s.thirdParty.intro}</p>
        <LegalList items={s.thirdParty.services} />
        <p className="mt-2 text-text-muted">{s.thirdParty.note}</p>
      </LegalSection>

      {/* 6. 改定 */}
      <LegalSection title={s.amendment.title}>
        <p>{s.amendment.content}</p>
      </LegalSection>
    </LegalPageLayout>
  );
}
