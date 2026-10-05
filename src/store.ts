import { randomUUID } from 'node:crypto';
import { AppError, ERROR_CODES } from './constants.js';
import type { Database } from './db.js';
import type { IterationRecord, LPModel, ModelInput, SolveOptions, SolveResult } from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

// 内容指纹：目标或约束变化会产生新指纹，旧运行保留并按其冻结模型展示
export function modelFingerprint(input: ModelInput): string {
  const canonical = JSON.stringify([input.variables, input.constraints, input.A, input.b, input.c]);
  let hash = 2166136261;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function createModel(db: Database, input: ModelInput): LPModel {
  const model: LPModel = {
    id: randomUUID(),
    name: input.name ?? '未命名模型',
    variables: input.variables,
    constraints: input.constraints,
    A: input.A,
    b: input.b,
    c: input.c,
    createdAt: nowIso(),
  };
  db.prepare(
    `INSERT INTO models (id, name, payload_json, created_at) VALUES (?, ?, ?, ?)`,
  ).run(model.id, model.name, JSON.stringify(model), model.createdAt);
  return model;
}

export function getModelOrThrow(db: Database, modelId: string): LPModel {
  const row = db.prepare('SELECT payload_json FROM models WHERE id = ?').get(modelId) as
    | { payload_json: string }
    | undefined;
  if (!row) {
    throw new AppError(ERROR_CODES.MODEL_NOT_FOUND, `模型不存在：${modelId}`);
  }
  return JSON.parse(row.payload_json) as LPModel;
}

export function listModels(db: Database): { id: string; name: string; createdAt: string }[] {
  const rows = db.prepare('SELECT id, name, created_at FROM models ORDER BY created_at DESC, id').all() as {
    id: string;
    name: string;
    created_at: string;
  }[];
  return rows.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at }));
}

export interface StoredRun {
  id: string;
  modelId: string;
  modelFingerprint: string;
  options: SolveOptions;
  status: SolveResult['status'];
  objective: number | null;
  result: SolveResult;
  createdAt: string;
}

function runSummary(result: SolveResult) {
  return {
    status: result.status,
    iterations: result.iterations,
    objective: result.objective,
    point: result.point,
    slacks: result.slacks,
    unboundedDirection: result.unboundedDirection,
    alternateOptimaPossible: result.alternateOptimaPossible,
    stoppingReason: result.stoppingReason,
    feasibility: result.feasibility,
    finalBasis: result.finalBasis,
  };
}

export function saveRun(
  db: Database,
  model: LPModel,
  options: SolveOptions,
  result: SolveResult,
): StoredRun {
  const runId = randomUUID();
  const createdAt = nowIso();
  const summary = runSummary(result);
  const fullResult: SolveResult = { ...result };

  const insertRun = db.prepare(`
    INSERT INTO runs
      (id, model_id, model_fingerprint, rule, tolerance_json, max_iterations,
       algorithm_version, status, objective, result_summary_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertIteration = db.prepare(
    'INSERT INTO iterations (run_id, iteration, record_json) VALUES (?, ?, ?)',
  );

  // 结果与逐轮解释在同一事务内原子落盘
  const tx = db.exec.bind(db);
  tx('BEGIN IMMEDIATE');
  try {
    insertRun.run(
      runId,
      model.id,
      modelFingerprint(model),
      options.rule,
      JSON.stringify(options.tolerance),
      options.maxIterations,
      options.algorithmVersion,
      result.status,
      result.objective,
      JSON.stringify({ ...summary, fullResult }),
      createdAt,
    );
    for (const record of result.iterationsRecords) {
      insertIteration.run(runId, record.iteration, JSON.stringify(record));
    }
    tx('COMMIT');
  } catch (error) {
    tx('ROLLBACK');
    throw error;
  }

  return {
    id: runId,
    modelId: model.id,
    modelFingerprint: modelFingerprint(model),
    options,
    status: result.status,
    objective: result.objective,
    result: fullResult,
    createdAt,
  };
}

function mapRunRow(row: {
  id: string;
  model_id: string;
  model_fingerprint: string;
  rule: string;
  tolerance_json: string;
  max_iterations: number;
  algorithm_version: string;
  status: SolveResult['status'];
  objective: number | null;
  result_summary_json: string;
  created_at: string;
}): StoredRun {
  const parsed = JSON.parse(row.result_summary_json) as { fullResult: SolveResult };
  return {
    id: row.id,
    modelId: row.model_id,
    modelFingerprint: row.model_fingerprint,
    options: {
      rule: row.rule as SolveOptions['rule'],
      maxIterations: row.max_iterations,
      tolerance: JSON.parse(row.tolerance_json) as SolveOptions['tolerance'],
      algorithmVersion: row.algorithm_version as SolveOptions['algorithmVersion'],
    },
    status: row.status,
    objective: row.objective,
    result: parsed.fullResult,
    createdAt: row.created_at,
  };
}

export function getRunOrThrow(db: Database, runId: string): StoredRun {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!row) {
    throw new AppError(ERROR_CODES.RUN_NOT_FOUND, `求解运行不存在：${runId}`);
  }
  return mapRunRow(row as Parameters<typeof mapRunRow>[0]);
}

export function listRuns(db: Database, modelId?: string): StoredRun[] {
  const rows = modelId
    ? (db
        .prepare('SELECT * FROM runs WHERE model_id = ? ORDER BY created_at DESC, id')
        .all(modelId) as Parameters<typeof mapRunRow>[0][])
    : (db.prepare('SELECT * FROM runs ORDER BY created_at DESC, id').all() as Parameters<
        typeof mapRunRow
      >[0][]);
  return rows.map(mapRunRow);
}

export function getIteration(db: Database, runId: string, iteration: number): IterationRecord {
  const row = db
    .prepare('SELECT record_json FROM iterations WHERE run_id = ? AND iteration = ?')
    .get(runId, iteration) as { record_json: string } | undefined;
  if (!row) {
    throw new AppError(
      ERROR_CODES.ITERATION_NOT_FOUND,
      `运行 ${runId} 不存在第 ${iteration} 轮记录`,
    );
  }
  return JSON.parse(row.record_json) as IterationRecord;
}

export function countIterations(db: Database, runId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS cnt FROM iterations WHERE run_id = ?')
    .get(runId) as { cnt: number };
  return row.cnt;
}

export function getIterationsPage(
  db: Database,
  runId: string,
  limit: number,
  offset: number,
): IterationRecord[] {
  const rows = db
    .prepare(
      'SELECT record_json FROM iterations WHERE run_id = ? ORDER BY iteration LIMIT ? OFFSET ?',
    )
    .all(runId, limit, offset) as { record_json: string }[];
  return rows.map((row) => JSON.parse(row.record_json) as IterationRecord);
}
