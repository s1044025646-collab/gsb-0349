import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { openDatabase } from './db.js';
import { validateModelInput, validateSolveOptions } from './validation.js';
import { createModel, getIteration, getModelOrThrow, getRunOrThrow } from './store.js';
import { solve } from './simplex.js';
import { saveRun } from './store.js';
import { compareRuns, exportRun, verifyCandidate } from './service.js';
import { enumerate2d } from './enumerate2d.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..');
const db = openDatabase(process.env.LP_DB_PATH ?? join(projectRoot, 'data', 'lp.sqlite'));

function fmt(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  if (Number.isNaN(value)) return '不适用';
  if (!Number.isFinite(value)) return '∞';
  const rounded = Math.abs(value) < 1e-10 ? 0 : value;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function table(headers: string[], rows: (string | number)[][]): string {
  const widths = headers.map((header, i) =>
    Math.min(40, Math.max(header.length, ...rows.map((row) => String(row[i] ?? '').length))),
  );
  const clip = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width));
  const line = (cells: (string | number)[]) => `| ${cells.map((cell, i) => clip(String(cell), widths[i])).join(' | ')} |`;
  const separator = `+-${widths.map((w) => '-'.repeat(w)).join('-+-')}-+`;
  return [separator, line(headers), separator, ...rows.map((row) => line(row)), separator].join('\n');
}

function printModel(model: ReturnType<typeof getModelOrThrow>): void {
  console.log(`模型 ${model.id}（${model.name}）`);
  const rows = model.constraints.map((name, i) => [
    name,
    model.A[i].map((a, j) => `${fmt(a)}·${model.variables[j]}`).join(' + '),
    `≤ ${fmt(model.b[i])}`,
  ]);
  console.log(table(['约束', '左侧', '右端'], rows));
  console.log(`目标：max z = ${model.c.map((c, j) => `${fmt(c)}·${model.variables[j]}`).join(' + ')}`);
}

function printRun(run: ReturnType<typeof getRunOrThrow>): void {
  const result = run.result;
  console.log(`\n运行 ${run.id}`);
  console.log(`状态：${result.status}　枢轴次数：${result.iterations}　规则：${run.options.rule}　版本：${run.options.algorithmVersion}`);
  console.log(`停止原因：${result.stoppingReason}`);

  if (result.objective !== null) console.log(`目标值（独立按 c·x 直接求和）：${fmt(result.objective)}`);
  if (result.point) {
    console.log('当前最优/当前可行点：');
    console.log(table(['原变量', '取值'], Object.entries(result.point).map(([k, v]) => [k, fmt(v)])));
    console.log('松弛量：');
    console.log(table(['松弛变量', '取值'], Object.entries(result.slacks ?? {}).map(([k, v]) => [k, fmt(v)])));
  }
  if (result.feasibility) {
    console.log('独立可行残差核对（Ax 与 b）：');
    console.log(
      table(
        ['约束', 'Ax', 'b', '残差 b-Ax', '结果'],
        result.feasibility.residuals.map((r) => [r.constraint, fmt(r.lhs), fmt(r.rhs), fmt(r.slack), r.violated ? '违反' : '满足']),
      ),
    );
    console.log(`最大违例量：${fmt(result.feasibility.maxViolation)}　可行：${result.feasibility.feasible ? '是' : '否'}`);
  }
  if (result.alternateOptimaPossible) {
    console.log('注意：存在非基变量检验数为 0，可能有多个最优点；此处仅返回其中一个。');
  }
  if (result.unboundedDirection) {
    console.log(`无界方向入基列：${result.unboundedDirection.enteringVariable}（第 ${result.unboundedDirection.column + 1} 列）`);
    console.log(`依据：${result.unboundedDirection.reason}`);
  }

  const pivotRows = result.iterationsRecords
    .filter((record) => record.entering)
    .map((record) => [
      record.iteration,
      record.entering?.variable ?? '',
      record.leaving?.variable ?? '',
      fmt(record.pivotElement),
      fmt(record.objectiveBefore),
      fmt(record.objectiveAfter),
      record.degenerate ? '退化（目标不变）' : '',
    ]);
  if (pivotRows.length > 0) {
    console.log('\n换基与目标变化表：');
    console.log(table(['轮次', '入基', '离基', '枢轴元', '换基前z', '换基后z', '备注'], pivotRows));
  }

  const last = result.iterationsRecords[result.iterationsRecords.length - 1];
  if (last) {
    console.log('\n当前基变量（按约束行）：');
    console.log(table(['约束行', '基变量'], last.basisAfter.map((name, i) => [String(i), name ?? ''])));
  }
}

function usage(): void {
  console.log(`用法：
  npm run cli -- create  <model.json>                 从 JSON 文件创建模型
  npm run cli -- show    <modelId>                    查看冻结模型
  npm run cli -- solve   <modelId> [iterations]       执行单纯形（默认预算 10000）
  npm run cli -- iteration <runId> <n>               查看某轮表、入基离基与比值候选
  npm run cli -- verify  <modelId> <point.json>       核验外部候选点
  npm run cli -- compare <runIdA> <runIdB>            比较同一模型的两次运行
  npm run cli -- enumerate2d <modelId>                独立枚举二维边界交点核验
  npm run cli -- export  <runId> [out.json]           导出运行（默认打印到标准输出）`);
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

const [, , command, ...args] = process.argv;

try {
  switch (command) {
    case 'create': {
      const input = validateModelInput(readJsonFile(args[0]));
      const model = createModel(db, input);
      printModel(model);
      console.log(`modelId=${model.id}`);
      break;
    }
    case 'show': {
      printModel(getModelOrThrow(db, args[0]));
      break;
    }
    case 'solve': {
      const model = getModelOrThrow(db, args[0]);
      const options = validateSolveOptions(
        args[1] ? { rule: 'bland', maxIterations: Number.parseInt(args[1], 10) } : {},
      );
      const result = solve(model, options);
      const run = saveRun(db, model, options, result);
      printRun(getRunOrThrow(db, run.id));
      console.log(`runId=${run.id}`);
      break;
    }
    case 'iteration': {
      const record = getIteration(db, args[0], Number.parseInt(args[1], 10));
      console.log(`第 ${record.iteration} 轮　目标 ${fmt(record.objectiveBefore)} → ${fmt(record.objectiveAfter)}${record.degenerate ? '（退化换基，目标暂时不变）' : ''}`);
      if (record.entering && record.leaving) {
        console.log(`入基：${record.entering.variable}（检验数 ${fmt(record.entering.reducedCost)}）；离基：${record.leaving.variable}；枢轴元：${fmt(record.pivotElement)}`);
      }
      if (record.ratioCandidates.length > 0) {
        console.log(
          table(
            ['约束行', '约束', '入基列系数', 'RHS', '比值', '参与', '选中'],
            record.ratioCandidates.map((c) => [
              c.slackRow,
              c.constraint,
              fmt(c.pivotColumnCoefficient),
              fmt(c.rhs),
              Number.isNaN(c.ratio) ? c.excludedReason ?? '' : fmt(c.ratio),
              c.eligible ? '是' : '否',
              c.leaving ? '← 离基' : '',
            ]),
          ),
        );
      }
      console.log('基变量变化：');
      console.log(table(['约束行', '换基前', '换基后'], record.basisBefore.map((before, i) => [String(i), before ?? '', record.basisAfter[i] ?? ''])));
      console.log('表（末列为 RHS）：');
      console.log(table(
        record.tableau[0].map((_v, i) => (i === record.tableau[0].length - 1 ? 'RHS' : `列${i + 1}`)),
        record.tableau.map((row, i) => [i === 0 ? '目标行' : `约束${i}`, ...row.map((v) => fmt(v))]),
      ));
      break;
    }
    case 'verify': {
      const point = readJsonFile(args[1]);
      const result = verifyCandidate(db, args[0], point);
      console.log(`可行：${result.report.feasible ? '是' : '否'}　目标（直接求和）：${fmt(result.report.objective)}　最大违例：${fmt(result.report.maxViolation)}`);
      console.log(table(['约束', 'Ax', 'b', '残差', '结果'], result.report.residuals.map((r) => [r.constraint, fmt(r.lhs), fmt(r.rhs), fmt(r.slack), r.violated ? '违反' : '满足'])));
      if (result.matchesOptimum !== null) console.log(`与已保存最优点目标一致：${result.matchesOptimum ? '是' : '否'}`);
      break;
    }
    case 'compare': {
      const comparison = compareRuns(db, args[0], args[1]);
      console.log(table(['运行', '状态', '目标', '枢轴次数'], [
        [comparison.runA.id.slice(0, 8), comparison.runA.status, fmt(comparison.runA.objective), comparison.runA.iterations],
        [comparison.runB.id.slice(0, 8), comparison.runB.status, fmt(comparison.runB.objective), comparison.runB.iterations],
      ]));
      comparison.notes.forEach((note) => console.log(`- ${note}`));
      break;
    }
    case 'enumerate2d': {
      const model = getModelOrThrow(db, args[0]);
      const enumeration = enumerate2d(model);
      if (!enumeration.supported) {
        console.log(enumeration.reason);
        break;
      }
      console.log(table(['点', 'x', 'y', '可行', '目标值', '来源'], enumeration.points.map((p) => [
        `(${fmt(p.x)}, ${fmt(p.y)})`, fmt(p.x), fmt(p.y), p.feasible ? '是' : '否', fmt(p.objective), p.source,
      ])));
      console.log(enumeration.bounded
        ? `独立枚举最优值：${enumeration.best ? fmt(enumeration.best[0].objective) : '-'}（最优交点 ${enumeration.best?.length ?? 0} 个）`
        : `独立枚举结论：无界（${enumeration.reason}）`);
      break;
    }
    case 'export': {
      const payload = JSON.stringify(exportRun(db, args[0]), (_key, value) => value, 2);
      if (args[1]) {
        writeFileSync(args[1], payload, 'utf8');
        console.log(`已导出到 ${args[1]}`);
      } else {
        console.log(payload);
      }
      break;
    }
    default:
      usage();
  }
} catch (error) {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const appError = error as { code: string; message: string };
    console.error(`错误[${appError.code}]：${appError.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
