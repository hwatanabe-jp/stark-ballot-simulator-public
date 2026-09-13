import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { LayoutProvider } from '@stark-ballot/web/components/LayoutProvider';
import { CspNonceProvider } from '@stark-ballot/web/components/security/CspNonceProvider';
import { LanguageProvider } from '@stark-ballot/web/hooks';
import { LANGUAGE_COOKIE_NAME, resolveInitialLanguage } from '@stark-ballot/web/i18n/language';
import { getCookieValue } from '@stark-ballot/web/shared/cookies';
import { AppNavigationProvider, AppLink } from '@stark-ballot/web/navigation/appNavigation';
import '@stark-ballot/web/styles/globals.css';

const HomePage = lazy(() => import('@stark-ballot/web/routes/HomePage'));
const VotePage = lazy(() => import('@stark-ballot/web/routes/vote/page'));
const AggregatePage = lazy(() => import('@stark-ballot/web/routes/aggregate/page'));
const ResultPage = lazy(() => import('@stark-ballot/web/routes/result/page'));
const VerifyPage = lazy(() => import('@stark-ballot/web/routes/verify/page'));
const PrivacyPage = lazy(() => import('@stark-ballot/web/routes/privacy/page'));
const TermsPage = lazy(() => import('@stark-ballot/web/routes/terms/page'));

function resolveStaticInitialLanguage(): 'ja' | 'en' {
  if (typeof document === 'undefined') {
    return 'ja';
  }
  return resolveInitialLanguage({
    cookie: getCookieValue(document.cookie, LANGUAGE_COOKIE_NAME),
    acceptLanguage: navigator.language,
  });
}

function NotFoundPage(): React.ReactElement {
  return (
    <div className="mx-auto max-w-2xl px-4 py-12 md:px-6">
      <h1 className="mb-4 font-bold font-display text-[var(--text-display)] text-ink-900">Page not found</h1>
      <p className="mb-6 font-secondary text-text-secondary">The requested browser route is not part of this demo.</p>
      <AppLink className="font-medium font-secondary text-ink-600 hover:text-ink-700" href="/">
        Return home
      </AppLink>
    </div>
  );
}

export function App(): React.ReactElement {
  const initialLanguage = resolveStaticInitialLanguage();

  return (
    <BrowserRouter>
      <AppNavigationProvider>
        <CspNonceProvider nonce={null}>
          <LanguageProvider initialLanguage={initialLanguage}>
            <LayoutProvider>
              <Suspense fallback={<div className="px-4 py-8 text-sm text-text-muted">Loading...</div>}>
                <Routes>
                  <Route path="/" element={<HomePage />} />
                  <Route path="/vote" element={<VotePage />} />
                  <Route path="/aggregate" element={<AggregatePage />} />
                  <Route path="/result" element={<ResultPage />} />
                  <Route path="/verify" element={<VerifyPage />} />
                  <Route path="/privacy" element={<PrivacyPage />} />
                  <Route path="/terms" element={<TermsPage />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </Suspense>
            </LayoutProvider>
          </LanguageProvider>
        </CspNonceProvider>
      </AppNavigationProvider>
    </BrowserRouter>
  );
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root element');
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
