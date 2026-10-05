import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { openDatabase } from './db.js';
import { validateModelInput, validateSolveOptions } from './validation.js';
import { createModel, saveRun } from './store.js';
import { solve } from './simplex.js';
import { enumerate2d } from './enumerate2d.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..');
const db = openDatabase(process.env.LP_DB_PATH ?? join(projectRoot, 'data', 'demo.sqlite'));

const scenarios: { title: string; input: Parameters<typeof validateModelInput>[0]; iterations?: number }[] = [
  {
    title: '1) 二维有界问题（可手算：max 3x+4y, x+2y≤8, 2x+y≤8, x,y≥0；最优点 (8/3,8/3)，z=56/3）',
    input: {
      name: '二维有界',
      variables: ['x', 'y'],
      constraints: ['c1', 'c2'],
      A: [[1, 2], [2, 1]],
      b: [8, 8],
      c: [3, 4],
    },
  },
  {
    title: '2) 目标系数全非正：max -x-y，零点即最优，目标 0',
    input: {
      name: '零点最优',
      variables: ['x', 'y'],
      constraints: ['c1'],
      A: [[1, 1]],
      b: [5],
      c: [-1, -1],
    },
  },
  {
    title: '3) 冗余约束：x+y≤4 之外再加 2x+2y≤8（同一支撑超平面）',
    input: {
      name: '冗余约束',
      variables: ['x', 'y'],
      constraints: ['紧约束', '冗余约束'],
      A: [[1, 1], [2, 2]],
      b: [4, 8],
      c: [2, 1],
    },
  },
  {
    title: '4) 退化比值平局：零右端约束在原点造成 0/系数 的平局（Bland 按基列索引确定离基）',
    input: {
      name: '退化平局',
      variables: ['x', 'y'],
      constraints: ['零右端', '约束A', '约束B'],
      A: [[1, 0], [1, 1], [-1, 1]],
      b: [0, 2, 1],
      c: [1, 1],
    },
  },
  {
    title: '5) 明显无界：max x+y，仅约束 x-y≤1，沿 (1,1) 方向无限增长',
    input: {
      name: '无界方向',
      variables: ['x', 'y'],
      constraints: ['c1'],
      A: [[1, -1]],
      b: [1],
      c: [1, 1],
    },
  },
  {
    title: '6) 低迭代预算：同一有界问题只允许 1 次枢轴，状态应为 iteration_limit 而非最优',
    input: {
      name: '低预算',
      variables: ['x', 'y'],
      constraints: ['c1', 'c2'],
      A: [[1, 2], [2, 1]],
      b: [8, 8],
      c: [3, 4],
    },
    iterations: 1,
  },
];

const options = validateSolveOptions({});

for (const scenario of scenarios) {
  console.log('='.repeat(100));
  console.log(scenario.title);
  const input = validateModelInput(scenario.input);
  const model = createModel(db, input);
  const result = solve(model, scenario.iterations ? { ...options, maxIterations: scenario.iterations } : options);
  saveRun(db, model, scenario.iterations ? { ...options, maxIterations: scenario.iterations } : options, result);
  console.log(`状态：${result.status}，枢轴次数：${result.iterations}，停止原因：${result.stoppingReason}`);
  if (result.objective !== null && result.point) {
    const p = result.point;
    console.log(
      `解：x=${p[model.variables[0]]}, y=${p[model.variables[1]]}，目标 c·x=${result.objective}，可行=${result.feasibility?.feasible}，最大违例=${result.feasibility?.maxViolation}`,
    );
    if (result.alternateOptimaPossible) console.log('注意：可能存在多个最优点，仅返回其中一个。');
  }
  if (result.unboundedDirection) {
    console.log(`无界：入基列「${result.unboundedDirection.enteringVariable}」——${result.unboundedDirection.reason}`);
  }
  const degeneratePivots = result.iterationsRecords.filter((record) => record.degenerate);
  if (degeneratePivots.length > 0) {
    console.log(`发生 ${degeneratePivots.length} 次退化换基（最小比值为 0，目标暂时不变）`);
  }
  if (model.variables.length === 2) {
    const enumeration = enumerate2d(model);
    if (enumeration.bounded && enumeration.best) {
      const bestValue = enumeration.best[0].objective;
      if (result.status === 'optimal') {
        const match = result.objective !== null && Math.abs(result.objective - bestValue) < 1e-7;
        console.log(`独立枚举核验：枚举 ${enumeration.points.length} 个交点，可行中最优 z=${bestValue}，与单纯形${match ? '一致 ✓' : '不一致 ✗'}`);
      } else {
        console.log(`独立枚举核验：枚举 ${enumeration.points.length} 个交点，真正最优 z=${bestValue}；当前状态 ${result.status} 下目标 ${result.objective} 小于最优，符合“未完成不冒充最优” ✓`);
      }
    } else if (!enumeration.bounded) {
      console.log(`独立枚举核验：可行域无界（${enumeration.reason}），与单纯形${result.status === 'unbounded' ? '一致 ✓' : '不一致 ✗'}`);
    }
  }
}

console.log('='.repeat(100));
console.log('演示完成。所有结果均落盘到 SQLite（使用 :memory: 时可用 LP_DB_PATH 指定 data/lp.sqlite 持久化）。');
