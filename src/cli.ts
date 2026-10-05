/**
 * CLI：以文本表格展示约束、当前基与目标变化。
 * 用法（先 npm run build）：
 *   node dist/src/cli.js serve [--port=8080]
 *   node dist/src/cli.js create model.json
 *   node dist/src/cli.js validate model.json
 *   node dist/src/cli.js solve <modelId> [--max-iterations=N] [--tolerance=1e-9]
 *   node dist/src/cli.js runs [modelId]
 *   node dist/src/cli.js steps <runId> [page] [size]
 *   node dist/src/cli.js tableau <runId> <iteration>
 *   node dist/src/cli.js verify <runId> point.json
 *   node dist/src/cli.js compare <modelId> c.json
 *   node dist/src/cli.js export <runId> [out.json]
 *   node dist/src/cli.js demo
 */

import * as fs from "node:fs";
import { Store } from "./db";
import { Service } from "./service";
import { StepRecord, TableauSnapshot } from "./simplex";
import { runDemo } from "./demo";

function fmt(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const r = Math.abs(v) < 1e-12 ? 0 : v;
  return Number.isInteger(r) ? String(r) : r.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );
  const line = (cells: string[]) =>
    "| " + cells.map((c, i) => c.padEnd(widths[i])).join(" | ") + " |";
  const sep = "|-" + widths.map((w) => "-".repeat(w)).join("-|-") + "-|";
  return [line(headers), sep, ...rows.map(line)].join("\n");
}

export function renderTableau(t: TableauSnapshot, varNames: string[], constraintNames: string[]): string {
  const names = [...varNames, ...constraintNames.map((n) => `s(${n})`)];
  const headers = ["基", ...names, "rhs"];
  const rows = t.rows.map((r, i) => [
    t.basisNames[i],
    ...r.map(fmt),
    fmt(t.rhs[i]),
  ]);
  rows.push(["检验数", ...t.reducedCosts.map(fmt), fmt(t.objective)]);
  return `--- 第 ${t.iteration} 轮表（目标 = ${fmt(t.objective)}）---\n` + table(headers, rows);
}

export function renderStep(s: StepRecord): string {
  const ratios = s.ratios
    .map((r) => `${r.basicVarName}: ${fmt(r.ratio)}`)
    .join(", ");
  const deg = s.degenerate ? "（退化：目标本轮不变）" : "";
  return [
    `第 ${s.iteration} 步：入基 ${s.enteringName}（检验数 ${fmt(s.enteringReducedCost)}），离基 ${s.leavingName}，枢轴 ${fmt(s.pivot)}${deg}`,
    `  比值候选: ${ratios}`,
    `  目标: ${fmt(s.objectiveBefore)} -> ${fmt(s.objectiveAfter)}`,
    `  基: [${s.basisBefore.join(", ")}] -> [${s.basisAfter.join(", ")}]`,
  ].join("\n");
}

function readJson(path: string): unknown {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function argValue(prefix: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(prefix));
    return a ? a.slice(prefix.length) : undefined;
}

function main(): void {
  const [, , cmd, ...args] = process.argv;
  const service = new Service(new Store());
  const out = (s: unknown) => console.log(typeof s === "string" ? s : JSON.stringify(s, null, 2));

  switch (cmd) {
    case "serve": {
      const port = Number(argValue("--port=") ?? process.env.PORT ?? 0);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createServer } = require("./server");
      const server = createServer(service);
      server.listen(port, () => {
        const addr = server.address();
        console.log(`服务已启动: http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`);
      });
      return; // 保持进程
    }
    case "create":
      return out(service.createModel(readJson(args[0])));
    case "validate":
      return out(service.validateOnly(readJson(args[0])));
    case "solve": {
      const opts: any = {};
      const mi = argValue("--max-iterations=");
      const tol = argValue("--tolerance=");
      if (mi) opts.maxIterations = Number(mi);
      if (tol) opts.tolerance = Number(tol);
      const { run, crosscheck } = service.solve(Number(args[0]), opts);
      console.log(`运行 #${run.id} 状态: ${run.status}（迭代 ${run.result.iterations} 次）`);
      console.log(run.result.message);
      if (run.result.x) {
        const model = service.mustModel(run.modelId);
        console.log("最优点: " + run.result.x.map((v, j) => `${model.varNames[j]}=${fmt(v)}`).join(", "));
        console.log("松弛量: " + run.result.slack!.map((v, i) => `s(${model.constraintNames[i]})=${fmt(v)}`).join(", "));
        console.log("最优目标: " + fmt(run.result.objective!));
        console.log("可行残差 max(Ax-b): " + fmt(run.result.feasibilityResidual!));
      }
      console.log("独立核对: " + JSON.stringify(crosscheck));
      console.log("提示: 可能有多个最优点，此处只返回其中一个。");
      return;
    }
    case "runs":
      return out(service.store.listRuns(args[0] ? Number(args[0]) : undefined).map((r) => ({
        id: r.id, modelId: r.modelId, status: r.status,
        objective: r.result.objective ?? null, createdAt: r.createdAt,
      })));
    case "steps": {
      const page = Number(args[1] ?? 1);
      const size = Number(args[2] ?? 50);
      const { steps, total } = service.store.getSteps(Number(args[0]), (page - 1) * size, size);
      console.log(`共 ${total} 步，第 ${page} 页：`);
      for (const s of steps) console.log(renderStep(s));
      return;
    }
    case "tableau": {
      const run = service.mustRun(Number(args[0]));
      const model = service.mustModel(run.modelId);
      const t = service.store.getTableau(run.id, Number(args[1]));
      if (!t) return out("该轮表不存在");
      return console.log(renderTableau(t, model.varNames, model.constraintNames));
    }
    case "verify":
      return out(service.verifyCandidate(Number(args[0]), readJson(args[1])));
    case "compare":
      return out(service.compareObjectives(Number(args[0]), readJson(args[1])));
    case "export": {
      const data = service.exportRun(Number(args[0]));
      if (args[1]) {
        fs.writeFileSync(args[1], JSON.stringify(data, null, 2), "utf8");
        return console.log(`已导出到 ${args[1]}`);
      }
      return out(data);
    }
    case "demo":
      return runDemo(service);
    default:
      console.log("命令: serve | create | validate | solve | runs | steps | tableau | verify | compare | export | demo");
  }
}

if (require.main === module) main();
