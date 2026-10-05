/**
 * 独立交叉核对：对二维有界模型，枚举所有约束边界直线与坐标轴的交点，
 * 筛选可行点并直接计算 c·x，取最大者与单纯形结果比对。
 * 不复用求解器的目标行，属于独立验证。
 */

export interface CrosscheckResult {
  applicable: boolean;
  bestObjective?: number;
  bestPoint?: number[];
  feasibleVertices?: number;
  matchesSolver?: boolean;
  message: string;
}

export function crosscheck2D(
  c: number[],
  A: number[][],
  b: number[],
  solverObjective: number | undefined,
  tol = 1e-7
): CrosscheckResult {
  if (c.length !== 2) {
    return { applicable: false, message: "仅对二维模型做交点枚举核对" };
  }
  // 边界直线集合：每条约束 a1 x + a2 y = b，以及 x=0、y=0
  const lines: [number, number, number][] = [
    ...A.map((row, i): [number, number, number] => [row[0], row[1], b[i]]),
    [1, 0, 0],
    [0, 1, 0],
  ];
  const pts: number[][] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const [a1, b1, d1] = lines[i];
      const [a2, b2, d2] = lines[j];
      const det = a1 * b2 - a2 * b1;
      if (Math.abs(det) < 1e-12) continue;
      const x = (d1 * b2 - d2 * b1) / det;
      const y = (a1 * d2 - a2 * d1) / det;
      pts.push([x, y]);
    }
  }
  const feasible = pts.filter(([x, y]) => {
    if (x < -tol || y < -tol) return false;
    return A.every((row, i) => row[0] * x + row[1] * y <= b[i] + tol);
  });
  if (feasible.length === 0) {
    return { applicable: true, feasibleVertices: 0, message: "枚举未发现可行交点" };
  }
  let best = -Infinity;
  let bestPt: number[] = feasible[0];
  for (const p of feasible) {
    const obj = c[0] * p[0] + c[1] * p[1];
    if (obj > best) {
      best = obj;
      bestPt = p;
    }
  }
  const matches =
    solverObjective !== undefined && Math.abs(best - solverObjective) <= 1e-6;
  return {
    applicable: true,
    bestObjective: best,
    bestPoint: bestPt,
    feasibleVertices: feasible.length,
    matchesSolver: matches,
    message: matches
      ? `枚举 ${feasible.length} 个可行交点，最大目标 ${best} 与单纯形结果一致`
      : `枚举最大目标 ${best} 与单纯形结果 ${solverObjective} 不一致（或求解器未给出最优）`,
  };
}
