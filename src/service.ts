import { randomUUID } from 'node:crypto';
import { AppError, ERROR_CODES, LIMITS } from './constants.js';
import { checkFeasibility } from './simplex.js';
import type { Database } from './db.js';
import { getModelOrThrow, getRunOrThrow, listRuns } from './store.js';
import type { FeasibilityReport, LPModel } from './types.js';

export function verifyCandidate(
  db: Database,
  modelId: string,
  rawPoint: unknown,
  toleranceOverride?: number,
): { id: string; point: Record<string, number>; report: FeasibilityReport; matchesOptimum: boolean | null } {
  const model = getModelOrThrow(db, modelId);
  if (typeof rawPoint !== 'object' || rawPoint === null || Array.isArray(rawPoint)) {
    throw new AppError(ERROR_CODES.CANDIDATE_DIMENSION, '候选点必须是以变量名为键的 JSON 对象');
  }
  const record = rawPoint as Record<string, unknown>;
  const values: number[] = [];
  for (const name of model.variables) {
    if (!(name in record)) {
      throw new AppError(
        ERROR_CODES.CANDIDATE_DIMENSION,
        `候选点缺少变量「${name}」；必须提供全部 ${model.variables.length} 个变量`,
      );
    }
    const value = record[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new AppError(
        ERROR_CODES.CANDIDATE_NON_FINITE,
        `候选点变量「${name}」必须是有限数值，收到：${String(value)}`,
      );
    }
    values.push(value);
  }
  const extra = Object.keys(record).filter((key) => !model.variables.includes(key));
  if (extra.length > 0) {
    throw new AppError(ERROR_CODES.CANDIDATE_DIMENSION, `候选点包含模型中不存在的变量：${extra.join('、')}`);
  }

  const tol = toleranceOverride ?? 1e-7;
  if (typeof tol !== 'number' || !Number.isFinite(tol) || tol <= 0 || tol >= 1) {
    throw new AppError(ERROR_CODES.INVALID_TOLERANCE, `容差必须是 (0,1) 内的有限数值：${String(tol)}`);
  }

  const report = checkFeasibility(model, values, tol);

  let matchesOptimum: boolean | null = null;
  const optimalRuns = listRuns(db, modelId).filter((run) => run.status === 'optimal');
  if (optimalRuns.length > 0) {
    const best = Math.max(...optimalRuns.map((run) => run.objective ?? -Infinity));
    matchesOptimum =
      report.feasible && Math.abs(report.objective - best) <= tol * Math.max(1, Math.abs(best));
  }

  const id = randomUUID();
  db.prepare(
    'INSERT INTO verifications (id, model_id, run_id, kind, payload_json, feasible, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
  ).run(
    id,
    modelId,
    'external_candidate',
    JSON.stringify({ point: record, report, matchesOptimum, tolerance: tol }),
    report.feasible ? 1 : 0,
    new Date().toISOString(),
  );

  return {
    id,
    point: Object.fromEntries(model.variables.map((name, i) => [name, values[i]])),
    report,
    matchesOptimum,
  };
}

export function compareRuns(
  db: Database,
  runIdA: string,
  runIdB: string,
): {
  runA: { id: string; modelId: string; status: string; objective: number | null; iterations: number };
  runB: { id: string; modelId: string; status: string; objective: number | null; iterations: number };
  sameModel: boolean;
  notes: string[];
} {
  const runA = getRunOrThrow(db, runIdA);
  const runB = getRunOrThrow(db, runIdB);
  if (runA.modelId !== runB.modelId) {
    throw new AppError(
      ERROR_CODES.RUNS_INCOMPATIBLE,
      '两次运行不属于同一模型；修改目标或约束会创建新运行，旧最优点按其冻结模型保留，不直接比较数值',
      { modelA: runA.modelId, modelB: runB.modelId },
    );
  }
  const notes: string[] = [];
  if (runA.modelFingerprint !== runB.modelFingerprint) {
    notes.push('警告：同一 modelId 下模型内容指纹不同');
  }
  if (runA.options.maxIterations !== runB.options.maxIterations) {
    notes.push(`迭代预算不同：${runA.options.maxIterations} vs ${runB.options.maxIterations}`);
  }
  if (JSON.stringify(runA.options.tolerance) !== JSON.stringify(runB.options.tolerance)) {
    notes.push('数值容差配置不同，结果差异可能来自容差而非算法');
  }
  if (runA.status === 'optimal' && runB.status === 'optimal') {
    if (Math.abs((runA.objective ?? 0) - (runB.objective ?? 0)) <= 1e-9) {
      notes.push('两次运行均最优且目标值一致，符合 Bland 规则的确定性预期');
    } else {
      notes.push('两次最优运行目标值不一致，可能存在配置差异');
    }
  }
  return {
    runA: {
      id: runA.id,
      modelId: runA.modelId,
      status: runA.status,
      objective: runA.objective,
      iterations: runA.result.iterations,
    },
    runB: {
      id: runB.id,
      modelId: runB.modelId,
      status: runB.status,
      objective: runB.objective,
      iterations: runB.result.iterations,
    },
    sameModel: true,
    notes,
  };
}

export function exportRun(db: Database, runId: string): {
  model: LPModel;
  run: ReturnType<typeof getRunOrThrow>;
  exportedAt: string;
  limits: typeof LIMITS;
} {
  const run = getRunOrThrow(db, runId);
  const model = getModelOrThrow(db, run.modelId);
  return { model, run, exportedAt: new Date().toISOString(), limits: LIMITS };
}
