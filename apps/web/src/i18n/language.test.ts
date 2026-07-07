import { describe, it, expect } from 'vitest';
import { resolveInitialLanguage, parseAcceptLanguage } from './language';

describe('language helpers', () => {
  it('parses accept-language with ja as primary', () => {
    expect(parseAcceptLanguage('ja-JP, en-US;q=0.9')).toBe('ja');
  });

  it('parses accept-language with en as primary', () => {
    expect(parseAcceptLanguage('en-US, ja;q=0.9')).toBe('en');
  });

  it('resolves cookie value first', () => {
    expect(resolveInitialLanguage({ cookie: 'en', storage: 'ja', acceptLanguage: 'ja-JP' })).toBe('en');
  });

  it('resolves storage value when cookie is missing', () => {
    expect(resolveInitialLanguage({ storage: 'ja', acceptLanguage: 'en-US' })).toBe('ja');
  });

  it('resolves accept-language when no saved values exist', () => {
    expect(resolveInitialLanguage({ acceptLanguage: 'en-US' })).toBe('en');
  });

  it('defaults to en when nothing matches', () => {
    expect(resolveInitialLanguage({ acceptLanguage: 'fr-FR' })).toBe('en');
  });
});
