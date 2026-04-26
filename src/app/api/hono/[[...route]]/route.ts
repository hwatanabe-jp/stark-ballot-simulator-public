import { handle } from 'hono/vercel';
import { createHonoApp } from '@/server/api/routes/hono';

const honoEnabled = process.env.HONO_API_ENABLED === 'true';
const honoMode = process.env.HONO_API_MODE === 'full' ? 'full' : 'readonly';

const disabledHandler = (request: Request): Response => {
  void request;
  return new Response('Not Found', { status: 404 });
};

const handler = honoEnabled ? handle(createHonoApp({ basePath: '/api/hono', mode: honoMode })) : disabledHandler;

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
