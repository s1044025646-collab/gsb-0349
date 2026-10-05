import { AppError, DEFAULT_TOLERANCE, ERROR_CODES, LIMITS } from './constants.js';
import type { ModelInput, SolveOptions, Tolerances } from './types.js';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateModelInput(input: unknown): ModelInput {
  if (typeof input !== 'object' || input === null) {
    throw new AppError(ERROR_CODES.INVALID_JSON, '请求体必须是 JSON 对象');
  }
  const obj = input as Record<string, unknown>;
  const { variables, constraints, A, b, c } = obj as Record<string, unknown>;

  if (!Array.isArray(variables) || !Array.isArray(constraints) || !Array.isArray(A) || !Array.isArray(b) || !Array.isArray(c)) {
    throw new AppError(
      ERROR_CODES.VALIDATION_EMPTY,
      'variables、constraints、A、b、c 均必须提供且为数组',
    );
  }

  const n = variables.length;
  const m = constraints.length;

  if (n === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_EMPTY, '至少需要一个变量');
  }
  if (m === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_EMPTY, '至少需要一个约束');
  }
  if (n > LIMITS.maxVariables || m > LIMITS.maxConstraints) {
    throw new AppError(
      ERROR_CODES.VALIDATION_LIMIT,
      `变量或约束数量超限：变量最多 ${LIMITS.maxVariables} 个，约束最多 ${LIMITS.maxConstraints} 个`,
      { variableCount: n, constraintCount: m },
    );
  }

  const stringNames = (arr: unknown[], kind: string): string[] =>
    arr.map((item, index) => {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new AppError(ERROR_CODES.VALIDATION_EMPTY, `${kind}第 ${index + 1} 项必须是非空字符串`);
      }
      const name = item.trim();
      if (name.length > LIMITS.maxNameLength) {
        throw new AppError(
          ERROR_CODES.VALIDATION_LIMIT,
          `${kind}名称长度不能超过 ${LIMITS.maxNameLength} 个字符：${name}`,
        );
      }
      return name;
    });

  const varNames = stringNames(variables, '变量');
  const conNames = stringNames(constraints, '约束');

  const checkUnique = (names: string[], code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES]) => {
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) {
        throw new AppError(code, `名称重复：${name}`, { name });
      }
      seen.add(name);
    }
  };
  checkUnique(varNames, ERROR_CODES.VALIDATION_DUPLICATE_NAME);
  checkUnique(conNames, ERROR_CODES.VALIDATION_DUPLICATE_NAME);

  const coefficientMatrix = A.map((row, i) => {
    if (!Array.isArray(row) || row.length !== n) {
      throw new AppError(
        ERROR_CODES.VALIDATION_DIMENSION,
        `矩阵 A 第 ${i + 1} 行长度必须等于变量数 ${n}`,
        { row: i + 1, expected: n, actual: Array.isArray(row) ? row.length : null },
      );
    }
    return row.map((value, j) => {
      if (!isFiniteNumber(value)) {
        throw new AppError(ERROR_CODES.VALIDATION_NON_FINITE, `A[${i + 1}][${j + 1}] 不是有限数值`, {
          value: String(value),
        });
      }
      if (Math.abs(value) > LIMITS.coefficientAbsMax) {
        throw new AppError(
          ERROR_CODES.VALIDATION_LIMIT,
          `系数量级超限：|A[${i + 1}][${j + 1}]| 不超过 ${LIMITS.coefficientAbsMax}`,
        );
      }
      return value;
    });
  });

  if (A.length !== m) {
    throw new AppError(ERROR_CODES.VALIDATION_DIMENSION, `矩阵 A 行数必须等于约束数 ${m}`);
  }

  const rhs = b.map((value, i) => {
    if (!isFiniteNumber(value)) {
      throw new AppError(ERROR_CODES.VALIDATION_NON_FINITE, `b[${i + 1}] 不是有限数值`, { value: String(value) });
    }
    if (Math.abs(value) > LIMITS.rhsAbsMax) {
      throw new AppError(
        ERROR_CODES.VALIDATION_LIMIT,
        `右端量级超限：|b[${i + 1}]| 不超过 ${LIMITS.rhsAbsMax}`,
      );
    }
    if (value < 0) {
      throw new AppError(
        ERROR_CODES.VALIDATION_NEGATIVE_RHS,
        `不支持负右端：b[${i + 1}] = ${value}。本服务只支持零起点可行的 Ax ≤ b、b ≥ 0 形式；负右端不会被标为数学上不可行，而是拒绝处理`,
        { index: i, value },
      );
    }
    return value;
  });

  if (c.length !== n) {
    throw new AppError(ERROR_CODES.VALIDATION_DIMENSION, `目标系数 c 长度必须等于变量数 ${n}`);
  }
  const objective = c.map((value, j) => {
    if (!isFiniteNumber(value)) {
      throw new AppError(ERROR_CODES.VALIDATION_NON_FINITE, `c[${j + 1}] 不是有限数值`, { value: String(value) });
    }
    if (Math.abs(value) > LIMITS.coefficientAbsMax) {
      throw new AppError(
        ERROR_CODES.VALIDATION_LIMIT,
        `目标系数量级超限：|c[${j + 1}]| 不超过 ${LIMITS.coefficientAbsMax}`,
      );
    }
    return value;
  });

  const name = typeof obj.name === 'string' && obj.name.trim() !== '' ? obj.name.trim() : '未命名模型';

  return {
    name,
    variables: varNames,
    constraints: conNames,
    A: coefficientMatrix,
    b: rhs,
    c: objective,
  };
}

export function validateSolveOptions(raw: unknown): SolveOptions {
  const provided = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const rule = provided.rule === undefined ? 'bland' : provided.rule;
  if (rule !== 'bland') {
    throw new AppError(ERROR_CODES.INVALID_BUDGET, `不支持的选择规则：${String(rule)}，当前仅实现 bland`, {
      supported: ['bland'],
    });
  }

  let maxIterations: number = LIMITS.defaultMaxIterations;
  if (provided.maxIterations !== undefined) {
    const value = provided.maxIterations;
    if (!isFiniteNumber(value) || !Number.isInteger(value) || value <= 0) {
      throw new AppError(ERROR_CODES.INVALID_BUDGET, `maxIterations 必须是正整数，收到：${String(value)}`);
    }
    if (value > LIMITS.maxIterationsCap) {
      throw new AppError(
        ERROR_CODES.INVALID_BUDGET,
        `maxIterations 不能超过 ${LIMITS.maxIterationsCap}，避免不受控计算`,
      );
    }
    maxIterations = value;
  }

  const rawTol = (provided.tolerance ?? {}) as Record<string, unknown>;
  const tolerance: Tolerances = { ...DEFAULT_TOLERANCE };
  for (const key of ['zero', 'pivotMin', 'valueAbs'] as const) {
    if (rawTol[key] !== undefined) {
      const value = rawTol[key];
      if (!isFiniteNumber(value) || value <= 0 || value >= 1) {
        throw new AppError(
          ERROR_CODES.INVALID_TOLERANCE,
          `tolerance.${key} 必须是区间 (0,1) 内的有限数值，收到：${String(value)}`,
        );
      }
      tolerance[key] = value;
    }
  }
  if (!(tolerance.pivotMin <= tolerance.zero && tolerance.zero <= tolerance.valueAbs)) {
    throw new AppError(
      ERROR_CODES.INVALID_TOLERANCE,
      '容差需满足 pivotMin ≤ zero ≤ valueAbs',
      tolerance,
    );
  }

  return {
    rule: 'bland',
    maxIterations,
    tolerance,
    algorithmVersion: 'primal-simplex-bland-v1.0.0',
  };
}
