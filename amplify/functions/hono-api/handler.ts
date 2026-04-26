import { handle } from 'hono/aws-lambda';
import { createHonoApp } from '../../../src/server/api/routes/hono.js';

const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

export const handler = handle(app);
