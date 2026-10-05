import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { solvePrimalSimplex } from "../src/simplex";
import { crosscheck2D } from "../src/crosscheck";
import { validateModel, ApiError } from "../src/validate";
import { Store } from "../src/db";
import { Service } from "../src/service";

const bounded = {
  c: [3, 2],
  A: [[1, 1], [2, 1]],
  b: [4, 5],
  varNames: ["x", "y"],
  constraintNames: ["c1", "c2"],
};

test("二维有界：最优 (1,3)，目标 9，独立枚举核对一致", () => {
  const r = solvePrimalSimplex(bounded.c, bounded.A, bounded.b, bounded.varNames, bounded.constraintNames);
  assert.equal(r.status, "optimal");
  assert.ok(Math.abs(r.objective! - 9) < 1e-9);
  assert.ok(Math.abs(r.x![0] - 1) < 1e-9 && Math.abs(r.x![1] - 3) < 1e-9);
  for (let i = 0; i < bounded.A.length; i++) {
    const ax = bounded.A[i][0] * r.x![0] + bounded.A[i][1] * r.x![1];
    assert.ok(ax <= bounded.b[i] + 1e-9);
  }
  assert.ok(Math.abs(3 * r.x![0] + 2 * r.x![1] - r.objective!) < 1e-9);
  const cc = crosscheck2D(bounded.c, bounded.A, bounded.b, r.objective);
  assert.equal(cc.matchesSolver, true);
});

test("目标全非正：零点最优，0 次迭代", () => {
  const r = solvePrimalSimplex([-1, -1], [[1, 1]], [4], ["x", "y"], ["c1"]);
  assert.equal(r.status, "optimal");
  assert.equal(r.iterations, 0);
  assert.deepEqual(r.x, [0, 0]);
  assert.equal(r.objective, 0);
});

test("冗余约束不影响最优值", () => {
  const r = solvePrimalSimplex([3, 2], [[1, 1], [2, 1], [1, 1]], [4, 5, 10], ["x", "y"], ["c1", "c2", "c3"]);
  assert.equal(r.status, "optimal");
  assert.ok(Math.abs(r.objective! - 9) < 1e-9);
});

test("退化比值平局：Bland 确定性打破，记录目标不变的换基步", () => {
  // x1+x2<=0, x1<=0, x2<=2：可行域只有原点，换基时比值 0 平局，目标保持 0
  const r = solvePrimalSimplex([1, 1], [[1, 1], [1, 0], [0, 1]], [0, 0, 2], ["x", "y"], ["c1", "c2", "c3"]);
  assert.equal(r.status, "optimal");
  assert.ok(Math.abs(r.objective! - 0) < 1e-9);
  assert.ok(r.steps.some((s) => s.degenerate), "应至少有一步退化换基（目标不变）");
  const deg = r.steps.find((s) => s.degenerate)!;
  assert.equal(deg.objectiveBefore, deg.objectiveAfter);
  assert.ok(deg.ratios.length >= 2);
});

test("明显无界方向：报告无界并指出入基列", () => {
  const r = solvePrimalSimplex([1, 1], [[-1, 1]], [1], ["x", "y"], ["c1"]);
  assert.equal(r.status, "unbounded");
  assert.equal(r.unboundedColumnName, "x");
  assert.ok(r.message.includes("无界"));
  assert.equal(r.objective, undefined);
});

test("零右端 b=0 合法且原点即最优", () => {
  const r = solvePrimalSimplex([1, 1], [[1, 1]], [0], ["x", "y"], ["c1"]);
  assert.equal(r.status, "optimal");
  assert.equal(r.objective, 0);
});

test("负右端被拒绝为输入错误，而非数学不可行", () => {
  assert.throws(
    () => validateModel({ c: [1], A: [[1]], b: [-2], varNames: ["x"], constraintNames: ["c1"] }),
    (e: unknown) =>
      e instanceof ApiError &&
      e.code === "NEGATIVE_RHS" &&
      e.message.includes("不是") && // 明确说明这不是"数学上不可行"
      e.message.includes("不可行")
  );
});

test("低迭代预算：报告 iteration_limit，不冒充最优", () => {
  const r = solvePrimalSimplex(bounded.c, bounded.A, bounded.b, bounded.varNames, bounded.constraintNames, { maxIterations: 1 });
  assert.equal(r.status, "iteration_limit");
  assert.equal(r.objective, undefined);
});

test("非法输入被拒绝：非有限系数、重名、维度不一致", () => {
  assert.throws(() => validateModel({ c: [NaN], A: [[1]], b: [1], varNames: ["x"], constraintNames: ["c1"] }),
    (e: unknown) => e instanceof ApiError && e.code === "NON_FINITE");
  assert.throws(() => validateModel({ c: [1], A: [[1]], b: [1], varNames: ["x"], constraintNames: ["x"] }),
    (e: unknown) => e instanceof ApiError && e.code === "DUPLICATE_NAME");
  assert.throws(() => validateModel({ c: [1, 2], A: [[1]], b: [1], varNames: ["x", "y"], constraintNames: ["c1"] }),
    (e: unknown) => e instanceof ApiError && e.code === "DIM_MISMATCH");
});

test("重复运行确定性：步骤与结果完全一致", () => {
  const a = solvePrimalSimplex(bounded.c, bounded.A, bounded.b, bounded.varNames, bounded.constraintNames);
  const bRun = solvePrimalSimplex(bounded.c, bounded.A, bounded.b, bounded.varNames, bounded.constraintNames);
  assert.deepEqual(a, bRun);
});

function tempDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "simplex-")), "t.db");
}

test("坏外部候选点被判定不可行，好候选点被确认", () => {
  const svc = new Service(new Store(tempDb()));
  const m = svc.createModel(bounded);
  const { run } = svc.solve(m.id);
  const bad = svc.verifyCandidate(run.id, [10, 10]);
  assert.equal(bad.feasible, false);
  assert.ok(bad.residuals.some((r: any) => r.violation > 0));
  const good = svc.verifyCandidate(run.id, [1, 3]);
  assert.equal(good.feasible, true);
  assert.equal(good.isOptimal, true);
  assert.throws(() => svc.verifyCandidate(run.id, [1]),
    (e: unknown) => e instanceof ApiError && e.code === "BAD_CANDIDATE");
  svc.store.close();
});

test("重启后仍能读取历史运行、表与步骤，结果一致", () => {
  const dbPath = tempDb();
  let svc = new Service(new Store(dbPath));
  const m = svc.createModel(bounded);
  const { run } = svc.solve(m.id);
  svc.store.close();
  svc = new Service(new Store(dbPath));
  const restored = svc.store.getRun(run.id)!;
  assert.equal(restored.status, "optimal");
  assert.ok(Math.abs(restored.result.objective! - 9) < 1e-9);
  assert.equal(restored.result.steps.length, run.result.steps.length);
  const t0 = svc.store.getTableau(run.id, 0);
  assert.ok(t0 && t0.iteration === 0);
  const paged = svc.store.getSteps(run.id, 0, 1);
  assert.equal(paged.total, run.result.steps.length);
  assert.equal(paged.steps.length, 1);
  svc.store.close();
});

test("目标版本比较产生新运行，旧运行保持不变", () => {
  const svc = new Service(new Store(tempDb()));
  const m = svc.createModel(bounded);
  const cmp = svc.compareObjectives(m.id, [1, 5]);
  assert.equal(cmp.original.objective, 9);
  assert.equal(cmp.alternate.objective, 20);
  svc.store.close();
});
