const WARNING_MESSAGES = {
  ct_inclusion_failed: '[TamperDetection] CT inclusion verification failed',
} as const;

type VerificationWarningCode = keyof typeof WARNING_MESSAGES;

export const logger = {
  warn: (code: VerificationWarningCode): void => {
    try {
      console.warn(WARNING_MESSAGES[code]);
    } catch {
      // Verification warnings are observational and must not change the verdict path.
    }
  },
};
