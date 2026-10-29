import { useEffect, useState } from 'react';
import type { SessionData } from '@stark-ballot/web/session/types';
import { detectTampering } from '@stark-ballot/verification/tamper-detection';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { buildDetectionReceipt, buildDetectionVote, type VerificationPayload } from '../lib/verification-data';

export function useVerificationTamperError(
  data: VerificationPayload | null,
  getExpectedSession: () => SessionData | null,
): string | null {
  const [tamperError, setTamperError] = useState<string | null>(null);
  useEffect(() => {
    const cancelledRef: { current: boolean } = { current: false };

    void (async () => {
      if (!data) {
        setTamperError(null);
        return;
      }

      const receipt = buildDetectionReceipt(data);
      const vote = buildDetectionVote(data, getExpectedSession());
      if (!receipt || !vote) {
        setTamperError(null);
        return;
      }

      try {
        await detectTampering(receipt, vote, {
          ...omitUndefinedProperties({ expectedTotalVotes: data.totalExpected }),
          ...omitUndefinedProperties({ scenarios: data.scenarioId ? [data.scenarioId] : undefined }),
        });
        if (!cancelledRef.current) {
          setTamperError(null);
        }
      } catch (err) {
        if (!cancelledRef.current) {
          const message = err instanceof Error ? err.message : String(err);
          setTamperError(message);
        }
      }
    })();

    return () => {
      cancelledRef.current = true;
    };
  }, [data, getExpectedSession]);

  return tamperError;
}
