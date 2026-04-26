type BuildCspOptions = {
  nonce: string;
  isDev: boolean;
  disableStrict: boolean;
};

const CONNECT_SRC_BASE = [
  "'self'",
  'https://*.amazonaws.com',
  'https://*.cloudflare.com',
  'https://cloudflareinsights.com',
  'https://static.cloudflareinsights.com',
];

const EXTRA_SOURCE_SPLIT_REGEX = /[,\s]+/;
const CONNECT_SRC_ALLOWED = /^(https?|wss?):\/\/\S+$/i;

const parseExtraSources = (raw: string | undefined): string[] => {
  if (!raw) {
    return [];
  }

  return raw
    .split(EXTRA_SOURCE_SPLIT_REGEX)
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && CONNECT_SRC_ALLOWED.test(value));
};

const resolveConnectSrc = (): string[] => {
  const sources = new Set(CONNECT_SRC_BASE);

  for (const extra of parseExtraSources(process.env.CSP_CONNECT_SRC_EXTRA)) {
    sources.add(extra);
  }

  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (apiBaseUrl) {
    try {
      const origin = new URL(apiBaseUrl).origin;
      sources.add(origin);
    } catch {
      // Ignore invalid URLs to keep CSP generation resilient.
    }
  }

  return Array.from(sources);
};

export const buildContentSecurityPolicy = ({ nonce, isDev, disableStrict }: BuildCspOptions): string => {
  const scriptSrc = ["'self'"];

  if (disableStrict) {
    scriptSrc.push("'unsafe-inline'");
  } else {
    scriptSrc.push(`'nonce-${nonce}'`, "'strict-dynamic'");
  }

  if (isDev) {
    scriptSrc.push("'unsafe-eval'");
  }

  scriptSrc.push(
    'https://challenges.cloudflare.com',
    'https://*.challenges.cloudflare.com',
    'https://static.cloudflareinsights.com',
  );

  const styleSrc = ["'self'", "'unsafe-inline'"];
  if (!disableStrict) {
    styleSrc.push(`'nonce-${nonce}'`);
  }

  const connectSrc = resolveConnectSrc();

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    `style-src ${styleSrc.join(' ')}`,
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(' ')}`,
    "frame-src 'self' https://challenges.cloudflare.com",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
};
