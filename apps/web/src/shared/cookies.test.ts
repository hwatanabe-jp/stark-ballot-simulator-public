import { describe, expect, it } from 'vitest';
import { getCookieValue } from './cookies';

describe('getCookieValue', () => {
  it('returns a matching cookie value without decoding it', () => {
    expect(getCookieValue('stark-ballot-lang=%E6%97%A5%E6%9C%AC%E8%AA%9E%2Braw', 'stark-ballot-lang')).toBe(
      '%E6%97%A5%E6%9C%AC%E8%AA%9E%2Braw',
    );
  });

  it('returns malformed percent encoding unchanged', () => {
    expect(getCookieValue('stark-ballot-lang=%E0%A4%A', 'stark-ballot-lang')).toBe('%E0%A4%A');
  });

  it('trims cookie-pair boundary whitespace but preserves whitespace after the equals sign', () => {
    expect(getCookieValue(' theme=light ;  stark-ballot-lang=  ja  ; mode=demo ', 'stark-ballot-lang')).toBe('  ja');
  });

  it('does not treat whitespace around the equals sign before a value as a matching name', () => {
    expect(getCookieValue('stark-ballot-lang =ja', 'stark-ballot-lang')).toBeNull();
  });

  it('prefers the last matching cookie when duplicate names are present', () => {
    expect(getCookieValue('stark-ballot-lang=ja; theme=light; stark-ballot-lang=en', 'stark-ballot-lang')).toBe('en');
  });

  it('ignores malformed pairs and exact-name prefixes', () => {
    expect(
      getCookieValue(
        'stark-ballot-lang; =ja; stark-ballot-language=ja; malformed; stark-ballot-lang=en',
        'stark-ballot-lang',
      ),
    ).toBe('en');
  });

  it.each(['', 'theme=light; mode=demo'])('returns null when the named cookie is missing from %j', (cookieString) => {
    expect(getCookieValue(cookieString, 'stark-ballot-lang')).toBeNull();
  });

  it('returns an empty string for a present cookie with an empty value', () => {
    expect(getCookieValue('theme=light; stark-ballot-lang=', 'stark-ballot-lang')).toBe('');
  });

  it('preserves equals signs embedded in the cookie value', () => {
    expect(getCookieValue('token=header=payload=signature; theme=light', 'token')).toBe('header=payload=signature');
  });
});
