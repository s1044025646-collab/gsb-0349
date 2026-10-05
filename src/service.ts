/** 业务逻辑：求解、核验外部候选点、目标版本比较、导出。API 与 CLI 共用。 */

import { Store, StoredModel, StoredRun } from "./db";
import { solvePrimalSimplex, SolveOptions } from "./simplex";
import { ApiError, validateBudget, validateModel } from "./validate";
import { crosscheck2D } from "./crosscheck";

export class Service {
  constructor(public store: Store) {}

  createModel(input: unknown): StoredModel {
    return this.store.createModel(validateModel(input));
  }

  validateOnly(input: unknown): { ok: true; model: unknown } {
    return { ok: true, model: validateModel(input) };
  }

  mustModel(id: number): StoredModel {
    const m = this.store.getModel(id);
    if (!m) throw new ApiError("NOT_FOUND", `模型 ${id} 不存在`, 404);
    return m;
  }

  mustRun(id: number): StoredRun {
    const r = this.store.getRun(id);
    if (!r) throw new ApiError("NOT_FOUND", `运行 ${id} 不存在`, 404);
    return r;
  }

  solve(
    modelId: number,
    rawOpts: { tolerance?: unknown; maxIterations?: unknown; c?: unknown } = {}
  ): { run: StoredRun; model: StoredModel; crosscheck: unknown } {
    const model = this.mustModel(modelId);
    const budget = validateBudget(rawOpts);
    let c = model.c;
    let override: number[] | null = null;
    if (rawOpts.c !== undefined) {
      if (!Array.isArray(rawOpts.c) || rawOpts.c.length !== model.c.length)
        throw new ApiError("DIM_MISMATCH", "目标版本 c 的长度必须与模型变量数一致");
      c = rawOpts.c.map((v: unknown, j: number) => {
        if (typeof v !== "number" || !Number.isFinite(v))
          throw new ApiError("NON_FINITE", `c[${j}] 非有限`);
        return v as number;
      });
      override = c;
    }
    const opts: SolveOptions = {
      tolerance: budget.tolerance,
      maxIterations: budget.maxIterations,
    };
    const result = solvePrimalSimplex(
      c,
      model.A,
      model.b,
      model.varNames,
      model.constraintNames,
      opts
    );
    const run = this.store.saveRun(modelId, result, {
      ...budget,
      objectiveOverride: override,
    });
    const crosscheck =
      result.status === "optimal"
        ? crosscheck2D(c, model.A, model.b, result.objective)
        : { applicable: false, message: "非最优状态，不做交点枚举核对" };
    return { run, model, crosscheck };
  }

  /** 核验外部候选点：代回原始 Ax <= b 检查可行性并直接求 c·x */
  verifyCandidate(runId: number, xRaw: unknown): any {
    const run = this.mustRun(runId);
    const model = this.mustModel(run.modelId);
    if (!Array.isArray(xRaw) || xRaw.length !== model.c.length)
      throw new ApiError("BAD_CANDIDATE", `候选点必须是长度 ${model.c.length} 的数组`);
    const x = xRaw.map((v: unknown, j: number) => {
      if (typeof v !== "number" || !Number.isFinite(v))
        throw new ApiError("BAD_CANDIDATE", `x[${j}] 非有限`);
      return v as number;
    });
    const c = run.objectiveOverride ?? model.c;
    const residuals = model.A.map((row, i) => {
      let ax = 0;
      for (let j = 0; j < x.length; j++) ax += row[j] * x[j];
      return {
        constraint: model.constraintNames[i],
        lhs: ax,
        rhs: model.b[i],
        violation: ax - model.b[i],
      };
    });
    const nonNegViolations = x
      .map((v, j) => ({ variable: model.varNames[j], value: v }))
      .filter((e) => e.value < -run.tolerance);
    const feasible =
      residuals.every((r) => r.violation <= run.tolerance) &&
      nonNegViolations.length === 0;
    const objective = c.reduce((s, v, j) => s + v * x[j], 0);
    return {
      feasible,
      objective,
      residuals,
      nonNegViolations,
      runStatus: run.status,
      runObjective: run.result.objective ?? null,
      isOptimal:
        feasible &&
        run.result.objective !== undefined &&
        Math.abs(objective - run.result.objective) <= 1e-6,
    };
  }

  /** 比较目标版本：用新 c 在同一模型上产生新运行，旧运行保持不变 */
  compareObjectives(modelId: number, cRaw: unknown): any {
    const model = this.mustModel(modelId);
    const base = this.solve(modelId, {});
    const alt = this.solve(modelId, { c: cRaw });
    return {
      modelId,
      original: {
        c: model.c,
        runId: base.run.id,
        status: base.run.status,
        objective: base.run.result.objective ?? null,
      },
      alternate: {
        c: cRaw,
        runId: alt.run.id,
        status: alt.run.status,
        objective: alt.run.result.objective ?? null,
      },
      note: "两个目标版本各自产生独立运行；旧运行与旧最优点仍按原模型展示。",
    };
  }

  exportRun(runId: number): any {
    const run = this.mustRun(runId);
    const model = this.mustModel(run.modelId);
    return {
      exportedAt: new Date().toISOString(),
      algorithmVersion: run.algorithmVersion,
      selectionRule: run.selectionRule,
      tolerance: run.tolerance,
      maxIterations: run.maxIterations,
      model,
      run: {
        id: run.id,
        status: run.status,
        objectiveOverride: run.objectiveOverride,
        result: run.result,
        createdAt: run.createdAt,
      },
    };
  }
}
