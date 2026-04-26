import { describe, it, expect } from 'vitest';
import { t, getTranslations } from './index';

describe('i18n', () => {
  describe('getTranslations', () => {
    it('should return Japanese translations for "ja"', () => {
      const translations = getTranslations('ja');

      expect(translations).toBeDefined();
      expect(translations.common).toBeDefined();
      expect(translations.common.start).toBe('開始');
      expect(translations.common.loading).toBe('読み込み中...');
    });

    it('should return English translations for "en"', () => {
      const translations = getTranslations('en');

      expect(translations).toBeDefined();
      expect(translations.common).toBeDefined();
      expect(translations.common.start).toBe('Start');
      expect(translations.common.loading).toBe('Loading...');
    });
  });

  describe('t function', () => {
    it('should translate nested keys for Japanese', () => {
      expect(t('ja', 'common.start')).toBe('開始');
      expect(t('ja', 'pages.home.welcome')).toBe('STARK Ballot Simulatorへようこそ');
    });

    it('should translate nested keys for English', () => {
      expect(t('en', 'common.start')).toBe('Start');
      expect(t('en', 'pages.home.welcome')).toBe('Welcome to STARK Ballot Simulator');
    });

    it('should return key if translation not found', () => {
      expect(t('ja', 'non.existent.key')).toBe('non.existent.key');
    });

    it('should handle array-style key access', () => {
      expect(t('ja', ['common', 'start'])).toBe('開始');
    });

    it('should support interpolation', () => {
      expect(t('ja', 'pages.result.tally.totalVotes', { total: 5 })).toBe('合計 5 票');
      expect(t('en', 'pages.result.tally.totalVotes', { total: 5 })).toBe('Total 5 votes');
    });

    it('should translate new result page keys', () => {
      expect(t('ja', 'pages.result.title')).toBe('集計結果');
      expect(t('en', 'pages.result.title')).toBe('Aggregation Result');
    });

    it('should translate new aggregate progress estimates', () => {
      expect(t('ja', 'pages.aggregate.progress.estimate.approxMinutes', { minutes: 5 })).toBe('約5分後');
      expect(t('en', 'pages.aggregate.progress.estimate.approxMinutes', { minutes: 5 })).toBe('~5 min');
    });

    it('should translate vote option labels with interpolation', () => {
      expect(t('ja', 'pages.vote.optionLabel', { option: 'A' })).toBe('選択肢 A');
      expect(t('en', 'pages.vote.optionLabel', { option: 'A' })).toBe('Option A');
    });
  });
});
