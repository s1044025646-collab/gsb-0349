import type { ALGORITHM_VERSION } from './constants.js';

export interface ModelInput {
  name?: string;
  variables: string[];
  constraints: string[];
  A: number[][];
  b: number[];
  c: number[];
}

export interface LPModel {
  id: string;
  name: string;
  variables: string[];
  constraints: string[];
  A: number[][];
  b: number[];
  c: number[];
  createdAt: string;
}

export interface SolveOptions {
  rule: SelectionRule;
  maxIterations: number;
  tolerance: Tolerances;
  algorithmVersion: typeof ALGORITHM_VERSION;
}

export type SelectionRule = 'bland';

export interface Tolerances {
  zero: number;
  pivotMin: number;
  valueAbs: number;
}

export type SolveStatus =
  | 'optimal'
  | 'unbounded'
  | 'iteration_limit'
  | 'numerical_error';

export interface RatioCandidate {
  slackRow: number;
  constraint: string;
  pivotColumnCoefficient: number;
  rhs: number;
  ratio: number;
  eligible: boolean;
  leaving: boolean;
  excludedReason?: string;
}

export interface IterationRecord {
  iteration: number;
  objectiveBefore: number;
  objectiveAfter: number;
  entering: {
    variable: string;
    column: number;
    reducedCost: number;
  } | null;
  leaving: {
    slackColumn: number;
    variable: string;
    slackRow: number;
  } | null;
  pivotElement: number | null;
  degenerate: boolean;
  ratioCandidates: RatioCandidate[];
  basisBefore: (string | null)[];
  basisAfter: (string | null)[];
  tableau: number[][];
}

export interface FeasibilityReport {
  feasible: boolean;
  residuals: {
    constraint: string;
    lhs: number;
    rhs: number;
    slack: number;
    violated: boolean;
  }[];
  objective: number;
  maxViolation: number;
}

export interface SolveResult {
  status: SolveStatus;
  iterations: number;
  objective: number | null;
  point: Record<string, number> | null;
  slacks: Record<string, number> | null;
  unboundedDirection: {
    enteringVariable: string;
    column: number;
    reason: string;
  } | null;
  alternateOptimaPossible: boolean;
  feasibility: FeasibilityReport | null;
  stoppingReason: string;
  iterationsRecords: IterationRecord[];
  finalBasis: (string | null)[];
  finalTableau: number[][];
}
