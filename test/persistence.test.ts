import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { openDatabase } from '../src/db.js';
import { validateModelInput, validateSolveOptions } from '../src/validation.js';
import { createModel, getIteration, getRunOrThrow, saveRun } from '../src/store.js';
import { solve } from '../src/simplex.js';
import { verifyCandidate } from '../src/service.js';

const here = dirname(fileURLToPath(import.meta.url));
const dbFile = join(here, 'restart-test.sqlite');

test('模型冻结后可关闭并在重启时读取历史表与核验结果', () => {
  rmSync(dbFile, { force: true });
  const options = validateSolveOptions({});

  const runId = (() => {
    const db = openDatabase(dbFile);
    const model = createModel(db, validateModelInput({
      name: '持久化', variables: ['x', 'y'], constraints: ['c1', 'c2'],
      A: [[1, 2], [2, 1]], b: [8, 8], c: [3, 4],
    }));
    const result = solve(model, options);
    const run = saveRun(db, model, options, result);
    verifyCandidate(db, model.id, { x: 8 / 3, y: 8 / 3 });
    db.close();
    return run.id;
  })();

  const reopened = openDatabase(dbFile);
  const run = getRunOrThrow(reopened, runId);
  assert.equal(run.status, 'optimal');
  assert.ok(Math.abs((run.objective ?? NaN) - 56 / 3) < 1e-7);
  assert.equal(run.options.algorithmVersion, 'primal-simplex-bland-v1.0.0');
  assert.equal(run.options.rule, 'bland');
  const iteration = getIteration(reopened, runId, 1);
  assert.ok(iteration.entering);
  assert.ok(iteration.leaving);
  assert.ok(iteration.ratioCandidates.length === 2);
  assert.equal(run.result.iterationsRecords.length, run.result.iterations + 1);
  const verificationRow = reopened
    .prepare("SELECT feasible, payload_json FROM verifications WHERE kind = 'external_candidate'")
    .get() as { feasible: number; payload_json: string };
  assert.equal(verificationRow.feasible, 1);
  const payload = JSON.parse(verificationRow.payload_json) as { matchesOptimum: boolean | null };
  assert.equal(payload.matchesOptimum, true);
  reopened.close();

  rmSync(dbFile, { force: true });
  rmSync(`${dbFile}-wal`, { force: true });
  rmSync(`${dbFile}-shm`, { force: true });
});
