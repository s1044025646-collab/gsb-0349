export const ALGORITHM_VERSION = 'primal-simplex-bland-v1.0.0';

export const LIMITS = {
  maxVariables: 200,
  maxConstraints: 200,
  maxNameLength: 64,
  coefficientAbsMax: 1e9,
  rhsAbsMax: 1e9,
  defaultMaxIterations: 10000,
  maxIterationsCap: 100000,
} as const;

export const DEFAULT_TOLERANCE = {
  zero: 1e-9,
  pivotMin: 1e-12,
  valueAbs: 1e-7,
} as const;

export type ToleranceKey = keyof typeof DEFAULT_TOLERANCE;

export const ERROR_CODES = {
  INVALID_JSON: 'INVALID_JSON',
  VALIDATION_DIMENSION: 'VALIDATION_DIMENSION',
  VALIDATION_DUPLICATE_NAME: 'VALIDATION_DUPLICATE_NAME',
  VALIDATION_NON_FINITE: 'VALIDATION_NON_FINITE',
  VALIDATION_NEGATIVE_RHS: 'VALIDATION_NEGATIVE_RHS',
  VALIDATION_LIMIT: 'VALIDATION_LIMIT',
  VALIDATION_EMPTY: 'VALIDATION_EMPTY',
  INVALID_BUDGET: 'INVALID_BUDGET',
  INVALID_TOLERANCE: 'INVALID_TOLERANCE',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  RUN_NOT_FOUND: 'RUN_NOT_FOUND',
  ITERATION_NOT_FOUND: 'ITERATION_NOT_FOUND',
  CANDIDATE_DIMENSION: 'CANDIDATE_DIMENSION',
  CANDIDATE_NON_FINITE: 'CANDIDATE_NON_FINITE',
  RUNS_INCOMPATIBLE: 'RUNS_INCOMPATIBLE',
  PAGE_OUT_OF_RANGE: 'PAGE_OUT_OF_RANGE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}
