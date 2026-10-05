# 受限原始单纯形线性规划教学后端

只用 TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`，零原生依赖）实现的
教学用线性规划求解服务，提供 HTTP API 与 CLI，Windows 本地直接运行，
不需要 Docker / WSL / 付费服务 / 外部在线 API，也不安装任何第三方求解器。

## 求解范围（明确的边界）

仅支持如下受限形式（输入已保证原点可行）：

```
maximize  c · x
subject to  A x <= b,  x >= 0,  b >= 0
```

- 不支持：等式约束、负右端、整数规划、任意模型的自动转换。
- 不做：两阶段法、对偶单纯形、大规模优化平台。
- 负右端输入会被拒绝为**输入错误**（错误码 `NEGATIVE_RHS`），
  而不是被误报为"数学上不可行"。
- 核心换基完全自行实现（`src/simplex.ts`），未调用任何现成 LP 库。

## 算法说明

- 加松弛变量 `s = b - A x`，以全部松弛变量为初始基。
- 符号约定：检验数 `> tolerance` 表示该列可改进目标。
- 入基：Bland 规则，取可改进列中下标最小者（变量顺序固定为
  `x_1..x_n, s_1..s_m`，平局与对象遍历顺序无关，完全确定）。
- 离基：合法最小比值检验（仅列系数 `> tolerance` 的行参与），
  比值平局时取基变量下标最小者（Bland 防循环）。
- 每一步记录：入基/离基、枢轴、全部比值候选、操作前后目标值、
  基变量变化；退化换基（目标本轮不变）会显式标注 `degenerate`。
- 可改进列没有任何可离基行时报告 `unbounded`，指出该列名称与依据，
  不会除零或返回任意大数。
- 达到迭代预算返回 `iteration_limit`，枢轴不可靠返回 `numerical_error`，
  都不冒充最优。
- 最优时恢复原变量值、松弛量与目标值，并用原始 `A`、`b` 独立核对
  可行残差 `max(Ax - b)`。
- 若存在多个最优点，只返回其中一个顶点（结果消息中明确说明）。

## 数值与规模限制

| 项目 | 默认值 | 上限 |
|---|---|---|
| 容差 tolerance | `1e-9` | `(0, 1e-2]` |
| 迭代预算 maxIterations | `1000` | `100000` |
| 变量数 | — | `50` |
| 约束数 | — | `50` |
| 系数绝对值 | — | `1e9` |

小数允许，但使用 IEEE 双精度，不宣称任意精度。

## 错误码

`DIM_MISMATCH`（维度不一致）、`DUPLICATE_NAME`（重名）、
`NON_FINITE`（非有限系数）、`NEGATIVE_RHS`（负右端）、
`LIMIT_EXCEEDED`（超规模上限）、`BAD_BUDGET`（非法容差/预算）、
`BAD_SHAPE`（请求结构错误）、`NOT_FOUND`、`BAD_CANDIDATE`（非法候选点）。

## 构建、测试、启动、演示

```powershell
npm install        # 仅安装 typescript 与 @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部单元测试（node:test）
npm start          # 启动 HTTP 服务（默认自动选择空闲端口）
npm start -- --port=8080   # 或 $env:PORT=8080
npm run demo       # 运行 5 个可手算演示场景
node dist/src/cli.js <命令>   # CLI，见下
```

数据保存在项目内 `data/simplex.db`（模型、变量顺序、选择规则、容差、
算法版本随运行一起冻结；运行结果 + 每步换基 + 每张表在单个事务中原子写入，
重启后历史可完整读取）。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/models` | 创建模型（校验后入库） |
| POST | `/models/validate` | 只校验不入库 |
| GET | `/models`、`/models/:id` | 查询模型 |
| POST | `/models/:id/solve` | 执行求解，可带 `{tolerance, maxIterations, c}` |
| POST | `/models/:id/compare` | 比较目标版本 `{c}`，产生新运行，旧运行不变 |
| GET | `/runs`、`/runs/:id` | 查询运行与结果 |
| GET | `/runs/:id/steps?page=&size=` | 分页查看换基解释（分页不影响算法是否完成） |
| GET | `/runs/:id/tableaus/:iteration` | 查询某一轮单纯形表 |
| POST | `/runs/:id/verify` | 核验外部候选点 `{x}`：代回原始约束 |
| GET | `/runs/:id/export` | 导出完整 JSON |

模型 JSON 格式见 `examples/bounded2d.json`。

## CLI

```powershell
node dist/src/cli.js serve [--port=8080]
node dist/src/cli.js create examples/bounded2d.json
node dist/src/cli.js validate examples/bounded2d.json
node dist/src/cli.js solve 1 [--max-iterations=N] [--tolerance=1e-9]
node dist/src/cli.js steps 1 [页] [每页]
node dist/src/cli.js tableau 1 0
node dist/src/cli.js verify 1 examples/point.json
node dist/src/cli.js compare 1 examples/alt-c.json
node dist/src/cli.js export 1 [out.json]
node dist/src/cli.js demo
```

CLI 以文本表格展示约束行、当前基、检验数行与每步目标变化，无图形界面。

## 演示场景（`npm run demo`）

1. 可手算二维有界：`max 3x+2y, x+y<=4, 2x+y<=5` → 最优 `(1,3)`，目标 `9`。
2. 目标全非正：零点最优，0 次迭代。
3. 冗余约束：结果与去掉冗余约束一致。
4. 退化比值平局：最小比值 0 平局，Bland 规则确定性打破，目标暂时不变。
5. 明显无界方向：报告无界并指出入基列。

每个二维有界场景都会用独立实现做交叉核对：枚举所有约束边界直线与
坐标轴的交点、筛选可行点、直接计算 `c·x` 取最大，与单纯形结果比对
（`src/crosscheck.ts`，不复用求解器自己的目标行）。

## 测试覆盖（`npm test`，13 个用例）

二维有界手算值 + 独立枚举核对、全非正目标、冗余约束、退化平局、
无界方向、零右端、非法负右端、低迭代预算、非法输入（非有限/重名/维度）、
重复运行确定性、坏/好外部候选点、重启后历史读取、目标版本比较。
另有 `node test/api.smoke.cjs` 做 HTTP 端点冒烟。

## 已知限制

- 双精度浮点，退化问题理论上可能迭代较多（Bland 规则保证终止但不保证快）。
- 只返回一个最优顶点，不枚举全部最优面。
- 二维交叉核对仅适用于变量数为 2 的模型。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，属正常现象。
