export type TestFinalizationState =
  | {
      status: 'pending';
      executionId: string;
      queuedAt: number;
      stepFunctionsArn?: string;
    }
  | {
      status: 'running';
      executionId: string;
      queuedAt: number;
      startedAt: number;
      stepFunctionsArn?: string;
    }
  | {
      status: 'succeeded';
      executionId: string;
      queuedAt: number;
      startedAt: number;
      completedAt: number;
      stepFunctionsArn?: string;
      bundleMetadata?: {
        s3BundleKey?: string | undefined;
        s3UploadedAt?: string | undefined;
      };
    }
  | {
      status: 'failed';
      executionId: string;
      queuedAt: number;
      startedAt?: number;
      failedAt: number;
      error: {
        code: string;
        message: string;
        details?: unknown;
      };
      stepFunctionsArn?: string;
    }
  | {
      status: 'timeout';
      executionId: string;
      queuedAt: number;
      startedAt?: number;
      timeoutAt: number;
      stepFunctionsArn?: string;
    };
