import path from 'path';
import { promises as fs } from 'fs';
import type { ApiContext } from '@/server/api/context';
import { jsonResponse } from '@/server/http/response';
import { getStringProperty } from '@/lib/utils/guards';
import { generateBundlePresignedUrlForKey } from '@/lib/aws/presigned-url';
import { isS3UploadEnabled } from '@/lib/aws/s3-upload';
import { validateSessionCapabilityForSession } from '@/server/api/middleware/session';
import {
  buildFailClosedDownloadResponse,
  resolveSupportedFinalizedRead,
} from '@/server/api/utils/currentArtifactAdmission';

function getBundleBaseDir(): string {
  return process.env.VERIFIER_WORK_DIR ?? path.join(/* turbopackIgnore: true */ process.cwd(), '.verifier-bundles');
}

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(value);
}

async function ensureExecutionScope(
  store: ApiContext['store'],
  sessionId: string,
  executionId: string,
): Promise<
  | {
      ok: true;
      finalizationResult: NonNullable<ReturnType<typeof resolveSupportedFinalizedRead>['finalizationResult']>;
    }
  | { ok: false; response: Response }
> {
  const session = await store.getSession(sessionId);
  if (!session || !session.finalized) {
    return { ok: false, response: jsonResponse({ error: 'Bundle not found' }, { status: 404 }) };
  }

  const finalizedRead = resolveSupportedFinalizedRead(session);
  if (finalizedRead.artifactState) {
    return {
      ok: false,
      response: buildFailClosedDownloadResponse(finalizedRead.artifactState),
    };
  }

  const finalizationResult = finalizedRead.finalizationResult;
  if (!finalizationResult) {
    return {
      ok: false,
      response: buildFailClosedDownloadResponse('corrupt_or_unreadable'),
    };
  }

  const allowedExecutionId = finalizationResult.verificationExecutionId;
  if (!allowedExecutionId || !isSafeSegment(allowedExecutionId) || allowedExecutionId !== executionId) {
    return { ok: false, response: jsonResponse({ error: 'Bundle not found' }, { status: 404 }) };
  }

  return { ok: true, finalizationResult };
}

async function maybeRedirectToS3(artifactKey: string | undefined): Promise<Response | null> {
  if (!artifactKey || !isS3UploadEnabled()) {
    return null;
  }

  const presignResult = await generateBundlePresignedUrlForKey(artifactKey);
  if (!presignResult.success || !presignResult.url) {
    return jsonResponse({ error: 'Failed to generate download URL' }, { status: 500 });
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: presignResult.url,
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Serve a verification bundle archive from local storage.
 */
export async function getVerificationBundleHandler({
  request,
  store,
  params,
}: ApiContext<{ sessionId: string; executionId: string }>): Promise<Response> {
  const sessionId = params?.sessionId;
  const executionId = params?.executionId;

  if (!sessionId || !executionId || !isSafeSegment(sessionId) || !isSafeSegment(executionId)) {
    return jsonResponse({ error: 'Invalid bundle reference' }, { status: 400 });
  }

  const capabilityResult = validateSessionCapabilityForSession(request.headers, sessionId);
  if (capabilityResult instanceof Response) {
    return capabilityResult;
  }

  const executionScope = await ensureExecutionScope(store, sessionId, executionId);
  if (!executionScope.ok) {
    return executionScope.response;
  }

  const s3Redirect = await maybeRedirectToS3(executionScope.finalizationResult.s3BundleKey);
  if (s3Redirect) {
    return s3Redirect;
  }

  const archivePath = path.join(getBundleBaseDir(), sessionId, executionId, 'bundle.zip');

  try {
    const file = await fs.readFile(archivePath);
    return new Response(Uint8Array.from(file), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${executionId}.zip"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (getStringProperty(error, 'code') === 'ENOENT') {
      return jsonResponse({ error: 'Bundle not found' }, { status: 404 });
    }

    return jsonResponse({ error: 'Failed to load bundle' }, { status: 500 });
  }
}

/**
 * Serve a verification report from local storage.
 */
export async function getVerificationReportHandler({
  request,
  store,
  params,
}: ApiContext<{ sessionId: string; executionId: string }>): Promise<Response> {
  const sessionId = params?.sessionId;
  const executionId = params?.executionId;

  if (!sessionId || !executionId || !isSafeSegment(sessionId) || !isSafeSegment(executionId)) {
    return jsonResponse({ error: 'Invalid bundle reference' }, { status: 400 });
  }

  const capabilityResult = validateSessionCapabilityForSession(request.headers, sessionId);
  if (capabilityResult instanceof Response) {
    return capabilityResult;
  }

  const executionScope = await ensureExecutionScope(store, sessionId, executionId);
  if (!executionScope.ok) {
    return executionScope.response;
  }

  const s3Redirect = await maybeRedirectToS3(executionScope.finalizationResult.verificationResult?.s3ReportKey);
  if (s3Redirect) {
    return s3Redirect;
  }

  const reportPath = path.join(getBundleBaseDir(), sessionId, executionId, 'verification.json');

  try {
    const file = await fs.readFile(reportPath, 'utf-8');
    return new Response(file, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `inline; filename="${executionId}-verification.json"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (getStringProperty(error, 'code') === 'ENOENT') {
      return jsonResponse({ error: 'Report not found' }, { status: 404 });
    }

    return jsonResponse({ error: 'Failed to load report' }, { status: 500 });
  }
}
