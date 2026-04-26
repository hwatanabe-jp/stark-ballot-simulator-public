import { createNextRouteFor } from '@/server/api/routes/registry';

export const GET = createNextRouteFor('GET', '/bulletin/:voteId/proof');
