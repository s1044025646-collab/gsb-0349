# 受限原始单纯形线性规划后端（教学用）

从零实现的教学用线性规划（LP）求解服务，只提供 **HTTP API 与命令行（CLI）**，无图形界面。
使用 **TypeScript + Node.js + 内置 SQLite（`node:sqlite`）**，在 Windows 本地直接运行，
**不依赖 Docker、WSL、付费服务、外部在线 API，也不调用任何现成线性规划库**——换基过程全部手写。

## 1. 支持与不支持的模型

仅支持可从全零变量出发的标准形式：

\[
\max\ c^\top x,\quad A x \le b,\quad x \ge 0,\quad b \ge 0
\]

- 系数矩阵、目标系数、变量名、约束名都由调用方提供，且必须是**有限数值**（允许小数，使用 IEEE 754 双精度，**不宣称任意精度**）。
- 初始基为对每个 `Ax≤b` 约束追加的**松弛变量**，其值初始为 `b`，因此零起点可行。

**明确不支持**（也不会“偷偷转换”）：

- 等式约束、负右端（`b_i < 0`）、整数/0-1 规划；
- 任意模型的自动标准化、两阶段法、对偶单纯形、大规模优化平台特性。

特别地，**负右端会被直接拒绝并返回错误码 `VALIDATION_NEGATIVE_RHS`，而不会被错误标记为“数学上不可行”**；`b_i = 0` 的零右端合法。

## 2. 算法与符号约定

核心代码在 `src/simplex.ts`，自行实现加松弛变量后的**原始单纯形（primal simplex）换基**：

1. 建表：目标行为 `z_j - c_j`（即初始目标行第 j 列为 `-c_j`），约束行追加单位松弛列，末列为 RHS。
2. **入基（Bland 规则）**：最大化时目标行**严格为负**（`< -zero`）的检验数表示可改善；取其中**列索引最小**者，与对象/名称遍历顺序无关。
3. **离基（最小比值检验）**：只考虑入基列系数**严格为正**的约束行，比值 `RHS / 系数`；取最小比值。
   - 平局按 **Bland 规则**：在当前基变量列索引最小的行离基，保证确定性、防循环，不依赖遍历偶然顺序。
   - 比值为 0 的平局即**退化（degenerate）**，会在明细中标出，目标在该轮换基中暂时不变。
4. **枢轴消元**：归一化枢轴行后对其余各行（含目标行）做高斯消元，更新基变量。
5. 终止条件之一：
   - `optimal`：目标行不再有负检验数；
   - `unbounded`：入基列在所有约束行系数都不大于 0，最小比值检验无候选——报告入基列与依据，**不除零、不返回任意大数**；
   - `iteration_limit`：达到迭代预算仍有可改善方向，返回当前可行点但**不冒充最优**；
   - `numerical_error`：枢轴元小于数值底线或消元后 RHS 显著为负，无法可靠继续，**不冒充最优**。

恢复解时从当前基读取：基变量取对应 RHS、非基变量为 0；再拆分出原变量与松弛量，并**独立地**用原始 `A,b` 重新计算每条约束的残差 `b - Ax` 做可行核对，目标值也按 `c·x` 直接求和，不仅凭单纯形目标行断言正确。

存在非基变量检验数约为 0 时会标记 `alternateOptimaPossible`，并在结果中明确：**多个最优点时此处只返回其中一个**。

### 容差与限额（`src/constants.ts`）

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `tolerance.zero` | `1e-9` | 检验数/比值判定为 0 的阈值 |
| `tolerance.pivotMin` | `1e-12` | 枢轴元绝对值下限，低于则报数值问题 |
| `tolerance.valueAbs` | `1e-7` | 解、残差、可行性的绝对容差（需满足 `pivotMin ≤ zero ≤ valueAbs`） |
| 最大变量数 / 约束数 | `200` / `200` | 防止不受控计算与明细输出 |
| 系数 / 右端绝对值上限 | `1e9` | 超出拒绝 |
| 默认迭代预算 / 上限 | `10000` / `100000` | 预算必须是正整数 |

选择规则当前仅 `bland`；算法版本字符串 `primal-simplex-bland-v1.0.0` 随每次运行冻结入库。

## 3. 数据持久化与版本冻结

SQLite 数据文件默认在项目内 `data/lp.sqlite`（可用环境变量 `LP_DB_PATH` 覆盖，`PORT` 指定端口）。

- 模型（变量顺序、名称、A、b、c）、选择规则、容差、迭代预算、算法版本在求解时**冻结**到 `runs` 行。
- 结果摘要与逐轮明细（`iterations`：操作前后目标、入基/离基、枢轴元、全部比值候选、基变量变化、完整表）在**同一事务内原子保存**。
- **修改目标或约束请新建模型/运行**；旧运行仍按其冻结模型展示。比较接口只允许同一模型的两次运行，否则返回 `RUNS_INCOMPATIBLE`。
- 重启后可重新读取历史表、轮次与外部候选核验记录；解释分页不影响算法是否完成。

## 4. 快速开始（Windows PowerShell）

需要 Node.js ≥ 22.5（开发与实测环境为 Node 25）。

```powershell
npm install        # 仅安装 typescript 与 @types/node，无 LP 库、无原生编译
npm run build      # TypeScript 编译到 dist/
npm test           # 编译并运行 node:test 测试
npm run demo       # 运行六个可手算场景并做独立枚举交叉核验
npm start          # 启动 HTTP API；默认选择空闲端口，控制台打印实际端口
```

指定端口 / 数据文件：

```powershell
$env:PORT="8080"; $env:LP_DB_PATH="$PWD\data\mine.sqlite"; npm start
```

## 5. CLI

```powershell
npm run cli -- create      examples/bounded.json
npm run cli -- show        <modelId>
npm run cli -- solve       <modelId> [迭代预算]
npm run cli -- iteration   <runId> <轮次n>
npm run cli -- verify      <modelId> examples/point-bad.json
npm run cli -- compare     <runIdA> <runIdB>
npm run cli -- enumerate2d <modelId>
npm run cli -- export      <runId> [out.json]
```

输出为中文表格：约束与右端、当前基变量（按约束行）、换基与目标变化表（含“退化目标不变”标记）、
每轮的比值候选及离基选择、独立可行残差表。完整工作流示例：

```powershell
$m = node --no-warnings dist/src/cli.js create examples/bounded.json
$modelId = ($m | Select-String 'modelId=(\S+)').Matches.Groups[1].Value
$r = node --no-warnings dist/src/cli.js solve $modelId
$runId = ($r | Select-String 'runId=(\S+)').Matches.Groups[1].Value
node --no-warnings dist/src/cli.js iteration $runId 1
node --no-warnings dist/src/cli.js verify $modelId examples/point-optimal.json
node --no-warnings dist/src/cli.js enumerate2d $modelId
```

## 6. HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查、算法版本、限额 |
| `POST /models/validate` | 仅校验输入，不落库 |
| `POST /models` | 创建并冻结模型 |
| `GET /models` / `GET /models/:id` | 列表 / 详情 |
| `POST /models/:id/solve` | 执行单纯形；body 可含 `{rule,maxIterations,tolerance}` |
| `GET /models/:id/runs` | 该模型全部运行 |
| `GET /runs` / `GET /runs/:id` | 全部运行 / 某运行（冻结模型+结果摘要） |
| `GET /runs/:id/iterations?page=&pageSize=` | 逐轮解释分页（`page` 从 0 起） |
| `GET /runs/:id/iterations/:n` | 取某一轮完整表与比值候选 |
| `POST /models/:id/verify` | body `{point:{...},tolerance?}`，独立核验外部候选点 |
| `GET /runs/:id/compare/:otherId` | 比较同模型两次运行 |
| `GET /runs/:id/export` | 导出冻结模型、运行配置、结果与限额 |
| `GET /models/:id/enumerate2d` | 二维模型独立枚举边界交点核验 |

创建模型的 body 形态：

```json
{
  "name": "可选名称",
  "variables": ["x", "y"],
  "constraints": ["c1", "c2"],
  "A": [[1, 2], [2, 1]],
  "b": [8, 8],
  "c": [3, 4]
}
```

错误统一返回 `{"error":{"code","message","details"}}`，常见错误码：
`VALIDATION_DIMENSION`、`VALIDATION_DUPLICATE_NAME`、`VALIDATION_NON_FINITE`、
`VALIDATION_NEGATIVE_RHS`、`VALIDATION_LIMIT`、`INVALID_BUDGET`、`INVALID_TOLERANCE`、
`MODEL_NOT_FOUND`、`RUN_NOT_FOUND`、`ITERATION_NOT_FOUND`、`CANDIDATE_DIMENSION`、
`CANDIDATE_NON_FINITE`、`RUNS_INCOMPATIBLE`、`PAGE_OUT_OF_RANGE`。

## 7. 独立正确性核验（不只信求解器自己）

`src/enumerate2d.ts` 对两变量模型**完全独立**于单纯形：枚举原点、各约束边界与 x/y 轴交点、
每两条约束边界交点，逐一筛可行点，按 `c·x` 取最优；并沿目标方向判断可行域是否无界。
`npm run demo` 会把枚举结果与单纯形结果逐场景比对（一致打 ✓）。

## 8. 演示场景（`npm run demo`）

1. **二维有界**：`max 3x+4y`，最优点 `(8/3, 8/3)`，`z = 56/3 ≈ 18.667`；
2. **目标全非正**：`max -x-y`，零起点即最优，`z=0`，0 次枢轴；
3. **冗余约束**：两条共线约束不改变最优；
4. **退化比值平局**：零右端造成 `0/系数` 平局，记录退化换基（目标暂不变），Bland 确定性离基；
5. **明显无界**：`max x+y, x-y≤1`，报告无界入基列与依据；
6. **低迭代预算**：预算 1 时返回 `iteration_limit`，当前值严格小于真最优，绝不冒充最优。

测试覆盖（`test/`）：上述场景、零右端、非法负右端、维度/重名/非有限系数、非法预算、
坏外部候选、解代回原约束、目标直接求和、重复运行确定性，以及关闭 SQLite 后重开读取历史表与核验。

## 9. 限制

- 双精度浮点，不保证任意精度；接近奇异或系数量级巨大时可能进入 `numerical_error`。
- 仅 `Ax≤b, b≥0, x≥0` 形式；不含等式、负右端、两阶段/对偶、整数规划。
- 规模上限 200 变量 / 200 约束，面向教学与可解释的换基过程，不是高性能求解器。
