import { describe, expect, it } from 'vitest';
import { getCookieValue } from './cookies';

describe('getCookieValue', () => {
  it('returns the cookie value for a single match', () => {
    expect(getCookieValue('foo=bar; stark-ballot-lang=ja; theme=light', 'stark-ballot-lang')).toBe('ja');
  });

  it('prefers the last matching cookie when duplicate names are present', () => {
    expect(getCookieValue('stark-ballot-lang=ja; theme=light; stark-ballot-lang=en', 'stark-ballot-lang')).toBe('en');
  });
});
