/** API 冒烟脚本：启动服务器，打一轮主要端点后退出。 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const PORT = 18349;
const base = `http://127.0.0.1:${PORT}`;

async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

(async () => {
  const srv = spawn("node", ["dist/src/server.js", `--port=${PORT}`], { stdio: "pipe" });
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const model = JSON.parse(fs.readFileSync("examples/bounded2d.json", "utf8"));
    const created = await req("POST", "/models", model);
    console.log("create:", created.status, "id=", created.json.id);
    const bad = await req("POST", "/models", { ...model, b: [-1, 5] });
    console.log("negative rhs:", bad.status, bad.json.error.code);
    const solved = await req("POST", `/models/${created.json.id}/solve`, {});
    console.log("solve:", solved.json.run.status, "obj=", solved.json.run.result.objective,
      "crosscheck=", solved.json.crosscheck.matchesSolver);
    const runId = solved.json.run.id;
    const steps = await req("GET", `/runs/${runId}/steps?page=1&size=1`);
    console.log("steps page:", steps.json.total, "步, 本页", steps.json.steps.length);
    const tab = await req("GET", `/runs/${runId}/tableaus/2`);
    console.log("tableau iter2 objective:", tab.json.objective);
    const ok = await req("POST", `/runs/${runId}/verify`, { x: [1, 3] });
    console.log("verify good:", ok.json.feasible, ok.json.isOptimal);
    const badPt = await req("POST", `/runs/${runId}/verify`, { x: [10, 10] });
    console.log("verify bad:", badPt.json.feasible);
    const cmp = await req("POST", `/models/${created.json.id}/compare`, { c: [1, 5] });
    console.log("compare:", cmp.json.original.objective, "vs", cmp.json.alternate.objective);
    const exp = await req("GET", `/runs/${runId}/export`);
    console.log("export keys:", Object.keys(exp.json).join(","));
  } finally {
    srv.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
