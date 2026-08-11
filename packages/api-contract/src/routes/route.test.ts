import { describe, expect, it } from 'vitest';
import { s } from '@stark-ballot/validation/schema';
import {
  bindRoute,
  buildRoutePath,
  buildRouteUrl,
  createQuerySerializer,
  declaredResponse,
  defineRoute,
  jsonResponse,
  matchRoutePath,
  textResponse,
} from './route';

const itemParamsSchema = s
  .object({
    itemId: s.string().min(1),
  })
  .strict();

const itemQuerySchema = s
  .object({
    page: s
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .transform((value) => Number(value))
      .optional(),
    expanded: s
      .literal('1')
      .transform(() => true)
      .optional(),
  })
  .strict();

const itemResponseSchema = s
  .object({
    itemId: s.string().min(1),
  })
  .strict();

const itemRoute = defineRoute({
  routeId: 'items.get',
  method: 'GET',
  path: '/items/:itemId',
  request: {
    params: itemParamsSchema,
    query: itemQuerySchema,
  },
  serializeQuery: createQuerySerializer(itemQuerySchema, (query) => ({
    ...(query.page === undefined ? {} : { page: String(query.page) }),
    ...(query.expanded === undefined ? {} : { expanded: '1' }),
  })),
  responses: [jsonResponse(200, itemResponseSchema), textResponse(404, 'item-not-found')],
});

describe('typed route primitives', () => {
  it('interpolates and URI-encodes every declared path parameter', () => {
    expect(buildRoutePath(itemRoute, { itemId: 'item/with spaces' })).toBe('/items/item%2Fwith%20spaces');
  });

  it('serializes typed query values through the route-owned wire mapping', () => {
    expect(
      buildRouteUrl(itemRoute, {
        params: { itemId: 'item-1' },
        query: { page: 2, expanded: true },
      }),
    ).toBe('/items/item-1?page=2&expanded=1');
  });

  it('matches, decodes, and admits path parameters with their declared schema', () => {
    expect(matchRoutePath(itemRoute, '/items/item%2Fwith%20spaces')).toEqual({
      itemId: 'item/with spaces',
    });
    expect(matchRoutePath(itemRoute, '/items')).toBeNull();
    expect(matchRoutePath(itemRoute, '/other/item-1')).toBeNull();
    expect(matchRoutePath(itemRoute, '/items/%E0%A4%A')).toBeNull();
  });

  it('admits only declared statuses and response bodies at runtime', () => {
    expect(declaredResponse(itemRoute, 200, { itemId: 'item-1' })).toEqual({
      status: 200,
      content: 'json',
      body: { itemId: 'item-1' },
    });
    expect(declaredResponse(itemRoute, 404, 'missing')).toEqual({
      status: 404,
      content: 'text',
      body: 'missing',
    });
    expect(() => declaredResponse(itemRoute, 201 as 200, { itemId: 'item-1' })).toThrow(
      'Route items.get does not declare response status 201',
    );
    expect(() => declaredResponse(itemRoute, 200, { itemId: '' })).toThrow();
  });

  it('binds a handler to the canonical route object without copying method or path', () => {
    const handler = () => declaredResponse(itemRoute, 200, { itemId: 'item-1' });
    const binding = bindRoute(itemRoute, handler);

    expect(binding).toEqual({ route: itemRoute, handler });
  });
});
