import { createNextRouteFor } from '@/server/api/routes/registry';

export const GET = createNextRouteFor('GET', '/verification/bundles/:sessionId/:executionId');
