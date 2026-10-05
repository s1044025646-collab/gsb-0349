/**
 * SQLite 持久化（Node 内置 node:sqlite，无原生依赖）。
 * 冻结模型、变量顺序、选择规则、容差与算法版本；
 * 运行结果 + 每步换基记录 + 每张表在单个事务中原子写入。
 */

import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ALGORITHM_VERSION,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TOLERANCE,
  SolveResult,
} from "./simplex";
import { ModelInput } from "./validate";

export const DATA_DIR = path.join(process.cwd(), "data");
export const DB_PATH = path.join(DATA_DIR, "simplex.db");

export interface StoredModel extends Required<ModelInput> {
  id: number;
  createdAt: string;
}

export interface StoredRun {
  id: number;
  modelId: number;
  status: string;
  tolerance: number;
  maxIterations: number;
  algorithmVersion: string;
  selectionRule: string;
  objectiveOverride: number[] | null;
  result: SolveResult;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string = DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id INTEGER NOT NULL REFERENCES models(id),
        status TEXT NOT NULL,
        tolerance REAL NOT NULL,
        max_iterations INTEGER NOT NULL,
        algorithm_version TEXT NOT NULL,
        selection_rule TEXT NOT NULL,
        objective_override TEXT,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS steps (
        run_id INTEGER NOT NULL REFERENCES runs(id),
        iteration INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (run_id, iteration)
      );
      CREATE TABLE IF NOT EXISTS tableaus (
        run_id INTEGER NOT NULL REFERENCES runs(id),
        iteration INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (run_id, iteration)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createModel(model: Required<ModelInput>): StoredModel {
    const stmt = this.db.prepare("INSERT INTO models (name, data) VALUES (?, ?)");
    const info = stmt.run(model.name, JSON.stringify(model));
    return this.getModel(Number(info.lastInsertRowid))!;
  }

  getModel(id: number): StoredModel | null {
    const row = this.db
      .prepare("SELECT * FROM models WHERE id = ?")
      .get(id) as any;
    if (!row) return null;
    const data = JSON.parse(row.data);
    return { id: row.id, createdAt: row.created_at, ...data };
  }

  listModels(): StoredModel[] {
    const rows = this.db.prepare("SELECT * FROM models ORDER BY id").all() as any[];
    return rows.map((row) => ({ id: row.id, createdAt: row.created_at, ...JSON.parse(row.data) }));
  }

  /** 原子保存一次运行：run + steps + tableaus 在同一事务中提交 */
  saveRun(
    modelId: number,
    result: SolveResult,
    opts: {
      tolerance?: number;
      maxIterations?: number;
      objectiveOverride?: number[] | null;
    } = {}
  ): StoredRun {
    const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
    const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const insertRun = this.db.prepare(
      `INSERT INTO runs (model_id, status, tolerance, max_iterations, algorithm_version, selection_rule, objective_override, result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertStep = this.db.prepare(
      "INSERT INTO steps (run_id, iteration, data) VALUES (?, ?, ?)"
    );
    const insertTab = this.db.prepare(
      "INSERT INTO tableaus (run_id, iteration, data) VALUES (?, ?, ?)"
    );
    this.db.exec("BEGIN");
    try {
      const info = insertRun.run(
        modelId,
        result.status,
        tolerance,
        maxIterations,
        ALGORITHM_VERSION,
        "bland-smallest-index",
        opts.objectiveOverride ? JSON.stringify(opts.objectiveOverride) : null,
        JSON.stringify({ ...result, steps: undefined, tableaus: undefined })
      );
      const runId = Number(info.lastInsertRowid);
      for (const s of result.steps) insertStep.run(runId, s.iteration, JSON.stringify(s));
      for (const t of result.tableaus) insertTab.run(runId, t.iteration, JSON.stringify(t));
      this.db.exec("COMMIT");
      return this.getRun(runId)!;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getRun(id: number): StoredRun | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as any;
    if (!row) return null;
    return this.rowToRun(row);
  }

  listRuns(modelId?: number): StoredRun[] {
    const rows = (
      modelId === undefined
        ? this.db.prepare("SELECT * FROM runs ORDER BY id").all()
        : this.db.prepare("SELECT * FROM runs WHERE model_id = ? ORDER BY id").all(modelId)
    ) as any[];
    return rows.map((r) => this.rowToRun(r));
  }

  private rowToRun(row: any): StoredRun {
    const result = JSON.parse(row.result) as SolveResult;
    result.steps = this.getSteps(row.id, 0, Number.MAX_SAFE_INTEGER).steps;
    result.tableaus = this.getAllTableaus(row.id);
    return {
      id: row.id,
      modelId: row.model_id,
      status: row.status,
      tolerance: row.tolerance,
      maxIterations: row.max_iterations,
      algorithmVersion: row.algorithm_version,
      selectionRule: row.selection_rule,
      objectiveOverride: row.objective_override ? JSON.parse(row.objective_override) : null,
      result,
      createdAt: row.created_at,
    };
  }

  /** 分页读取换基步骤；分页只影响展示，不影响算法是否完成 */
  getSteps(
    runId: number,
    offset: number,
    limit: number
  ): { steps: any[]; total: number } {
    const total = (
      this.db.prepare("SELECT COUNT(*) AS c FROM steps WHERE run_id = ?").get(runId) as any
    ).c as number;
    const rows = this.db
      .prepare("SELECT data FROM steps WHERE run_id = ? ORDER BY iteration LIMIT ? OFFSET ?")
      .all(runId, limit, offset) as any[];
    return { steps: rows.map((r) => JSON.parse(r.data)), total };
  }

  getTableau(runId: number, iteration: number): any | null {
    const row = this.db
      .prepare("SELECT data FROM tableaus WHERE run_id = ? AND iteration = ?")
      .get(runId, iteration) as any;
    return row ? JSON.parse(row.data) : null;
  }

  private getAllTableaus(runId: number): any[] {
    const rows = this.db
      .prepare("SELECT data FROM tableaus WHERE run_id = ? ORDER BY iteration")
      .all(runId) as any[];
    return rows.map((r) => JSON.parse(r.data));
  }
}
