import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoRateLimitStore } from './dynamoRateLimitStore';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

function strictString(value: unknown, label = 'value'): string {
  if (typeof value !== 'string') {
    throw new Error(`Expected ${label} to be a string`);
  }
  return value;
}

type CommandLike = {
  constructor: { name: string };
  input: Record<string, unknown>;
};

class FakeDynamoDocumentClient {
  private readonly events = new Map<string, Record<string, unknown>>();
  readonly queryInputs: Array<Record<string, unknown>> = [];
  private readonly queryPageSize: number | undefined;

  constructor(queryPageSize?: number) {
    this.queryPageSize = queryPageSize;
  }

  send(command: CommandLike): Promise<Record<string, unknown>> {
    switch (command.constructor.name) {
      case 'PutCommand':
        return Promise.resolve(this.put(command.input));
      case 'QueryCommand':
        return Promise.resolve(this.query(command.input));
      default:
        throw new Error(`Unsupported command: ${command.constructor.name}`);
    }
  }

  private put(input: Record<string, unknown>): Record<string, unknown> {
    const item = input['Item'] as Record<string, unknown>;
    const scope = strictString(item['scope'], 'scope');
    const eventKey = strictString(item['eventKey'], 'eventKey');
    this.events.set(`${scope}\u0000${eventKey}`, structuredClone(item));
    return {};
  }

  private query(input: Record<string, unknown>): Record<string, unknown> {
    this.queryInputs.push(structuredClone(input));
    const values = input['ExpressionAttributeValues'] as { ':scope': string; ':cutoff': string };
    const matchingEvents = Array.from(this.events.values())
      .filter(
        (item) => item['scope'] === values[':scope'] && strictString(item['eventKey'], 'eventKey') > values[':cutoff'],
      )
      .sort((left, right) =>
        strictString(left['eventKey'], 'left.eventKey').localeCompare(
          strictString(right['eventKey'], 'right.eventKey'),
        ),
      );
    const exclusiveStartKey = input['ExclusiveStartKey'] as { scope?: unknown; eventKey?: unknown } | undefined;
    const startIndex = exclusiveStartKey
      ? matchingEvents.findIndex(
          (item) => item['scope'] === exclusiveStartKey.scope && item['eventKey'] === exclusiveStartKey.eventKey,
        ) + 1
      : 0;
    const pageSize = this.queryPageSize ?? matchingEvents.length;
    const page = matchingEvents.slice(startIndex, startIndex + pageSize);
    const lastEvaluatedKey =
      startIndex + page.length < matchingEvents.length && page.length > 0
        ? {
            scope: strictDefined(page[page.length - 1])['scope'],
            eventKey: strictDefined(page[page.length - 1])['eventKey'],
          }
        : undefined;

    if (input['Select'] === 'COUNT') {
      return {
        Count: page.length,
        ...(lastEvaluatedKey ? { LastEvaluatedKey: lastEvaluatedKey } : {}),
      };
    }

    return {
      Items: page.slice(0, Number(input['Limit'] ?? page.length)).map((item) => structuredClone(item)),
      ...(lastEvaluatedKey ? { LastEvaluatedKey: lastEvaluatedKey } : {}),
    };
  }
}

function asDocumentClient(client: FakeDynamoDocumentClient): DynamoDBDocumentClient {
  return client as unknown as DynamoDBDocumentClient;
}

describe('DynamoRateLimitStore', () => {
  it('counts same-scope events recorded in the same millisecond separately', async () => {
    const client = new FakeDynamoDocumentClient();
    const store = new DynamoRateLimitStore({
      eventsTableName: 'rate-limit-events',
      countersTableName: 'rate-limit-counters',
      documentClient: asDocumentClient(client),
    });

    await store.recordEvent('vote:203.0.113.10', 1_700_000_000_123, 1_700_000_060_123);
    await store.recordEvent('vote:203.0.113.10', 1_700_000_000_123, 1_700_000_060_123);

    await expect(store.countEvents('vote:203.0.113.10', 1_700_000_000_122)).resolves.toBe(2);
  });

  it('accumulates event counts across paginated query responses', async () => {
    const client = new FakeDynamoDocumentClient(2);
    const store = new DynamoRateLimitStore({
      eventsTableName: 'rate-limit-events',
      countersTableName: 'rate-limit-counters',
      documentClient: asDocumentClient(client),
    });

    for (let offset = 0; offset < 5; offset += 1) {
      await store.recordEvent('vote:203.0.113.10', 1_700_000_000_123 + offset, 1_700_000_060_123);
    }

    await expect(store.countEvents('vote:203.0.113.10', 1_700_000_000_122)).resolves.toBe(5);
    expect(client.queryInputs).toHaveLength(3);
    const exclusiveStartKeys = client.queryInputs.map((input) => input['ExclusiveStartKey'] ?? null);
    expect(exclusiveStartKeys[0]).toBeNull();
    for (const exclusiveStartKey of exclusiveStartKeys.slice(1)) {
      expect(exclusiveStartKey).toMatchObject({ scope: 'vote:203.0.113.10' });
      expect(typeof (exclusiveStartKey as { eventKey?: unknown }).eventKey).toBe('string');
    }
  });

  it('keeps oldest-event lookup time-sortable with unique event keys', async () => {
    const client = new FakeDynamoDocumentClient();
    const store = new DynamoRateLimitStore({
      eventsTableName: 'rate-limit-events',
      countersTableName: 'rate-limit-counters',
      documentClient: asDocumentClient(client),
    });

    await store.recordEvent('zkvm:198.51.100.20', 1_700_000_000_500, 1_700_000_060_500);
    await store.recordEvent('zkvm:198.51.100.20', 1_700_000_000_250, 1_700_000_060_250);
    await store.recordEvent('zkvm:198.51.100.20', 1_700_000_000_250, 1_700_000_060_250);

    await expect(store.getOldestEventTimestamp('zkvm:198.51.100.20', 1_700_000_000_200)).resolves.toBe(
      1_700_000_000_250,
    );
    await expect(store.getOldestEventTimestamp('zkvm:198.51.100.20', 1_700_000_000_250)).resolves.toBe(
      1_700_000_000_500,
    );
  });
});
