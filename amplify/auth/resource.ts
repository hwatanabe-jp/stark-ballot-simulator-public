import { defineAuth } from '@aws-amplify/backend';

/**
 * Amplify Auth Configuration
 *
 * This minimal auth configuration creates:
 * - Cognito User Pool (for future authenticated access)
 * - Cognito Identity Pool (managed by Amplify/CDK)
 *
 * Security note:
 * - Unauthenticated identities are explicitly disabled in `amplify/backend.ts`.
 *
 * @see https://docs.amplify.aws/javascript/build-a-backend/auth/
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
});
