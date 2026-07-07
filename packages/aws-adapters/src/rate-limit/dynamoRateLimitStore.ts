import crypto from 'crypto';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getSharedDynamoDocumentClient } from '@stark-ballot/aws-adapters/aws/dynamodbConfig';
import { getNumberProperty } from '@stark-ballot/domain/utils/guards';

export interface RateLimitStore {
  countEvents(scope: string, sinceTimestamp: number): Promise<number>;
  getOldestEventTimestamp(scope: string, sinceTimestamp: number): Promise<number | null>;
  recordEvent(scope: string, timestamp: number, expiresAt: number): Promise<void>;
  getCounter(key: string): Promise<number | null>;
  incrementCounter(key: string, expiresAt: number): Promise<number>;
}

export class RateLimitStoreError extends Error {
  constructor(
    public readonly operation: string,
    public readonly cause: unknown,
  ) {
    super(`Rate limit store operation failed: ${operation}`);
    this.name = 'RateLimitStoreError';
  }
}

interface DynamoRateLimitStoreConfig {
  eventsTableName: string;
  countersTableName: string;
  documentClient?: DynamoDBDocumentClient;
}

function formatEventTimestampPrefix(timestamp: number): string {
  return Math.max(0, Math.floor(timestamp)).toString().padStart(16, '0');
}

function createEventKey(timestamp: number): string {
  return `${formatEventTimestampPrefix(timestamp)}#${crypto.randomUUID()}`;
}

function createCutoffEventKey(timestamp: number): string {
  return `${formatEventTimestampPrefix(timestamp)}~`;
}

export class DynamoRateLimitStore implements RateLimitStore {
  private readonly eventsTableName: string;
  private readonly countersTableName: string;
  private readonly client: DynamoDBDocumentClient;

  constructor(config: DynamoRateLimitStoreConfig) {
    this.eventsTableName = config.eventsTableName;
    this.countersTableName = config.countersTableName;
    this.client = config.documentClient ?? getSharedDynamoDocumentClient();
  }

  async countEvents(scope: string, sinceTimestamp: number): Promise<number> {
    try {
      let count = 0;
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const result = await this.client.send(
          new QueryCommand({
            TableName: this.eventsTableName,
            KeyConditionExpression: '#scope = :scope AND #eventKey > :cutoff',
            ExpressionAttributeNames: {
              '#scope': 'scope',
              '#eventKey': 'eventKey',
            },
            ExpressionAttributeValues: {
              ':scope': scope,
              ':cutoff': createCutoffEventKey(sinceTimestamp),
            },
            Select: 'COUNT',
            ConsistentRead: true,
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );
        count += result.Count ?? 0;
        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);

      return count;
    } catch (error) {
      throw new RateLimitStoreError('countEvents', error);
    }
  }

  async getOldestEventTimestamp(scope: string, sinceTimestamp: number): Promise<number | null> {
    try {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.eventsTableName,
          KeyConditionExpression: '#scope = :scope AND #eventKey > :cutoff',
          ExpressionAttributeNames: {
            '#scope': 'scope',
            '#eventKey': 'eventKey',
            '#timestamp': 'timestamp',
          },
          ExpressionAttributeValues: {
            ':scope': scope,
            ':cutoff': createCutoffEventKey(sinceTimestamp),
          },
          ScanIndexForward: true,
          Limit: 1,
          ProjectionExpression: '#timestamp',
          ConsistentRead: true,
        }),
      );
      const timestampValue = getNumberProperty(result.Items?.[0], 'timestamp');
      return timestampValue ?? null;
    } catch (error) {
      throw new RateLimitStoreError('getOldestEventTimestamp', error);
    }
  }

  async recordEvent(scope: string, timestamp: number, expiresAt: number): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.eventsTableName,
          Item: {
            scope,
            eventKey: createEventKey(timestamp),
            timestamp,
            expiresAt: Math.floor(expiresAt / 1000),
          },
        }),
      );
    } catch (error) {
      throw new RateLimitStoreError('recordEvent', error);
    }
  }

  async getCounter(key: string): Promise<number | null> {
    try {
      const result = await this.client.send(
        new GetCommand({
          TableName: this.countersTableName,
          Key: { key },
          ConsistentRead: true,
        }),
      );
      const countValue = getNumberProperty(result.Item, 'count');
      return countValue ?? null;
    } catch (error) {
      throw new RateLimitStoreError('getCounter', error);
    }
  }

  async incrementCounter(key: string, expiresAt: number): Promise<number> {
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.countersTableName,
          Key: { key },
          UpdateExpression: 'SET expiresAt = :expiresAt ADD #count :one',
          ExpressionAttributeNames: {
            '#count': 'count',
          },
          ExpressionAttributeValues: {
            ':expiresAt': Math.floor(expiresAt / 1000),
            ':one': 1,
          },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      const updatedCount = getNumberProperty(result.Attributes, 'count');
      return updatedCount ?? 0;
    } catch (error) {
      throw new RateLimitStoreError('incrementCounter', error);
    }
  }
}
