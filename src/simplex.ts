/**
 * 受限原始单纯形法核心。
 *
 * 仅支持如下形式（输入已保证原点可行）：
 *   maximize  c · x
 *   subject to A x <= b,  x >= 0,  b >= 0
 *
 * 做法：加入松弛变量 s = b - A x（s >= 0），以全部松弛变量为初始基，
 * 使用 Bland 规则（最小下标）选择入基列与平局时的离基行，确定性防循环。
 * 不做两阶段法、对偶单纯形、等式/负右端/整数规划，也不调用任何外部 LP 库。
 */

export const ALGORITHM_VERSION = "primal-simplex-bland/1.0.0";

export const DEFAULT_TOLERANCE = 1e-9;
export const DEFAULT_MAX_ITERATIONS = 1000;
export const MAX_ITERATIONS_LIMIT = 100000;
export const MAX_VARIABLES = 50;
export const MAX_CONSTRAINTS = 50;
export const MAX_COEFFICIENT_ABS = 1e9;

export type SolveStatus =
  | "optimal"
  | "unbounded"
  | "iteration_limit"
  | "numerical_error";

export interface RatioCandidate {
  row: number;
  basicVarIndex: number;
  basicVarName: string;
  ratio: number;
}

export interface StepRecord {
  iteration: number;
  enteringIndex: number;
  enteringName: string;
  enteringReducedCost: number;
  leavingRow: number;
  leavingIndex: number;
  leavingName: string;
  pivot: number;
  ratios: RatioCandidate[];
  objectiveBefore: number;
  objectiveAfter: number;
  basisBefore: string[];
  basisAfter: string[];
  /** 退化换基：目标值本轮没有变化 */
  degenerate: boolean;
}

export interface TableauSnapshot {
  iteration: number;
  /** 当前基变量下标（指向 names 的下标），按约束行排列 */
  basis: number[];
  basisNames: string[];
  /** m 行 × (n+m) 列的当前约束矩阵 */
  rows: number[][];
  rhs: number[];
  /** 当前检验数（reduced costs），约定：> tol 表示可改进目标 */
  reducedCosts: number[];
  objective: number;
}

export interface SolveResult {
  status: SolveStatus;
  algorithmVersion: string;
  iterations: number;
  objective?: number;
  x?: number[];
  slack?: number[];
  steps: StepRecord[];
  tableaus: TableauSnapshot[];
  /** 无界时：导致无界的入基列 */
  unboundedColumnIndex?: number;
  unboundedColumnName?: string;
  message: string;
  /** 独立残差核对：max(Ax - b)，最优时给出 */
  feasibilityResidual?: number;
}

export interface SolveOptions {
  tolerance?: number;
  maxIterations?: number;
}

/**
 * 执行原始单纯形法。所有输入必须先经过 validate.ts 校验。
 * 变量顺序固定为 [x_0..x_{n-1}, s_0..s_{m-1}]，平局按下标打破，完全确定。
 */
export function solvePrimalSimplex(
  c: number[],
  A: number[][],
  b: number[],
  varNames: string[],
  constraintNames: string[],
  options: SolveOptions = {}
): SolveResult {
  const tol = options.tolerance ?? DEFAULT_TOLERANCE;
  const maxIter = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const n = c.length;
  const m = A.length;
  const totalVars = n + m;
  const names = [...varNames, ...constraintNames.map((nm) => `s(${nm})`)];

  // 初始表：行 = [A | I]，rhs = b
  const rows: number[][] = A.map((row, i) => {
    const r = new Array<number>(totalVars).fill(0);
    for (let j = 0; j < n; j++) r[j] = row[j];
    r[n + i] = 1;
    return r;
  });
  const rhs = b.slice();
  const cost = [...c, ...new Array<number>(m).fill(0)];
  const basis: number[] = Array.from({ length: m }, (_, i) => n + i);

  const steps: StepRecord[] = [];
  const tableaus: TableauSnapshot[] = [];

  const computeReducedCosts = (): { rc: number[]; objective: number } => {
    const rc = new Array<number>(totalVars);
    let objective = 0;
    for (let i = 0; i < m; i++) objective += cost[basis[i]] * rhs[i];
    for (let j = 0; j < totalVars; j++) {
      let v = cost[j];
      for (let i = 0; i < m; i++) v -= cost[basis[i]] * rows[i][j];
      rc[j] = v;
    }
    return { rc, objective };
  };

  const snapshot = (iteration: number): TableauSnapshot => {
    const { rc, objective } = computeReducedCosts();
    return {
      iteration,
      basis: basis.slice(),
      basisNames: basis.map((bi) => names[bi]),
      rows: rows.map((r) => r.slice()),
      rhs: rhs.slice(),
      reducedCosts: rc.slice(),
      objective,
    };
  };

  tableaus.push(snapshot(0));

  for (let iter = 1; ; iter++) {
    const { rc, objective } = computeReducedCosts();

    // Bland 入基规则：检验数 > tol 的最小下标列
    let entering = -1;
    for (let j = 0; j < totalVars; j++) {
      if (rc[j] > tol) {
        entering = j;
        break;
      }
    }

    if (entering === -1) {
      // 最优：恢复原变量与松弛量，并独立核对 Ax <= b 残差
      const x = new Array<number>(n).fill(0);
      const slack = new Array<number>(m).fill(0);
      for (let i = 0; i < m; i++) {
        if (basis[i] < n) x[basis[i]] = rhs[i];
        else slack[basis[i] - n] = rhs[i];
      }
      let residual = -Infinity;
      for (let i = 0; i < m; i++) {
        let ax = 0;
        for (let j = 0; j < n; j++) ax += A[i][j] * x[j];
        residual = Math.max(residual, ax - b[i]);
      }
      return {
        status: "optimal",
        algorithmVersion: ALGORITHM_VERSION,
        iterations: iter - 1,
        objective,
        x,
        slack,
        steps,
        tableaus,
        feasibilityResidual: residual,
        message:
          "目标行已无可改进方向，达到最优。若存在多个最优点，此处只返回其中一个顶点。",
      };
    }

    if (iter > maxIter) {
      return {
        status: "iteration_limit",
        algorithmVersion: ALGORITHM_VERSION,
        iterations: iter - 1,
        steps,
        tableaus,
        message: `已达到迭代预算 ${maxIter} 次仍未收敛，结果不是最优，不冒充最优返回。`,
      };
    }

    // 最小比值检验：仅考虑列系数 > tol 的行
    const ratios: RatioCandidate[] = [];
    for (let i = 0; i < m; i++) {
      const a = rows[i][entering];
      if (a > tol) {
        ratios.push({
          row: i,
          basicVarIndex: basis[i],
          basicVarName: names[basis[i]],
          ratio: rhs[i] / a,
        });
      }
    }

    if (ratios.length === 0) {
      return {
        status: "unbounded",
        algorithmVersion: ALGORITHM_VERSION,
        iterations: iter - 1,
        steps,
        tableaus,
        unboundedColumnIndex: entering,
        unboundedColumnName: names[entering],
        message: `入基列 "${names[entering]}"（检验数 ${rc[entering]}）可改进目标，但该列所有约束系数 <= 容差，没有任何可离基行：沿该方向目标可无限增大，问题无界。`,
      };
    }

    // Bland 离基规则：先取最小比值，平局取基变量下标最小者（确定性）
    let best = ratios[0];
    for (const cand of ratios) {
      if (
        cand.ratio < best.ratio - tol ||
        (Math.abs(cand.ratio - best.ratio) <= tol &&
          cand.basicVarIndex < best.basicVarIndex)
      ) {
        best = cand;
      }
    }

    const leavingRow = best.row;
    const leavingIndex = basis[leavingRow];
    const pivot = rows[leavingRow][entering];
    if (!Number.isFinite(pivot) || Math.abs(pivot) <= tol) {
      return {
        status: "numerical_error",
        algorithmVersion: ALGORITHM_VERSION,
        iterations: iter - 1,
        steps,
        tableaus,
        message: `枢轴元素 ${pivot} 过小或非有限，无法可靠消元，停止且不声称最优。`,
      };
    }

    // 枢轴消元
    const pivotRow = rows[leavingRow];
    for (let j = 0; j < totalVars; j++) pivotRow[j] /= pivot;
    rhs[leavingRow] /= pivot;
    for (let i = 0; i < m; i++) {
      if (i === leavingRow) continue;
      const factor = rows[i][entering];
      if (factor === 0) continue;
      for (let j = 0; j < totalVars; j++) rows[i][j] -= factor * pivotRow[j];
      rhs[i] -= factor * rhs[leavingRow];
    }
    for (let j = 0; j < totalVars; j++) {
      if (Math.abs(rows[leavingRow][j]) < 1e-12) rows[leavingRow][j] = 0;
    }
    basis[leavingRow] = entering;

    const after = computeReducedCosts();
    const step: StepRecord = {
      iteration: iter,
      enteringIndex: entering,
      enteringName: names[entering],
      enteringReducedCost: rc[entering],
      leavingRow,
      leavingIndex,
      leavingName: names[leavingIndex],
      pivot,
      ratios,
      objectiveBefore: objective,
      objectiveAfter: after.objective,
      basisBefore: tableaus[tableaus.length - 1].basisNames,
      basisAfter: basis.map((bi) => names[bi]),
      degenerate: Math.abs(after.objective - objective) <= tol,
    };
    steps.push(step);
    tableaus.push(snapshot(iter));
  }
}
