import type {
  FeasibilityReport,
  IterationRecord,
  LPModel,
  RatioCandidate,
  SolveOptions,
  SolveResult,
} from './types.js';

function slackName(constraintName: string): string {
  return `松弛[${constraintName}]`;
}

export function allColumnNames(model: LPModel): string[] {
  return [...model.variables, ...model.constraints.map(slackName)];
}

export function buildInitialTableau(model: LPModel): number[][] {
  const m = model.constraints.length;
  const n = model.variables.length;
  const width = n + m + 1;
  const tableau: number[][] = [];

  const objectiveRow = new Array<number>(width).fill(0);
  for (let j = 0; j < n; j += 1) {
    objectiveRow[j] = -model.c[j];
  }
  tableau.push(objectiveRow);

  for (let i = 0; i < m; i += 1) {
    const row = new Array<number>(width).fill(0);
    for (let j = 0; j < n; j += 1) {
      row[j] = model.A[i][j];
    }
    row[n + i] = 1;
    row[n + m] = model.b[i];
    tableau.push(row);
  }
  return tableau;
}

function ratioTieEqual(a: number, b: number, tol: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= tol * scale;
}

function roundTiny(value: number, tol: number): number {
  return Math.abs(value) <= tol ? 0 : value;
}

export function checkFeasibility(model: LPModel, point: number[], tol: number): FeasibilityReport {
  const m = model.constraints.length;
  const n = model.variables.length;
  const residuals = model.constraints.map((name, i) => {
    let lhs = 0;
    for (let j = 0; j < n; j += 1) {
      lhs += model.A[i][j] * point[j];
    }
    const slack = model.b[i] - lhs;
    return {
      constraint: name,
      lhs,
      rhs: model.b[i],
      slack,
      violated: slack < -tol,
    };
  });

  const negativeVar = point.some((value) => value < -tol);
  let objective = 0;
  for (let j = 0; j < n; j += 1) {
    objective += model.c[j] * point[j];
  }
  const maxViolation = Math.max(
    negativeVar ? Math.abs(Math.min(0, ...point)) : 0,
    ...residuals.map((r) => (r.violated ? -r.slack : 0)),
    0,
  );
  return {
    feasible: !negativeVar && !residuals.some((r) => r.violated),
    residuals,
    objective,
    maxViolation,
  };
}

export function solve(model: LPModel, options: SolveOptions): SolveResult {
  const m = model.constraints.length;
  const n = model.variables.length;
  const rhsCol = n + m;
  const tol = options.tolerance;
  const tableau = buildInitialTableau(model);
  const columnNames = allColumnNames(model);
  // basis[i] 为第 i 个约束行当前基变量的全局列号；初始基为松弛变量
  const basis = Array.from({ length: m }, (_unused, i) => n + i);

  const records: IterationRecord[] = [];

  const snapshot = (
    iteration: number,
    before: number,
    after: number,
    entering: IterationRecord['entering'],
    leaving: IterationRecord['leaving'],
    pivotElement: number | null,
    ratioCandidates: RatioCandidate[],
    basisBefore: number[],
  ): IterationRecord => ({
    iteration,
    objectiveBefore: before,
    objectiveAfter: after,
    entering,
    leaving,
    pivotElement,
    degenerate: ratioCandidates.some((candidate) => candidate.leaving && Math.abs(candidate.ratio) <= tol.zero),
    ratioCandidates,
    basisBefore: basisBefore.map((col) => columnNames[col] ?? null),
    basisAfter: basis.map((col) => columnNames[col] ?? null),
    tableau: tableau.map((row) => row.map((value) => roundTiny(value, tol.zero))),
  });

  records.push(snapshot(0, 0, 0, null, null, null, [], [...basis]));

  let status: SolveResult['status'] | null = null;
  let unboundedColumn = -1;
  let unboundedReason = '';
  let pivotCount = 0;

  while (status === null) {
    // 符号约定：目标行 z 行系数为 z_j - c_j，最大化时负系数表示可改善
    let enteringCol = -1;
    for (let col = 0; col < rhsCol; col += 1) {
      if (tableau[0][col] < -tol.zero) {
        enteringCol = col; // Bland：取索引最小的可入基列，与名称遍历顺序无关
        break;
      }
    }

    if (enteringCol === -1) {
      status = 'optimal';
      break;
    }

    // 最小比值检验
    const candidates: RatioCandidate[] = [];
    let bestRatio = Number.POSITIVE_INFINITY;
    let bestRow = -1;
    for (let i = 1; i <= m; i += 1) {
      const coefficient = tableau[i][enteringCol];
      const rhs = tableau[i][rhsCol];
      const eligible = coefficient > tol.zero;
      const ratio = eligible ? rhs / coefficient : Number.POSITIVE_INFINITY;
      candidates.push({
        slackRow: i - 1,
        constraint: model.constraints[i - 1],
        pivotColumnCoefficient: coefficient,
        rhs,
        ratio: eligible ? ratio : Number.NaN,
        eligible,
        leaving: false,
        excludedReason: eligible ? undefined : '入基列系数不为正，沿该方向不限制此约束',
      });
      if (eligible) {
        const basisIndex = basis[i - 1];
        const better =
          bestRow === -1 ||
          ratio < bestRatio - tol.zero * Math.max(1, Math.abs(ratio), Math.abs(bestRatio)) ||
          (ratioTieEqual(ratio, bestRatio, tol.zero) && basisIndex < basis[bestRow - 1]);
        if (better) {
          bestRatio = ratio;
          bestRow = i;
        }
      }
    }

    if (bestRow === -1) {
      status = 'unbounded';
      unboundedColumn = enteringCol;
      unboundedReason =
        `入基变量「${columnNames[enteringCol]}」（第 ${enteringCol + 1} 列）在所有约束行中的系数均不大于 ${tol.zero}，` +
        '沿该方向移动不会遇到任何约束边界，最小比值检验无候选离基行，目标可无限增大';
      break;
    }

    const pivot = tableau[bestRow][enteringCol];
    if (!Number.isFinite(pivot) || Math.abs(pivot) < tol.pivotMin) {
      status = 'numerical_error';
      break;
    }

    candidates[bestRow - 1].leaving = true;
    const leavingCol = basis[bestRow - 1];
    const objectiveBefore = tableau[0][rhsCol];
    const basisBefore = [...basis];
    const reducedCost = tableau[0][enteringCol];

    // 枢轴消元：先归一化枢轴行，再消去其余各行（含目标行）
    for (let col = 0; col <= rhsCol; col += 1) {
      tableau[bestRow][col] /= pivot;
    }
    for (let i = 0; i <= m; i += 1) {
      if (i === bestRow) continue;
      const factor = tableau[i][enteringCol];
      if (factor === 0) continue;
      for (let col = 0; col <= rhsCol; col += 1) {
        tableau[i][col] -= factor * tableau[bestRow][col];
      }
    }
    basis[bestRow - 1] = enteringCol;
    pivotCount += 1;

    const objectiveAfter = tableau[0][rhsCol];
    records.push(
      snapshot(
        pivotCount,
        objectiveBefore,
        objectiveAfter,
        { variable: columnNames[enteringCol], column: enteringCol, reducedCost },
        {
          slackColumn: leavingCol,
          variable: columnNames[leavingCol],
          slackRow: bestRow - 1,
        },
        pivot,
        candidates,
        basisBefore,
      ),
    );

    if (tableau.slice(1).some((row) => row[rhsCol] < -tol.valueAbs)) {
      status = 'numerical_error';
      break;
    }

    if (pivotCount >= options.maxIterations) {
      // 再检查是否确有可改善方向；若恰好在预算内已最优则交由下一轮判定
      const stillImprovable = tableau[0].slice(0, rhsCol).some((value) => value < -tol.zero);
      if (stillImprovable) {
        status = 'iteration_limit';
        break;
      }
    }
  }

  // 从当前基恢复解：基变量取对应 RHS，非基变量为 0
  const fullValues = new Array<number>(n + m).fill(0);
  for (let i = 0; i < m; i += 1) {
    fullValues[basis[i]] = tableau[i + 1][rhsCol];
  }
  const x = fullValues.slice(0, n).map((value) => roundTiny(value, tol.valueAbs));
  const slackValues = fullValues.slice(n).map((value) => roundTiny(value, tol.valueAbs));

  const pointRecord = Object.fromEntries(model.variables.map((name, j) => [name, x[j]]));
  const slackRecord = Object.fromEntries(model.constraints.map((name, i) => [slackName(name), slackValues[i]]));

  let objective: number | null = null;
  let feasibility: FeasibilityReport | null = null;
  let alternateOptimaPossible = false;

  if (status === 'optimal' || status === 'iteration_limit') {
    objective = model.c.reduce((sum, cj, j) => sum + cj * x[j], 0);
    feasibility = checkFeasibility(model, x, tol.valueAbs);
    // 非基原变量的检验数约为 0：存在其他最优极点（本结果仅为其中之一）
    const basicCols = new Set(basis);
    for (let col = 0; col < n; col += 1) {
      if (!basicCols.has(col) && Math.abs(tableau[0][col]) <= tol.valueAbs) {
        alternateOptimaPossible = true;
      }
    }
  }

  const stoppingReasons: Record<NonNullable<typeof status>, string> = {
    optimal: `目标行所有检验数均不小于 -${tol.zero}（Bland 规则），不存在可改善的入基方向，当前基可行解为最优解之一`,
    unbounded: unboundedReason,
    iteration_limit: `已达到迭代预算 ${options.maxIterations} 次枢轴，仍存在负检验数；停止并返回当前可行解，不宣称最优`,
    numerical_error: `枢轴元小于数值底线 ${tol.pivotMin} 或消元后右端显著为负，无法在当前容差下可靠继续换基；不宣称最优`,
  };

  return {
    status,
    iterations: pivotCount,
    objective,
    point: status === 'optimal' || status === 'iteration_limit' ? pointRecord : null,
    slacks: status === 'optimal' || status === 'iteration_limit' ? slackRecord : null,
    unboundedDirection:
      status === 'unbounded'
        ? { enteringVariable: columnNames[unboundedColumn], column: unboundedColumn, reason: unboundedReason }
        : null,
    alternateOptimaPossible,
    feasibility,
    stoppingReason: stoppingReasons[status],
    iterationsRecords: records,
    finalBasis: basis.map((col) => columnNames[col] ?? null),
    finalTableau: tableau.map((row) => row.map((value) => roundTiny(value, tol.valueAbs))),
  };
}
