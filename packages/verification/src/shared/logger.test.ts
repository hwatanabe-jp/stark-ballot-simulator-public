import { describe, expect, it, vi } from 'vitest';
import { logger } from './logger';

describe('verification warning logger', () => {
  it('emits only the fixed message for an allowed warning code', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    logger.warn('ct_inclusion_failed');

    expect(warnSpy).toHaveBeenCalledWith('[TamperDetection] CT inclusion verification failed');
    warnSpy.mockRestore();
  });

  it('never throws when the console sink fails', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('console unavailable');
    });

    expect(() => logger.warn('ct_inclusion_failed')).not.toThrow();
    warnSpy.mockRestore();
  });
});
