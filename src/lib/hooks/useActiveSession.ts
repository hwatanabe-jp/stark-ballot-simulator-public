import { useCallback, useEffect, useState } from 'react';
import { getSessionData } from '@/lib/session';

interface UseHasActiveSessionOptions {
  /**
   * localStorage 取得に失敗した場合のフォールバック値。
   * 安全側に倒したい場合は true（新規タブで開く）。
   */
  fallback?: boolean;
}

function resolveHasActiveSession(fallback: boolean): boolean {
  try {
    const sessionData = getSessionData();
    return Boolean(
      sessionData?.sessionId &&
      (sessionData.phase === 'voting' || sessionData.phase === 'finalizing' || sessionData.phase === 'verifying'),
    );
  } catch {
    // プライベートモードや厳格な設定で localStorage アクセスが失敗した場合
    return fallback;
  }
}

/**
 * セッションが有効かどうかを一度だけ取得する。
 * localStorage の書き込みをレンダー中に走らせないため、effect 内で更新する。
 */
export function useHasActiveSession(options: UseHasActiveSessionOptions = {}): boolean {
  const fallback = options.fallback ?? true;
  const [hasActiveSession, setHasActiveSession] = useState<boolean>(fallback);

  const evaluateHasActiveSession = useCallback(() => resolveHasActiveSession(fallback), [fallback]);

  useEffect(() => {
    setHasActiveSession(evaluateHasActiveSession());
  }, [evaluateHasActiveSession]);

  return hasActiveSession;
}
