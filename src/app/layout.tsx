import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { Noto_Serif_JP, Noto_Sans_JP, IBM_Plex_Mono, Shippori_Mincho } from 'next/font/google';
import { LayoutProvider } from '@/components/LayoutProvider';
import { CspNonceProvider } from '@/components/security/CspNonceProvider';
import { LanguageProvider } from '@/lib/hooks';
import { LANGUAGE_COOKIE_NAME, resolveInitialLanguage } from '@/lib/i18n/language';
import './globals.css';

/**
 * フォント設定 - 「透明な信頼」デザインシステム
 *
 * Primary/Display: Noto Serif JP - 権威性と可読性（見出し、タイトル）
 * Secondary: Noto Sans JP - 技術的精密さ（本文、ボタン、ラベル）
 * Mono: IBM Plex Mono - 暗号値表示
 */
const notoSerifJP = Noto_Serif_JP({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-noto-serif-jp',
  display: 'swap',
});

const notoSansJP = Noto_Sans_JP({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-noto-sans-jp',
  display: 'swap',
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
});

const shipporiMincho = Shippori_Mincho({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-shippori-mincho',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'STARK Ballot Simulator',
  description: 'End-to-end verifiable voting simulator powered by STARK proofs',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): Promise<React.ReactElement> {
  const headerList = await headers();
  const nonce = headerList.get('x-nonce');
  const cookieStore = await cookies();
  const cookieLanguage = cookieStore.get(LANGUAGE_COOKIE_NAME)?.value;
  const initialLanguage = resolveInitialLanguage({
    cookie: cookieLanguage,
    acceptLanguage: headerList.get('accept-language'),
  });

  return (
    <html lang={initialLanguage}>
      <body
        className={`
          ${notoSerifJP.variable}
          ${notoSansJP.variable}
          ${ibmPlexMono.variable}
          ${shipporiMincho.variable}
          font-secondary
          text-text-primary
          bg-paper-warm
        `}
      >
        <CspNonceProvider nonce={nonce}>
          <LanguageProvider initialLanguage={initialLanguage}>
            <LayoutProvider>{children}</LayoutProvider>
          </LanguageProvider>
        </CspNonceProvider>
      </body>
    </html>
  );
}
