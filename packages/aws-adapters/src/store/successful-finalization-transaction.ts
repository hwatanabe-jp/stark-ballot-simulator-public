import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { finalizationRecordCodec } from '@stark-ballot/application/finalize/finalization-record';
import { finalizationBitmapDataCodec } from '@stark-ballot/application/finalize/finalization-storage';
import type { SuccessfulFinalizationRecord } from '@stark-ballot/application/finalize/successful-finalization-commit-admission';
import type {
  SuccessfulFinalizationCommitInput,
  SuccessfulFinalizationCommitResult,
} from '@stark-ballot/application/finalize/finalization-store';
import type { VerificationResultRecord } from '@stark-ballot/application/finalize/finalization-result-store';
import type { AwsFinalizationRuntimeMetadata } from '../finalize/finalizationRuntimeStore';
import type { AwsVerificationDeliveryMetadataInput } from '../finalize/finalizationDeliveryMetadataStore';
import {
  type CurrentFinalizationItem,
  type PersistedFinalizationItem,
  type ReceiptItem,
  type ReceiptCounterItem,
  type VerificationItem,
  type BitmapItem,
  type RuntimeMetadataItem,
  type DeliveryMetadataItem,
  currentFinalizationKey,
  finalizationKey,
  receiptKey,
  verificationKey,
  bitmapKey,
  runtimeMetadataKey,
  deliveryMetadataKey,
  decodeLifecycleRevision,
} from './dynamo-records';
import { matchItemRevision } from './dynamo-write-conditions';

type TransactionItems = NonNullable<TransactWriteCommandInput['TransactItems']>;

interface SuccessfulCommitMetadata {
  existingRuntime: RuntimeMetadataItem | undefined;
  runtimeMetadata: AwsFinalizationRuntimeMetadata | undefined;
  existingDelivery: DeliveryMetadataItem | undefined;
  deliveryMetadata: AwsVerificationDeliveryMetadataInput | undefined;
}

export interface SuccessfulFinalizationWrite {
  requested: SuccessfulFinalizationRecord;
  committed: SuccessfulFinalizationRecord;
  revision: NonNullable<ReturnType<typeof decodeLifecycleRevision>>;
  receipt: SuccessfulFinalizationCommitInput['receipt'];
  receiptPublication: SuccessfulFinalizationCommitResult['receiptPublication'];
  counter: ReceiptCounterItem | undefined;
  verification: VerificationResultRecord | undefined;
  bitmap: SuccessfulFinalizationCommitResult['bitmap'];
  metadata: SuccessfulCommitMetadata;
}

interface TransactionStorage {
  tableName: string;
  expiresAt: number;
  ttlItems: TransactionItems;
}

function receiptPublicationWrites(input: SuccessfulFinalizationWrite, storage: TransactionStorage): TransactionItems {
  const { requested, receipt, receiptPublication, counter } = input;
  const { expiresAt } = storage;
  const key = receiptKey(requested.sessionId, requested.finalizationId);
  return receipt && receiptPublication
    ? [
        {
          Put: {
            TableName: storage.tableName,
            Item: {
              sessionId: key,
              itemType: 'FINALIZATION_RECEIPT',
              ownerSessionId: requested.sessionId,
              finalizationId: requested.finalizationId,
              receiptHash: receiptPublication.receiptHash,
              boardIndex: receiptPublication.boardIndex,
              receipt: { ...receipt },
              expiresAt,
            } satisfies ReceiptItem,
            ConditionExpression: 'attribute_not_exists(#sessionId)',
            ExpressionAttributeNames: { '#sessionId': 'sessionId' },
          },
        },
        {
          Put: {
            TableName: storage.tableName,
            Item: {
              sessionId: 'RECEIPT_BOARD_COUNTER',
              itemType: 'RECEIPT_COUNTER',
              nextBoardIndex: receiptPublication.boardIndex + 1,
            } satisfies ReceiptCounterItem,
            ConditionExpression: counter
              ? '#nextBoardIndex = :expectedNextBoardIndex'
              : 'attribute_not_exists(#sessionId)',
            ExpressionAttributeNames: counter ? { '#nextBoardIndex': 'nextBoardIndex' } : { '#sessionId': 'sessionId' },
            ...(counter ? { ExpressionAttributeValues: { ':expectedNextBoardIndex': counter.nextBoardIndex } } : {}),
          },
        },
      ]
    : [];
}

function verificationWrites(input: SuccessfulFinalizationWrite, storage: TransactionStorage): TransactionItems {
  const { requested, verification } = input;
  const { expiresAt } = storage;
  return verification
    ? [
        {
          Put: {
            TableName: storage.tableName,
            Item: {
              sessionId: verificationKey(requested.sessionId, requested.finalizationId),
              itemType: 'VERIFICATION_RESULT',
              ownerSessionId: requested.sessionId,
              finalizationId: requested.finalizationId,
              record: verification,
              revision: 1,
              expiresAt,
            } satisfies VerificationItem,
            ConditionExpression: 'attribute_not_exists(#sessionId)',
            ExpressionAttributeNames: { '#sessionId': 'sessionId' },
          },
        },
      ]
    : [
        {
          ConditionCheck: {
            TableName: storage.tableName,
            Key: { sessionId: verificationKey(requested.sessionId, requested.finalizationId) },
            ConditionExpression: 'attribute_not_exists(#sessionId)',
            ExpressionAttributeNames: { '#sessionId': 'sessionId' },
          },
        },
      ];
}

function bitmapWrites(input: SuccessfulFinalizationWrite, storage: TransactionStorage): TransactionItems {
  const { requested, bitmap } = input;
  const { expiresAt } = storage;
  return bitmap.availability === 'available'
    ? [
        {
          Put: {
            TableName: storage.tableName,
            Item: {
              sessionId: bitmapKey(requested.sessionId, requested.finalizationId),
              itemType: 'FINALIZATION_BITMAP',
              ownerSessionId: requested.sessionId,
              finalizationId: requested.finalizationId,
              bitmap: {
                sessionId: requested.sessionId,
                finalizationId: requested.finalizationId,
                ...finalizationBitmapDataCodec.encode(bitmap.data),
              },
              expiresAt,
            } satisfies BitmapItem,
            ConditionExpression: 'attribute_not_exists(#sessionId)',
            ExpressionAttributeNames: { '#sessionId': 'sessionId' },
          },
        },
      ]
    : [
        {
          ConditionCheck: {
            TableName: storage.tableName,
            Key: { sessionId: bitmapKey(requested.sessionId, requested.finalizationId) },
            ConditionExpression: 'attribute_not_exists(#sessionId)',
            ExpressionAttributeNames: { '#sessionId': 'sessionId' },
          },
        },
      ];
}

function metadataWrites(input: SuccessfulFinalizationWrite, storage: TransactionStorage): TransactionItems {
  const { requested, metadata } = input;
  const { existingRuntime, runtimeMetadata, existingDelivery, deliveryMetadata } = metadata;
  const { expiresAt } = storage;
  return [
    ...(runtimeMetadata
      ? [
          {
            Put: {
              TableName: storage.tableName,
              Item: {
                sessionId: runtimeMetadataKey(requested.sessionId, requested.finalizationId),
                itemType: 'FINALIZATION_RUNTIME',
                ownerSessionId: requested.sessionId,
                finalizationId: requested.finalizationId,
                metadata: runtimeMetadata,
                revision: (existingRuntime?.revision ?? 0) + 1,
                expiresAt,
              } satisfies RuntimeMetadataItem,
              ...matchItemRevision(existingRuntime),
            },
          },
        ]
      : []),
    ...(deliveryMetadata
      ? [
          {
            Put: {
              TableName: storage.tableName,
              Item: {
                sessionId: deliveryMetadataKey(requested.sessionId, requested.finalizationId),
                itemType: 'VERIFICATION_DELIVERY',
                ownerSessionId: requested.sessionId,
                finalizationId: requested.finalizationId,
                metadata: deliveryMetadata,
                revision: (existingDelivery?.revision ?? 0) + 1,
                expiresAt,
              } satisfies DeliveryMetadataItem,
              ...matchItemRevision(existingDelivery),
            },
          },
        ]
      : []),
  ];
}

/** Pure assembly: the caller acquires current TTL authority and writes all items atomically. */
export function buildSuccessfulFinalizationTransaction(
  input: SuccessfulFinalizationWrite,
  storage: TransactionStorage,
): TransactionItems {
  const { requested, committed, revision } = input;
  const nextRevision = revision.revision + 1;
  const { expiresAt } = storage;
  const pointerCondition =
    revision.currentFinalizationId === null
      ? {
          ConditionExpression: 'attribute_not_exists(#sessionId)',
          ExpressionAttributeNames: { '#sessionId': 'sessionId' },
        }
      : {
          ConditionExpression: '#revision = :expectedRevision AND #currentFinalizationId = :finalizationId',
          ExpressionAttributeNames: {
            '#revision': 'revision',
            '#currentFinalizationId': 'currentFinalizationId',
          },
          ExpressionAttributeValues: {
            ':expectedRevision': revision.revision,
            ':finalizationId': requested.finalizationId,
          },
        };
  const items: TransactionItems = [
    {
      Put: {
        TableName: storage.tableName,
        Item: {
          sessionId: currentFinalizationKey(requested.sessionId),
          itemType: 'FINALIZATION_CURRENT',
          ownerSessionId: requested.sessionId,
          currentFinalizationId: requested.finalizationId,
          revision: nextRevision,
          expiresAt,
        } satisfies CurrentFinalizationItem,
        ...pointerCondition,
      },
    },
    {
      Put: {
        TableName: storage.tableName,
        Item: {
          sessionId: finalizationKey(requested.sessionId, requested.finalizationId),
          itemType: 'FINALIZATION',
          ownerSessionId: requested.sessionId,
          finalizationId: requested.finalizationId,
          record: finalizationRecordCodec.encode(committed),
          revision: nextRevision,
          expiresAt,
        } satisfies PersistedFinalizationItem,
        ...matchItemRevision(revision.currentFinalizationId === null ? undefined : revision),
      },
    },
    ...receiptPublicationWrites(input, storage),
    ...verificationWrites(input, storage),
    ...bitmapWrites(input, storage),
    ...metadataWrites(input, storage),
    ...storage.ttlItems,
  ];
  return items;
}
