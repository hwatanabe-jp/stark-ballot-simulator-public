import { admitSessionIdentity } from '@stark-ballot/web/session/identity';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getVerification, recordVerificationObservation } from '@stark-ballot/web/api/verification';
import { downloadBundle, fetchVerificationReport } from '@stark-ballot/web/api/artifacts';
import { VerificationClientApiError } from '@stark-ballot/web/verification/client-api-errors';
import { initializeSession, saveSessionData, getSessionData, SESSION_STORAGE_KEY } from '@stark-ballot/web/session';
import { getKnowledgeValue } from '@stark-ballot/web/knowledge';
import { buildFinalizationResource, buildVerificationResourceResponse } from '@stark-ballot/web/mock-api/fixtures';
import { resetMockState } from '@stark-ballot/web/mock-api/state';
import {
  VerificationResourceResponseSchema,
  type VerificationResource,
} from '@stark-ballot/api-contract/schemas/verification';
import { FinalizationResourceSchema } from '@stark-ballot/api-contract/schemas/finalizations';
import { projectFinalizationResourceToClientSnapshot } from '@stark-ballot/web/finalize/client-finalization-result';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';
import VerifyPage from './page';

const mocks = vi.hoisted(() => ({ t: (key: string) => key, push: vi.fn() }));
vi.mock('@stark-ballot/web/hooks', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('@stark-ballot/web/hooks/useTranslation', () => ({ useTranslation: () => ({ t: mocks.t, language: 'en' }) }));
vi.mock('@stark-ballot/web/navigation/appNavigation', () => ({ useAppRouter: () => ({ push: mocks.push }) }));
vi.mock('@stark-ballot/web/api/verification', () => ({
  getVerification: vi.fn(),
  runVerification: vi.fn(),
  recordVerificationObservation: vi.fn(),
}));
vi.mock('@stark-ballot/web/api/artifacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stark-ballot/web/api/artifacts')>()),
  downloadBundle: vi.fn(),
  fetchVerificationReport: vi.fn(),
}));

function prepareVerificationSession(): VerificationResource {
  const state = resetMockState();
  const now = Date.now();
  state.finalizationId = 'page-finalization';
  state.finalizationQueuedAtMs = now - 30;
  state.finalizationStartedAtMs = now - 20;
  state.finalizationCompletedAtMs = now - 10;
  state.voteChoice = 'A';
  state.verificationStatus = 'dev_mode';
  state.random = `0x${'1'.repeat(64)}`;
  state.commitment = computeCommitment(state.electionId, 0, state.random);
  const resource = VerificationResourceResponseSchema.parse(buildVerificationResourceResponse(state, now)).data;
  if (!resource || resource.availability !== 'available') throw new Error('Expected available mock verification');
  const finalization = FinalizationResourceSchema.parse(buildFinalizationResource(state, now));
  if (finalization.status !== 'succeeded') throw new Error('Expected completed mock finalization');
  const finalizeResult = projectFinalizationResourceToClientSnapshot(finalization);
  if (!finalizeResult) throw new Error('Expected admitted finalization snapshot');
  initializeSession({
    ...admitSessionIdentity({ sessionId: state.sessionId, capabilityToken: state.capabilityToken }),
    electionId: state.electionId,
    electionConfigHash: state.electionConfigHash,
    logId: state.logId,
  });
  saveSessionData({
    phase: 'verifying',
    finalizeResult,
    verificationRequestedAt: now,
    myVote: 'A',
    myRand: state.random,
    myCommit: state.commitment,
  });
  return resource;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getVerification).mockResolvedValue(prepareVerificationSession());
  vi.mocked(recordVerificationObservation).mockResolvedValue({ status: 'recorded' });
  vi.mocked(downloadBundle).mockResolvedValue(undefined);
});

describe('verification page evidence and session boundaries', () => {
  it('keeps evidence hidden until admission and labels mock proof completion as demo evidence', async () => {
    const resource = prepareVerificationSession();
    const pending = Promise.withResolvers<VerificationResource>();
    vi.mocked(getVerification).mockReturnValue(pending.promise);
    render(<VerifyPage />);
    expect(screen.queryByTestId('result-summary')).not.toBeInTheDocument();
    expect(getKnowledgeValue('user.voteReceipt')).toBeUndefined();
    await act(async () => pending.resolve(resource));
    expect(await screen.findByTestId('result-summary')).not.toHaveAttribute('data-status', 'verified');
    expect(screen.getByTestId('overall-status')).toHaveTextContent('pages.verify.resultSummary.demoOnlyMain');
    await waitFor(() => expect(recordVerificationObservation).toHaveBeenCalledOnce());
  });

  it('hides the rendered result after a fatal artifact authorization failure', async () => {
    vi.mocked(downloadBundle).mockRejectedValue(
      new VerificationClientApiError('Capability lost', {
        responseStatus: 403,
        invalidation: 'clear_session_authority',
      }),
    );
    render(<VerifyPage />);
    await screen.findByTestId('result-summary');
    fireEvent.click(screen.getByRole('button', { name: 'pages.verify.download.cta' }));
    await waitFor(() => expect(screen.queryByTestId('result-summary')).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('Capability lost');
    expect(fetchVerificationReport).not.toHaveBeenCalled();
    expect(getKnowledgeValue('proofBundleStatus')).not.toBe('downloaded');
  });

  it('does not record a completed download when the protected report fails after the bundle', async () => {
    vi.mocked(fetchVerificationReport).mockRejectedValue(new Error('Report unavailable'));
    render(<VerifyPage />);
    await screen.findByTestId('result-summary');
    fireEvent.click(screen.getByRole('button', { name: 'pages.verify.download.cta' }));
    expect(await screen.findByText('Report unavailable')).toBeInTheDocument();
    expect(downloadBundle).toHaveBeenCalledOnce();
    expect(fetchVerificationReport).toHaveBeenCalledOnce();
    expect(getKnowledgeValue('proofBundleStatus')).not.toBe('downloaded');
  });

  it('hides a previous session result without removing the replacement session', async () => {
    render(<VerifyPage />);
    await screen.findByTestId('result-summary');
    const replacement = resetMockState();
    await act(async () => {
      initializeSession({
        ...admitSessionIdentity({ sessionId: replacement.sessionId, capabilityToken: replacement.capabilityToken }),
        electionId: replacement.electionId,
        electionConfigHash: replacement.electionConfigHash,
        logId: replacement.logId,
      });
      window.dispatchEvent(new StorageEvent('storage', { key: SESSION_STORAGE_KEY }));
    });
    expect(screen.queryByTestId('result-summary')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('pages.verify.sessionReplaced');
    expect(getSessionData()?.sessionId).toBe(replacement.sessionId);
  });
});
