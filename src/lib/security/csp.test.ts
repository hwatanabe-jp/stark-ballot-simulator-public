import { describe, it, expect, afterEach } from 'vitest';
import { buildContentSecurityPolicy } from './csp';

const getDirective = (csp: string, name: string): string => {
  const directives = csp
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const match = directives.find((directive) => directive.startsWith(`${name} `));
  if (!match) {
    return '';
  }
  return match.slice(name.length + 1);
};

const originalEnv = {
  CSP_CONNECT_SRC_EXTRA: process.env.CSP_CONNECT_SRC_EXTRA,
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
};

afterEach(() => {
  if (originalEnv.CSP_CONNECT_SRC_EXTRA === undefined) {
    delete process.env.CSP_CONNECT_SRC_EXTRA;
  } else {
    process.env.CSP_CONNECT_SRC_EXTRA = originalEnv.CSP_CONNECT_SRC_EXTRA;
  }

  if (originalEnv.NEXT_PUBLIC_API_BASE_URL === undefined) {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
  } else {
    process.env.NEXT_PUBLIC_API_BASE_URL = originalEnv.NEXT_PUBLIC_API_BASE_URL;
  }
});

describe('buildContentSecurityPolicy', () => {
  it('includes nonce and strict-dynamic in strict mode', () => {
    const csp = buildContentSecurityPolicy({ nonce: 'nonce-value', isDev: false, disableStrict: false });
    const scriptSrc = getDirective(csp, 'script-src');

    expect(scriptSrc).toContain("'nonce-nonce-value'");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('allows unsafe-inline in relaxed mode', () => {
    const csp = buildContentSecurityPolicy({ nonce: 'nonce-value', isDev: false, disableStrict: true });
    const scriptSrc = getDirective(csp, 'script-src');

    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'nonce-nonce-value'");
  });

  it('adds unsafe-eval in development', () => {
    const csp = buildContentSecurityPolicy({ nonce: 'nonce-value', isDev: true, disableStrict: false });
    const scriptSrc = getDirective(csp, 'script-src');

    expect(scriptSrc).toContain("'unsafe-eval'");
  });

  it('includes extra connect-src entries from the environment', () => {
    process.env.CSP_CONNECT_SRC_EXTRA = 'https://api.example.com wss://realtime.example.com invalid://nope';
    const csp = buildContentSecurityPolicy({ nonce: 'nonce-value', isDev: false, disableStrict: false });
    const connectSrc = getDirective(csp, 'connect-src');

    expect(connectSrc).toContain('https://api.example.com');
    expect(connectSrc).toContain('wss://realtime.example.com');
    expect(connectSrc).not.toContain('invalid://nope');
  });

  it('includes NEXT_PUBLIC_API_BASE_URL origin in connect-src', () => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.com/v1';
    const csp = buildContentSecurityPolicy({ nonce: 'nonce-value', isDev: false, disableStrict: false });
    const connectSrc = getDirective(csp, 'connect-src');

    expect(connectSrc).toContain('https://api.example.com');
  });

  it('blocks plugin content and embedding through explicit directives', () => {
    const csp = buildContentSecurityPolicy({ nonce: 'nonce-value', isDev: false, disableStrict: false });

    expect(getDirective(csp, 'object-src')).toBe("'none'");
    expect(getDirective(csp, 'frame-ancestors')).toBe("'none'");
  });
});
