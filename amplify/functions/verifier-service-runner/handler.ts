import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { downloadFromS3 } from '../../../src/lib/aws/s3-download.js';
import { hexStringSchema } from '../../../src/lib/finalize/types.js';
import { extractZipFromBuffer } from '../../../src/lib/utils/zip.js';
import { uploadVerificationBundleToS3 } from '../../../src/lib/verification/verification-bundle.js';
import { invokeVerifierService } from '../../../src/lib/verification/verifier-service-client.js';
import type { VerifierServiceRunnerResponse } from '../../../src/lib/verification/verifier-service-runner-types.js';

const runnerOptionsSchema = z
  .object({
    uploadToS3: z.boolean().optional(),
    workDir: z.string().min(1).optional(),
  })
  .strict()
  .optional();

const s3BundleSchema = z
  .object({
    mode: z.literal('s3_bundle'),
    sessionId: z.string().uuid(),
    executionId: z.string().min(1),
    bundleKey: z.string().min(1),
    expectedImageId: hexStringSchema(32, 'expectedImageId'),
    options: runnerOptionsSchema,
  })
  .strict();

const eventSchema = s3BundleSchema;

type HandlerEvent = z.infer<typeof eventSchema>;

export const handler = async (rawEvent: unknown): Promise<VerifierServiceRunnerResponse> => {
  let input: HandlerEvent;

  try {
    input = eventSchema.parse(rawEvent);
  } catch (error) {
    return {
      status: 'error',
      message: 'Invalid verifier invocation payload',
      details: error instanceof Error ? error.message : error,
    };
  }

  const workDir = input.options?.workDir ?? path.join('/tmp', 'verifier-work');
  process.env.VERIFIER_WORK_DIR = workDir;

  try {
    const bundlePath = path.join(workDir, input.sessionId, input.executionId);
    await fs.mkdir(bundlePath, { recursive: true });

    const zipBuffer = await downloadFromS3(input.bundleKey);
    await extractZipFromBuffer(zipBuffer, { destination: bundlePath });

    const reportPath = path.join(bundlePath, 'verification.json');
    const invocation = await invokeVerifierService({
      bundlePath,
      expectedImageId: input.expectedImageId,
      reportPath,
    });

    let s3Result: Awaited<ReturnType<typeof uploadVerificationBundleToS3>> | undefined;
    if (input.options?.uploadToS3 ?? true) {
      s3Result = await uploadVerificationBundleToS3(bundlePath, input.sessionId, input.executionId);
    }

    return {
      status: 'success',
      sessionId: input.sessionId,
      executionId: input.executionId,
      verifierStatus: invocation.status,
      verificationReport: invocation.report,
      s3: s3Result
        ? {
            bundleUrl: s3Result.s3BundleUrl,
            bundleKey: s3Result.s3BundleKey,
            reportKey: s3Result.s3ReportKey,
            uploadedAt: s3Result.s3UploadedAt,
            expiresAt: s3Result.s3BundleExpiresAt,
          }
        : undefined,
    };
  } catch (error) {
    return {
      status: 'error',
      message: 'verifier-service execution failed',
      details: error instanceof Error ? error.message : error,
    };
  } finally {
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
};

export type { HandlerEvent };
