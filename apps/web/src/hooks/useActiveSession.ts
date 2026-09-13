import { useEffect, useState } from 'react';
import { getSessionData } from '@stark-ballot/web/session';
import { SESSION_STORAGE_KEY } from '@stark-ballot/web/session/storage';

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
    return Boolean(sessionData?.sessionId);
  } catch {
    // プライベートモードや厳格な設定で localStorage アクセスが失敗した場合
    return fallback;
  }
}

/**
 * セッションの作成・消去と他タブの変更を購読する。
 * admission が storage を更新し得るため、読み取りは effect とイベント内で行う。
 */
export function useHasActiveSession(options: UseHasActiveSessionOptions = {}): boolean {
  const fallback = options.fallback ?? true;
  const [hasActiveSession, setHasActiveSession] = useState<boolean>(fallback);

  useEffect(() => {
    const refresh = () => {
      setHasActiveSession(resolveHasActiveSession(fallback));
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === SESSION_STORAGE_KEY || event.key === null) refresh();
    };
    window.addEventListener('storage', handleStorage);
    window.addEventListener('focus', refresh);
    refresh();
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('focus', refresh);
    };
  }, [fallback]);

  return hasActiveSession;
}
