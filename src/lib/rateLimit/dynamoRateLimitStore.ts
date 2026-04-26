import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getNumberProperty } from '@/lib/utils/guards';

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

let sharedDocumentClient: DynamoDBDocumentClient | null = null;

function resolveAwsRegion(): string {
  return process.env.AWS_REGION ?? process.env.AMPLIFY_DATA_REGION ?? 'ap-northeast-1';
}

function resolveDynamoEndpoint(): string | undefined {
  const endpoint = process.env.DYNAMODB_ENDPOINT?.trim();
  return endpoint && endpoint.length > 0 ? endpoint : undefined;
}

function getDocumentClient(): DynamoDBDocumentClient {
  if (sharedDocumentClient) {
    return sharedDocumentClient;
  }

  const endpoint = resolveDynamoEndpoint();
  const client = new DynamoDBClient({
    region: resolveAwsRegion(),
    endpoint,
    credentials: endpoint
      ? {
          accessKeyId: 'local',
          secretAccessKey: 'local',
        }
      : undefined,
  });

  sharedDocumentClient = DynamoDBDocumentClient.from(client, {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  });

  return sharedDocumentClient;
}

export class DynamoRateLimitStore implements RateLimitStore {
  private readonly eventsTableName: string;
  private readonly countersTableName: string;
  private readonly client: DynamoDBDocumentClient;

  constructor(config: DynamoRateLimitStoreConfig) {
    this.eventsTableName = config.eventsTableName;
    this.countersTableName = config.countersTableName;
    this.client = config.documentClient ?? getDocumentClient();
  }

  async countEvents(scope: string, sinceTimestamp: number): Promise<number> {
    try {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.eventsTableName,
          KeyConditionExpression: '#scope = :scope AND #timestamp > :cutoff',
          ExpressionAttributeNames: {
            '#scope': 'scope',
            '#timestamp': 'timestamp',
          },
          ExpressionAttributeValues: {
            ':scope': scope,
            ':cutoff': sinceTimestamp,
          },
          Select: 'COUNT',
          ConsistentRead: true,
        }),
      );
      return result.Count ?? 0;
    } catch (error) {
      throw new RateLimitStoreError('countEvents', error);
    }
  }

  async getOldestEventTimestamp(scope: string, sinceTimestamp: number): Promise<number | null> {
    try {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.eventsTableName,
          KeyConditionExpression: '#scope = :scope AND #timestamp > :cutoff',
          ExpressionAttributeNames: {
            '#scope': 'scope',
            '#timestamp': 'timestamp',
          },
          ExpressionAttributeValues: {
            ':scope': scope,
            ':cutoff': sinceTimestamp,
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
