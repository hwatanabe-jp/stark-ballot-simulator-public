import { z } from 'zod';
import type { FinalizationScenarioContext } from '@/types/server';
import type { ElectionConfig } from '@/lib/zkvm/election-config';
import type { ZkVMInput, VoteWithProof } from '../zkvm/types';
import { addHexPrefix, isValidHexString, normalizeHexString } from '../utils/hex';

export const PROVER_WORK_MESSAGE_VERSION = 'v1.1' as const;

export function hexStringSchema(bytes: number, label: string): z.ZodType<string> {
  return z
    .string({ required_error: `${label} is required` })
    .min(1, `${label} must not be empty`)
    .transform((value) => addHexPrefix(normalizeHexString(value)))
    .superRefine((value, ctx) => {
      if (!isValidHexString(value, bytes)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be a ${bytes * 2}-character hex string`,
        });
      }
    });
}

const voteWithProofSchema: z.ZodType<VoteWithProof> = z
  .object({
    commitment: hexStringSchema(32, 'commitment'),
    choice: z.number().int().min(0, 'choice must be between 0 and 4').max(4, 'choice must be between 0 and 4'),
    random: hexStringSchema(32, 'random'),
    index: z.number().int().min(0, 'index must be a non-negative integer'),
    merklePath: z.array(hexStringSchema(32, 'merklePath item')).min(1, 'merklePath must contain at least one value'),
  })
  .strict();

export const zkvmInputSchema: z.ZodType<ZkVMInput> = z
  .object({
    electionId: z.string().uuid('electionId must be a UUID'),
    bulletinRoot: hexStringSchema(32, 'bulletinRoot'),
    treeSize: z.number().int().positive('treeSize must be a positive integer'),
    logId: hexStringSchema(32, 'logId'),
    timestamp: z.number().int().nonnegative('timestamp must be non-negative'),
    totalExpected: z.number().int().positive('totalExpected must be a positive integer'),
    electionConfigHash: hexStringSchema(32, 'electionConfigHash'),
    votes: z.array(voteWithProofSchema).min(1, 'votes must contain at least one entry'),
  })
  .strict();

export const electionConfigSchema: z.ZodType<ElectionConfig> = z
  .object({
    totalExpected: z.number().int().positive('totalExpected must be a positive integer'),
    choices: z.array(z.string().min(1, 'choice labels must not be empty')).min(1, 'choices must not be empty'),
    version: z.string().min(1, 'version is required'),
    botCount: z.number().int().nonnegative('botCount must be a non-negative integer'),
    merkleTreeDepth: z.number().int().positive('merkleTreeDepth must be a positive integer'),
  })
  .strict();

const scenarioCodeSchema = z
  .string()
  .regex(/^S[0-5]$/, 'scenario codes must be S0-S5')
  .transform((value) => value as `S${0 | 1 | 2 | 3 | 4 | 5}`);

const requestMetaSchema = z
  .object({
    clientIp: z.string().min(3, 'clientIp is required'),
    timestamp: z.number().int().nonnegative('request timestamp must be non-negative'),
    electionId: z.string().uuid('request electionId must be a UUID'),
    userAgent: z.string().optional(),
    traceId: z.string().optional(),
  })
  .strict();

const voteChoiceSchema = z.enum(['A', 'B', 'C', 'D', 'E']);

const claimedCountsSchema = z
  .object({
    A: z.number().int().nonnegative(),
    B: z.number().int().nonnegative(),
    C: z.number().int().nonnegative(),
    D: z.number().int().nonnegative(),
    E: z.number().int().nonnegative(),
  })
  .strict();

const scenarioContextSchema: z.ZodType<FinalizationScenarioContext> = z
  .object({
    scenarios: z.array(scenarioCodeSchema),
    tamperMode: z.enum(['none', 'input', 'claim']),
    claimedCounts: claimedCountsSchema,
    claimedTotalVotes: z.number().int().nonnegative(),
    summary: z
      .object({
        ignoredCount: z.number().int().nonnegative(),
        recountedCount: z.number().int().nonnegative(),
        userRecountChoice: voteChoiceSchema.nullable(),
        affectedBotIds: z.array(z.number().int().nonnegative()).optional(),
      })
      .strict(),
  })
  .strict();

export const ProverWorkMessageSchema = z
  .object({
    messageVersion: z.literal(PROVER_WORK_MESSAGE_VERSION),
    sessionId: z.string().uuid('sessionId must be a UUID'),
    contractGeneration: z.string().min(1, 'contractGeneration is required'),
    executionId: z.string().min(10, 'executionId must be at least 10 characters'),
    queuedAt: z.number().int().nonnegative('queuedAt must be a timestamp in milliseconds'),
    zkvmInput: zkvmInputSchema,
    expectedImageId: hexStringSchema(32, 'expectedImageId'),
    zkvmInputCommitment: hexStringSchema(32, 'zkvmInputCommitment').optional(),
    electionConfig: electionConfigSchema,
    inputS3Key: z.string().min(1, 'inputS3Key must not be empty').optional(),
    scenarios: z.array(scenarioCodeSchema).default([]),
    simulateTampering: z.boolean().default(false),
    scenarioContext: scenarioContextSchema.optional(),
    requestMeta: requestMetaSchema,
  })
  .strict();

export type ProverWorkMessage = z.infer<typeof ProverWorkMessageSchema>;

export function parseProverWorkMessage(input: unknown): ProverWorkMessage {
  return ProverWorkMessageSchema.parse(input);
}
