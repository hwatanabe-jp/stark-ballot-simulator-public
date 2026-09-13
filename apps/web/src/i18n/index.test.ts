import { describe, expect, it } from 'vitest';
import { t } from './index';

describe('i18n', () => {
  describe('t function', () => {
    it('should translate nested keys for Japanese', () => {
      expect(t('ja', 'common.start')).toBe('開始');
      expect(t('ja', 'pages.home.description')).toBe('STARK証明による検証可能投票の教育デモ');
    });

    it('should translate nested keys for English', () => {
      expect(t('en', 'common.start')).toBe('Start');
      expect(t('en', 'pages.home.description')).toBe('Educational demo of verifiable voting with STARK proofs');
    });

    it('keeps the unknown-key fallback for callers outside the TypeScript contract', () => {
      // @ts-expect-error Simulate an untyped caller; typed callers must use a dictionary leaf.
      expect(t('ja', 'non.existent.key')).toBe('non.existent.key');
    });

    it('keeps the non-string-node fallback for callers outside the TypeScript contract', () => {
      // @ts-expect-error Object nodes are intentionally rejected by TranslationKey.
      expect(t('ja', 'common')).toBe('common');
    });

    it('should support interpolation', () => {
      expect(t('ja', 'pages.result.tally.totalVotes', { total: 5 })).toBe('合計 5 票');
      expect(t('en', 'pages.result.tally.totalVotes', { total: 5 })).toBe('Total 5 votes');
    });
  });
});
