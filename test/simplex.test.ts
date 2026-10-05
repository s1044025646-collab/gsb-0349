import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateModelInput, validateSolveOptions } from '../src/validation.js';
import { solve, checkFeasibility } from '../src/simplex.js';
import { enumerate2d } from '../src/enumerate2d.js';
import { AppError, ERROR_CODES } from '../src/constants.js';
import type { ModelInput } from '../src/types.js';

const options = validateSolveOptions({});

function buildModel(input: ModelInput) {
  return {
    id: 'm',
    name: input.name ?? '测试',
    variables: input.variables,
    constraints: input.constraints,
    A: input.A,
    b: input.b,
    c: input.c,
    createdAt: new Date(0).toISOString(),
  };
}

test('二维有界问题得到 (8/3,8/3) 与 56/3', () => {
  const model = buildModel(validateModelInput({
    variables: ['x', 'y'], constraints: ['c1', 'c2'],
    A: [[1, 2], [2, 1]], b: [8, 8], c: [3, 4],
  }));
  const result = solve(model, options);
  assert.equal(result.status, 'optimal');
  assert.ok(Math.abs((result.objective ?? NaN) - 56 / 3) < 1e-7);
  assert.ok(Math.abs((result.point?.x ?? NaN) - 8 / 3) < 1e-7);
  assert.ok(Math.abs((result.point?.y ?? NaN) - 8 / 3) < 1e-7);
  assert.equal(result.feasibility?.feasible, true);

  const enumeration = enumerate2d(model);
  assert.equal(enumeration.bounded, true);
  assert.ok(Math.abs((enumeration.best?.[0]?.objective ?? NaN) - 56 / 3) < 1e-7);
});

test('目标全非正时零点最优', () => {
  const model = buildModel(validateModelInput({
    variables: ['x', 'y'], constraints: ['c1'], A: [[1, 1]], b: [5], c: [-1, -1],
  }));
  const result = solve(model, options);
  assert.equal(result.status, 'optimal');
  assert.equal(result.objective, 0);
  assert.equal(result.point?.x, 0);
  assert.equal(result.point?.y, 0);
  assert.equal(result.iterations, 0);
});

test('冗余约束不改变最优值', () => {
  const model = buildModel(validateModelInput({
    variables: ['x', 'y'], constraints: ['紧', '冗余'],
    A: [[1, 1], [2, 2]], b: [4, 8], c: [2, 1],
  }));
  const result = solve(model, options);
  assert.equal(result.status, 'optimal');
  assert.ok(Math.abs((result.objective ?? NaN) - 8) < 1e-7);
});

test('退化比值平局可解且记录退化换基', () => {
  const model = buildModel(validateModelInput({
    variables: ['x', 'y'], constraints: ['零右端', 'A', 'B'],
    A: [[1, 0], [1, 1], [-1, 1]], b: [0, 2, 1], c: [1, 1],
  }));
  const result = solve(model, options);
  assert.equal(result.status, 'optimal');
  assert.ok(result.iterationsRecords.some((r) => r.degenerate));
  // 第一次入基 x 时，零右端行比值为 0 必须被选中（Bland 对平局按基列索引）
  const first = result.iterationsRecords.find((r) => r.iteration === 1);
  assert.equal(first?.ratioCandidates.find((c) => c.leaving)?.constraint, '零右端');
  assert.equal(first?.degenerate, true);
  assert.equal(first?.objectiveBefore, first?.objectiveAfter);
});

test('无界方向报告入基列且不除零', () => {
  const model = buildModel(validateModelInput({
    variables: ['x', 'y'], constraints: ['c1'], A: [[1, -1]], b: [1], c: [1, 1],
  }));
  const result = solve(model, options);
  assert.equal(result.status, 'unbounded');
  assert.equal(result.point, null);
  assert.equal(result.objective, null);
  assert.ok(result.unboundedDirection?.reason.includes('不'));
  assert.equal(enumerate2d(model).bounded, false);
});

test('零右端合法（不标为不可行）', () => {
  const model = buildModel(validateModelInput({
    variables: ['x'], constraints: ['c1'], A: [[1]], b: [0], c: [1],
  }));
  const result = solve(model, options);
  assert.equal(result.status, 'optimal');
  assert.equal(result.objective, 0);
});

test('非法负右端被拒绝而不是标为数学上不可行', () => {
  assert.throws(
    () => validateModelInput({ variables: ['x'], constraints: ['c'], A: [[1]], b: [-1], c: [1] }),
    (error: unknown) => error instanceof AppError && error.code === ERROR_CODES.VALIDATION_NEGATIVE_RHS,
  );
});

test('维度不一致、重名、非有限系数各自报错', () => {
  assert.throws(
    () => validateModelInput({ variables: ['x', 'y'], constraints: ['c'], A: [[1]], b: [1], c: [1, 2] }),
    (e: unknown) => e instanceof AppError && e.code === ERROR_CODES.VALIDATION_DIMENSION,
  );
  assert.throws(
    () => validateModelInput({ variables: ['x', 'x'], constraints: ['c'], A: [[1, 1]], b: [1], c: [1, 2] }),
    (e: unknown) => e instanceof AppError && e.code === ERROR_CODES.VALIDATION_DUPLICATE_NAME,
  );
  assert.throws(
    () => validateModelInput({ variables: ['x'], constraints: ['c'], A: [[Number.POSITIVE_INFINITY]], b: [1], c: [1] }),
    (e: unknown) => e instanceof AppError && e.code === ERROR_CODES.VALIDATION_NON_FINITE,
  );
});

test('非法迭代预算被拒绝', () => {
  assert.throws(() => validateSolveOptions({ maxIterations: 0 }), AppError);
  assert.throws(() => validateSolveOptions({ maxIterations: 1.5 }), AppError);
  assert.throws(() => validateSolveOptions({ maxIterations: 10 ** 9 }), AppError);
  assert.throws(() => validateSolveOptions({ rule: 'dantzig' }), AppError);
});

test('低迭代预算返回 iteration_limit 而不冒充最优', () => {
  const model = buildModel(validateModelInput({
    variables: ['x', 'y'], constraints: ['c1', 'c2'],
    A: [[1, 2], [2, 1]], b: [8, 8], c: [3, 4],
  }));
  const result = solve(model, validateSolveOptions({ maxIterations: 1 }));
  assert.equal(result.status, 'iteration_limit');
  assert.equal(result.feasibility?.feasible, true);
  assert.ok(result.iterations === 1);
});

test('坏外部候选点被独立残差检验识别', () => {
  const model = buildModel(validateModelInput({
    variables: ['x', 'y'], constraints: ['c1'], A: [[1, 1]], b: [1], c: [1, 1],
  }));
  const violating = checkFeasibility(model, [2, 2], 1e-7);
  assert.equal(violating.feasible, false);
  assert.ok(violating.maxViolation > 0);
  const negative = checkFeasibility(model, [-1, 0], 1e-7);
  assert.equal(negative.feasible, false);
  const feasible = checkFeasibility(model, [0.5, 0.5], 1e-7);
  assert.equal(feasible.feasible, true);
  assert.equal(feasible.objective, 1);
});

test('重复求解确定性一致', () => {
  const model = buildModel(validateModelInput({
    variables: ['x', 'y'], constraints: ['c1', 'c2'],
    A: [[1, 2], [2, 1]], b: [8, 8], c: [3, 4],
  }));
  const a = solve(model, options);
  const b = solve(model, options);
  assert.deepEqual(a.finalTableau, b.finalTableau);
  assert.deepEqual(a.finalBasis, b.finalBasis);
  assert.equal(a.objective, b.objective);
});

test('解代回原约束与目标直接求和核对', () => {
  const model = buildModel(validateModelInput({
    variables: ['x', 'y'], constraints: ['c1', 'c2'],
    A: [[1.5, -0.5], [0, 2]], b: [3, 4], c: [2, 3],
  }));
  const result = solve(model, options);
  assert.equal(result.status, 'optimal');
  const point = [result.point!.x, result.point!.y];
  const check = checkFeasibility(model, point, 1e-7);
  assert.equal(check.feasible, true);
  const directObjective = model.c[0] * point[0] + model.c[1] * point[1];
  assert.ok(Math.abs(directObjective - (result.objective ?? NaN)) < 1e-9);
});
