export type TestFinalizationState =
  | {
      status: 'pending';
      finalizationId: string;
      queuedAtMs: number;
      stepFunctionsArn?: string;
    }
  | {
      status: 'running';
      finalizationId: string;
      queuedAtMs: number;
      startedAtMs: number;
      stepFunctionsArn?: string;
    }
  | {
      status: 'succeeded';
      finalizationId: string;
      queuedAtMs: number;
      startedAtMs: number;
      completedAtMs: number;
      stepFunctionsArn?: string;
      bundleMetadata?: {
        s3BundleKey?: string | undefined;
        s3UploadedAtMs?: number | undefined;
      };
    }
  | {
      status: 'failed';
      finalizationId: string;
      queuedAtMs: number;
      startedAtMs?: number;
      failedAtMs: number;
      error: {
        code: string;
        message: string;
        details?: unknown;
      };
      stepFunctionsArn?: string;
    }
  | {
      status: 'timeout';
      finalizationId: string;
      queuedAtMs: number;
      startedAtMs?: number;
      timeoutAtMs: number;
      stepFunctionsArn?: string;
    };
