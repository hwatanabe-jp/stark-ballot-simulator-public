import { s } from '@stark-ballot/validation/schema';
import {
  buildRoutePath,
  declaredResponse,
  defineRoute,
  jsonResponse,
  type RouteInput,
  type RouteOutput,
} from './route';

const paramsSchema = s
  .object({
    itemId: s.string(),
  })
  .strict();
const querySchema = s
  .object({
    page: s.string().transform((value) => Number(value)),
  })
  .strict();
const responseSchema = s
  .object({
    itemId: s.string(),
  })
  .strict();

const route = defineRoute({
  routeId: 'items.get',
  method: 'GET',
  path: '/items/:itemId',
  request: {
    params: paramsSchema,
    query: querySchema,
  },
  responses: [jsonResponse(200, responseSchema)],
});

const emptyBodyRoute = defineRoute({
  routeId: 'items.create',
  method: 'POST',
  path: '/items',
  request: {
    body: s.object({}).strict(),
    emptyBody: 'empty-object',
  },
  responses: [jsonResponse(200, responseSchema)],
});
emptyBodyRoute.request.emptyBody satisfies 'empty-object';

const validInput: RouteInput<typeof route> = {
  params: { itemId: 'item-1' },
  query: { page: 1 },
};
void validInput;

const validOutput: RouteOutput<typeof route> = {
  status: 200,
  content: 'json',
  body: { itemId: 'item-1' },
};
void validOutput;

buildRoutePath(route, { itemId: 'item-1' });

// @ts-expect-error The path builder requires every template parameter.
buildRoutePath(route, {});

// @ts-expect-error Status 201 is not declared by this route.
declaredResponse(route, 201, { itemId: 'item-1' });

// @ts-expect-error The declared 200 response schema requires itemId.
declaredResponse(route, 200, {});

// @ts-expect-error A route template parameter requires a matching params schema key.
defineRoute({
  routeId: 'items.missing-param.get',
  method: 'GET',
  path: '/items/:itemId',
  request: {
    params: s.object({}).strict(),
  },
  responses: [jsonResponse(200, responseSchema)],
});

defineRoute({
  routeId: 'items.empty-body-without-schema',
  method: 'POST',
  path: '/items',
  // @ts-expect-error Empty-body admission requires a declared JSON body schema.
  request: {
    emptyBody: 'empty-object',
  },
  responses: [jsonResponse(200, responseSchema)],
});
