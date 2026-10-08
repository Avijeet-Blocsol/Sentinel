import { ZodError } from 'zod';

export type ExecutionFailureCode =
  | 'INVALID_EVENT'
  | 'RULE_NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'AUTHORIZATION_ERROR'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PARTIAL_EVALUATION'
  | 'CANCELLED'
  | 'UNKNOWN_ERROR';

export class SentinelExecutionError extends Error {
  constructor(
    public readonly code: ExecutionFailureCode,
    message: string,
    public readonly retryable: boolean,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'SentinelExecutionError';
  }
}

export interface ExecutionFailureClassification {
  code: ExecutionFailureCode;
  retryable: boolean;
  message: string;
}

type ErrorWithMetadata = {
  name?: unknown;
  code?: unknown;
  retryable?: unknown;
  statusCode?: unknown;
  message?: unknown;
};

function isProviderError(error: ErrorWithMetadata): boolean {
  return error.name === 'ProviderError' || error.name === 'TelegramClientError';
}

/**
 * Converts failures into an explicit retry policy. Unknown failures remain
 * retryable, but no retry decision depends on matching human-readable text.
 */
export function classifyExecutionFailure(error: unknown): ExecutionFailureClassification {
  if (error instanceof SentinelExecutionError) {
    return { code: error.code, retryable: error.retryable, message: error.message };
  }

  if (error instanceof ZodError) {
    return { code: 'VALIDATION_ERROR', retryable: false, message: error.message };
  }

  const metadata = (error && typeof error === 'object' ? error : {}) as ErrorWithMetadata;
  const message = typeof metadata.message === 'string' ? metadata.message : String(error);

  if (metadata.retryable === false) {
    return { code: 'VALIDATION_ERROR', retryable: false, message };
  }

  if (isProviderError(metadata)) {
    const statusCode = typeof metadata.statusCode === 'number' ? metadata.statusCode : undefined;
    if (statusCode === undefined) {
      return { code: 'PROVIDER_UNAVAILABLE', retryable: true, message };
    }
    if (statusCode === 401) {
      return { code: 'AUTHENTICATION_ERROR', retryable: false, message };
    }
    if (statusCode === 403) {
      return { code: 'AUTHORIZATION_ERROR', retryable: false, message };
    }
    if (statusCode === 429) {
      return { code: 'RATE_LIMITED', retryable: true, message };
    }
    if (statusCode === 408 || statusCode >= 500) {
      return { code: 'PROVIDER_UNAVAILABLE', retryable: true, message };
    }
    if (statusCode >= 400) {
      return { code: 'VALIDATION_ERROR', retryable: false, message };
    }
    return { code: 'PROVIDER_UNAVAILABLE', retryable: true, message };
  }

  if (metadata.name === 'AbortError') {
    return { code: 'CANCELLED', retryable: false, message };
  }

  if (metadata.code === 'TICK_PARTIAL_FAILURE') {
    return { code: 'PARTIAL_EVALUATION', retryable: true, message };
  }

  return { code: 'UNKNOWN_ERROR', retryable: true, message };
}
