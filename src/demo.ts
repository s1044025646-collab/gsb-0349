/** 演示：五个可手算场景，直接打印换基过程与结果。 */

import { Service } from "./service";
import { renderStep, renderTableau } from "./cli";
import { Store } from "./db";

const demos: { title: string; model: any }[] = [
  {
    title: "1) 二维有界（可手算）：max 3x+2y, x+y<=4, 2x+y<=5, x,y>=0 → 最优 (1,3)，目标 9",
    model: {
      name: "bounded-2d",
      c: [3, 2],
      A: [[1, 1], [2, 1]],
      b: [4, 5],
      varNames: ["x", "y"],
      constraintNames: ["c1", "c2"],
    },
  },
  {
    title: "2) 目标全非正：max -x-y → 零点最优，0 次迭代",
    model: {
      name: "nonpositive-c",
      c: [-1, -1],
      A: [[1, 1], [2, 3]],
      b: [4, 9],
      varNames: ["x", "y"],
      constraintNames: ["c1", "c2"],
    },
  },
  {
    title: "3) 冗余约束：x+y<=10 被 x+y<=4 与 2x+y<=5 覆盖",
    model: {
      name: "redundant",
      c: [3, 2],
      A: [[1, 1], [2, 1], [1, 1]],
      b: [4, 5, 10],
      varNames: ["x", "y"],
      constraintNames: ["c1", "c2", "c3冗余"],
    },
  },
  {
    title: "4) 退化比值平局：x+y<=0, x<=0, y<=2，最小比值 0 出现平局，Bland 规则确定性打破，目标暂时不变",
    model: {
      name: "degenerate",
      c: [1, 1],
      A: [[1, 1], [1, 0], [0, 1]],
      b: [0, 0, 2],
      varNames: ["x", "y"],
      constraintNames: ["c1", "c2", "c3"],
    },
  },
  {
    title: "5) 明显无界：max x+y, -x+y<=1 → 沿 x 方向无界",
    model: {
      name: "unbounded",
      c: [1, 1],
      A: [[-1, 1]],
      b: [1],
      varNames: ["x", "y"],
      constraintNames: ["c1"],
    },
  },
];

export function runDemo(service: Service): void {
  for (const d of demos) {
    console.log("=".repeat(72));
    console.log(d.title);
    const model = service.createModel(d.model);
    const { run, crosscheck } = service.solve(model.id, {});
    const r = run.result;
    console.log(`模型 #${model.id}，运行 #${run.id}，状态: ${r.status}，迭代 ${r.iterations} 次`);
    console.log(r.message);
    for (const s of r.steps) console.log(renderStep(s));
    if (r.tableaus.length > 0) {
      const last = r.tableaus[r.tableaus.length - 1];
      console.log(renderTableau(last, model.varNames, model.constraintNames));
    }
    if (r.x) {
      console.log("最优点: " + r.x.map((v, j) => `${model.varNames[j]}=${v}`).join(", "));
      console.log("最优目标: " + r.objective);
      console.log("可行残差 max(Ax-b): " + r.feasibilityResidual);
    }
    console.log("独立核对: " + JSON.stringify(crosscheck));
  }
  console.log("=".repeat(72));
  console.log("提示：若存在多个最优点，演示只返回其中一个顶点。");
}

if (require.main === module) {
  runDemo(new Service(new Store()));
}
