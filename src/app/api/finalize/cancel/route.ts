import { createNextRouteFor } from '@/server/api/routes/registry';
export { _setStepFunctionsClient } from '@/server/api/handlers/finalizeCancel';

export const POST = createNextRouteFor('POST', '/finalize/cancel');
