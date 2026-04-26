'use client';

import { useLanguage } from '@/lib/hooks/useLanguage';
import { LegalPageLayout, LegalSection, LegalList } from '@/components/legal/LegalPageLayout';

/**
 * TermsOfServicePage - 利用規約ページ
 *
 * 日本語/英語コンテンツをハードコード。useLanguage() で言語切替。
 */

const content = {
  ja: {
    title: '利用規約（STARK Ballot Simulator）',
    effectiveDateLabel: '施行日',
    effectiveDate: '2026-01-18',
    intro:
      '本規約は、stark-ballot-sim.hwatanabe.dev で提供する「STARK Ballot Simulator」（以下「本サービス」）の利用条件を定めます。本サービスを利用した時点で、本規約に同意したものとみなします。',
    sections: {
      nature: {
        title: '1. 本サービスの性質',
        intro: '本サービスは、暗号技術を用いた検証可能な投票の学習・デモ目的の概念実証（PoC）です。',
        items: [
          '予告なくサービスを変更・停止・終了することがあります',
          '投票の秘匿性、継続的な稼働、結果の正確性または特定目的適合性を保証しません',
        ],
      },
      prohibited: {
        title: '2. 禁止事項',
        items: [
          '法令または公序良俗に反する行為',
          '不正アクセス、脆弱性探索、サービス妨害',
          '他の利用者または第三者に損害を与える行為',
        ],
      },
      disclaimer: {
        title: '3. 免責',
        content:
          '本サービスは「現状のまま」提供されます。本サービスの利用により生じた損害について、運営者は責任を負いません（強行法規により制限される場合を除く）。',
      },
      amendment: {
        title: '4. 規約の改定',
        content: '運営者は本規約を随時改定できます。改定後の規約は、本サービス上で公表した時点から効力を生じます。',
      },
    },
  },
  en: {
    title: 'Terms of Service (STARK Ballot Simulator)',
    effectiveDateLabel: 'Effective Date',
    effectiveDate: '2026-01-18',
    intro:
      'These terms govern the use of "STARK Ballot Simulator" (the "Service") provided at stark-ballot-sim.hwatanabe.dev. By using this Service, you agree to these terms.',
    sections: {
      nature: {
        title: '1. Nature of the Service',
        intro:
          'This Service is a proof of concept (PoC) for educational and demonstration purposes, showcasing verifiable voting using cryptographic technology.',
        items: [
          'The Service may be changed, suspended, or terminated without notice',
          'I do not guarantee vote confidentiality, continuous operation, accuracy of results, or fitness for a particular purpose',
        ],
      },
      prohibited: {
        title: '2. Prohibited Activities',
        items: [
          'Actions that violate laws or public morals',
          'Unauthorized access, vulnerability scanning, or service disruption',
          'Actions that cause harm to other users or third parties',
        ],
      },
      disclaimer: {
        title: '3. Disclaimer',
        content:
          'This Service is provided "as is." I am not liable for any damages arising from the use of this Service (except where limited by mandatory laws).',
      },
      amendment: {
        title: '4. Amendment of Terms',
        content:
          'I may amend these terms at any time. Amended terms will take effect upon publication on this Service.',
      },
    },
  },
} as const;

export default function TermsOfServicePage(): React.ReactElement {
  const { language } = useLanguage();
  const c = content[language];
  const s = c.sections;

  return (
    <LegalPageLayout title={c.title} effectiveDate={c.effectiveDate} effectiveDateLabel={c.effectiveDateLabel}>
      <p>{c.intro}</p>

      {/* 1. 本サービスの性質 */}
      <LegalSection title={s.nature.title}>
        <p>{s.nature.intro}</p>
        <LegalList items={s.nature.items} />
      </LegalSection>

      {/* 2. 禁止事項 */}
      <LegalSection title={s.prohibited.title}>
        <LegalList items={s.prohibited.items} />
      </LegalSection>

      {/* 3. 免責 */}
      <LegalSection title={s.disclaimer.title}>
        <p>{s.disclaimer.content}</p>
      </LegalSection>

      {/* 4. 規約の改定 */}
      <LegalSection title={s.amendment.title}>
        <p>{s.amendment.content}</p>
      </LegalSection>
    </LegalPageLayout>
  );
}
