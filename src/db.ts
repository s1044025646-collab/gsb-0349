import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(filePath: string): DatabaseSync {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL REFERENCES models(id),
      model_fingerprint TEXT NOT NULL,
      rule TEXT NOT NULL,
      tolerance_json TEXT NOT NULL,
      max_iterations INTEGER NOT NULL,
      algorithm_version TEXT NOT NULL,
      status TEXT NOT NULL,
      objective REAL,
      result_summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS iterations (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      iteration INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (run_id, iteration)
    );
    CREATE TABLE IF NOT EXISTS verifications (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL REFERENCES models(id),
      run_id TEXT REFERENCES runs(id),
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      feasible INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_model ON runs(model_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_iterations_run ON iterations(run_id, iteration);
  `);
  return db;
}

export type Database = ReturnType<typeof openDatabase>;
