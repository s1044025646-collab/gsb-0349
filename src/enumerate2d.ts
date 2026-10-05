import type { LPModel } from './types.js';

export interface EnumeratedPoint {
  x: number;
  y: number;
  source: string;
  feasible: boolean;
  objective: number;
  violations: string[];
}

// 独立核验：枚举坐标轴与约束边界（含坐标轴交点、两条约束线交点），筛选可行点后取目标最大值。
// 只适用于两个原变量的教学模型，完全不使用单纯形表或目标行。
export function enumerate2d(model: LPModel, tolerance = 1e-7): {
  supported: boolean;
  points: EnumeratedPoint[];
  best: EnumeratedPoint[] | null;
  bounded: boolean;
  reason?: string;
} {
  if (model.variables.length !== 2) {
    return { supported: false, points: [], best: null, bounded: false, reason: '枚举核验仅支持恰好两个变量的模型' };
  }

  const m = model.constraints.length;
  const rawPoints: { x: number; y: number; source: string }[] = [];
  rawPoints.push({ x: 0, y: 0, source: '原点（坐标轴交点）' });

  // 每条约束边界与 x 轴 (y=0)、y 轴 (x=0) 的交点
  for (let i = 0; i < m; i += 1) {
    const a1 = model.A[i][0];
    const a2 = model.A[i][1];
    const rhs = model.b[i];
    if (Math.abs(a1) > tolerance) {
      rawPoints.push({ x: rhs / a1, y: 0, source: `约束「${model.constraints[i]}」与 x 轴交点` });
    }
    if (Math.abs(a2) > tolerance) {
      rawPoints.push({ x: 0, y: rhs / a2, source: `约束「${model.constraints[i]}」与 y 轴交点` });
    }
  }

  // 每两条约束边界的交点
  for (let i = 0; i < m; i += 1) {
    for (let k = i + 1; k < m; k += 1) {
      const a11 = model.A[i][0];
      const a12 = model.A[i][1];
      const b1 = model.b[i];
      const a21 = model.A[k][0];
      const a22 = model.A[k][1];
      const b2 = model.b[k];
      const det = a11 * a22 - a12 * a21;
      if (Math.abs(det) <= tolerance) continue; // 平行线无唯一交点
      const x = (b1 * a22 - a12 * b2) / det;
      const y = (a11 * b2 - b1 * a21) / det;
      rawPoints.push({ x, y, source: `约束「${model.constraints[i]}」与「${model.constraints[k]}」交点` });
    }
  }

  const evaluate = (p: { x: number; y: number }): { feasible: boolean; violations: string[] } => {
    const violations: string[] = [];
    if (p.x < -tolerance) violations.push('x 为负');
    if (p.y < -tolerance) violations.push('y 为负');
    for (let i = 0; i < m; i += 1) {
      const lhs = model.A[i][0] * p.x + model.A[i][1] * p.y;
      if (lhs > model.b[i] + tolerance) {
        violations.push(`违反约束「${model.constraints[i]}」：${lhs} > ${model.b[i]}`);
      }
    }
    return { feasible: violations.length === 0, violations };
  };

  const points: EnumeratedPoint[] = rawPoints.map((p) => {
    const result = evaluate(p);
    return {
      x: p.x,
      y: p.y,
      source: p.source,
      feasible: result.feasible,
      objective: model.c[0] * p.x + model.c[1] * p.y,
      violations: result.violations,
    };
  });

  const feasiblePoints = points.filter((p) => p.feasible && Number.isFinite(p.objective));
  if (feasiblePoints.length === 0) {
    return { supported: true, points, best: null, bounded: true, reason: '未枚举到可行点（零起点模型理论上不应发生）' };
  }

  // 有界性独立判断：沿目标上升方向 d = c，若对某 t→∞ 所有约束 A(x+t d) ≤ b 仍成立，则无界
  let blocked = false;
  for (let i = 0; i < m; i += 1) {
    const growth = model.A[i][0] * model.c[0] + model.A[i][1] * model.c[1];
    if (growth > tolerance) {
      blocked = true;
      break;
    }
  }

  if (!blocked && (model.c[0] > tolerance || model.c[1] > tolerance)) {
    return { supported: true, points, best: null, bounded: false, reason: '沿目标系数方向移动不受约束阻挡，可行域无界' };
  }

  const bestValue = Math.max(...feasiblePoints.map((p) => p.objective));
  const best = feasiblePoints.filter((p) => Math.abs(p.objective - bestValue) <= tolerance * Math.max(1, Math.abs(bestValue)));
  return { supported: true, points, best, bounded: true };
}
