/** 输入校验：维度、重名、非有限系数、负右端、规模与预算上限。 */

import {
  MAX_COEFFICIENT_ABS,
  MAX_CONSTRAINTS,
  MAX_ITERATIONS_LIMIT,
  MAX_VARIABLES,
} from "./simplex";

export type ErrorCode =
  | "DIM_MISMATCH"
  | "DUPLICATE_NAME"
  | "NON_FINITE"
  | "NEGATIVE_RHS"
  | "LIMIT_EXCEEDED"
  | "BAD_BUDGET"
  | "BAD_SHAPE"
  | "NOT_FOUND"
  | "BAD_CANDIDATE";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public httpStatus = 400
  ) {
    super(message);
  }
}

export interface ModelInput {
  name?: string;
  c: number[];
  A: number[][];
  b: number[];
  varNames: string[];
  constraintNames: string[];
}

function checkFinite(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ApiError("NON_FINITE", `${where} 不是有限数值（小数允许，但不支持任意精度/NaN/Infinity）`);
  }
  if (Math.abs(v) > MAX_COEFFICIENT_ABS) {
    throw new ApiError(
      "LIMIT_EXCEEDED",
      `${where} 的绝对值超过系数量级上限 ${MAX_COEFFICIENT_ABS}`
    );
  }
  return v;
}

export function validateModel(input: unknown): Required<ModelInput> {
  const m = input as ModelInput;
  if (!m || typeof m !== "object") throw new ApiError("BAD_SHAPE", "请求体必须是对象");
  for (const key of ["c", "A", "b", "varNames", "constraintNames"] as const) {
    if (m[key] === undefined)
      throw new ApiError("BAD_SHAPE", `缺少字段 ${key}`);
  }
  if (!Array.isArray(m.c) || !Array.isArray(m.A) || !Array.isArray(m.b))
    throw new ApiError("BAD_SHAPE", "c/A/b 必须是数组");
  if (!Array.isArray(m.varNames) || !Array.isArray(m.constraintNames))
    throw new ApiError("BAD_SHAPE", "varNames/constraintNames 必须是字符串数组");

  const n = m.c.length;
  const rows = m.A.length;
  if (n < 1 || rows < 1)
    throw new ApiError("BAD_SHAPE", "至少需要一个变量和一个约束");
  if (n > MAX_VARIABLES)
    throw new ApiError("LIMIT_EXCEEDED", `变量数 ${n} 超过上限 ${MAX_VARIABLES}`);
  if (rows > MAX_CONSTRAINTS)
    throw new ApiError("LIMIT_EXCEEDED", `约束数 ${rows} 超过上限 ${MAX_CONSTRAINTS}`);

  if (m.varNames.length !== n)
    throw new ApiError("DIM_MISMATCH", `varNames 长度 ${m.varNames.length} 与 c 长度 ${n} 不一致`);
  if (m.constraintNames.length !== rows)
    throw new ApiError("DIM_MISMATCH", `constraintNames 长度 ${m.constraintNames.length} 与 A 行数 ${rows} 不一致`);
  if (m.b.length !== rows)
    throw new ApiError("DIM_MISMATCH", `b 长度 ${m.b.length} 与 A 行数 ${rows} 不一致`);

  const allNames = [...m.varNames, ...m.constraintNames];
  for (const nm of allNames) {
    if (typeof nm !== "string" || nm.trim() === "")
      throw new ApiError("BAD_SHAPE", "变量/约束名称必须是非空字符串");
  }
  if (new Set(allNames).size !== allNames.length)
    throw new ApiError("DUPLICATE_NAME", "变量或约束名称重复");

  m.c.forEach((v, j) => checkFinite(v, `c[${j}]`));
  m.A.forEach((row, i) => {
    if (!Array.isArray(row) || row.length !== n)
      throw new ApiError("DIM_MISMATCH", `A[${i}] 长度与变量数 ${n} 不一致`);
    row.forEach((v, j) => checkFinite(v, `A[${i}][${j}]`));
  });
  m.b.forEach((v, i) => {
    checkFinite(v, `b[${i}]`);
    if (v < 0)
      throw new ApiError(
        "NEGATIVE_RHS",
        `b[${i}] = ${v} 为负。本服务仅支持 b >= 0（原点可行）的受限形式，不做两阶段法；这不是"数学上不可行"。`
      );
  });

  return {
    name: typeof m.name === "string" && m.name.trim() ? m.name : "未命名模型",
    c: m.c,
    A: m.A,
    b: m.b,
    varNames: m.varNames,
    constraintNames: m.constraintNames,
  };
}

export function validateBudget(opts: {
  tolerance?: unknown;
  maxIterations?: unknown;
}): { tolerance?: number; maxIterations?: number } {
  const out: { tolerance?: number; maxIterations?: number } = {};
  if (opts.tolerance !== undefined) {
    const t = opts.tolerance;
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0 || t > 1e-2)
      throw new ApiError("BAD_BUDGET", "tolerance 必须是 (0, 1e-2] 内的有限数");
    out.tolerance = t;
  }
  if (opts.maxIterations !== undefined) {
    const k = opts.maxIterations;
    if (typeof k !== "number" || !Number.isInteger(k) || k < 1 || k > MAX_ITERATIONS_LIMIT)
      throw new ApiError("BAD_BUDGET", `maxIterations 必须是 1..${MAX_ITERATIONS_LIMIT} 的整数`);
    out.maxIterations = k;
  }
  return out;
}
