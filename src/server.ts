/** HTTP API 服务器（node:http，无外部依赖）。默认端口 0 = 自动选择空闲端口。 */

import * as http from "node:http";
import { Service } from "./service";
import { Store } from "./db";
import { ApiError } from "./validate";

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError("BAD_SHAPE", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(service: Service): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body, null, 2);
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(text);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body = method === "POST" ? await readBody(req) : {};
      const id = (i: number) => Number(parts[i]);
      if (method === "GET" && parts.length === 0)
        return send(200, {
          name: "simplex-teaching-server",
          endpoints: [
            "POST /models",
            "POST /models/validate",
            "GET /models",
            "POST /models/:id/solve",
            "POST /models/:id/compare",
            "GET /runs",
            "GET /runs/:id",
            "GET /runs/:id/steps?page=&size=",
            "GET /runs/:id/tableaus/:iteration",
            "POST /runs/:id/verify",
            "GET /runs/:id/export",
          ],
        });
      if (method === "POST" && parts[0] === "models" && parts.length === 1)
        return send(201, service.createModel(body));
      if (method === "POST" && parts[0] === "models" && parts[1] === "validate")
        return send(200, service.validateOnly(body));
      if (method === "GET" && parts[0] === "models" && parts.length === 1)
        return send(200, service.store.listModels());
      if (method === "GET" && parts[0] === "models" && parts.length === 2)
        return send(200, service.mustModel(id(1)));
      if (method === "POST" && parts[0] === "models" && parts[2] === "solve")
        return send(200, service.solve(id(1), body as any));
      if (method === "POST" && parts[0] === "models" && parts[2] === "compare")
        return send(200, service.compareObjectives(id(1), (body as any).c));
      if (method === "GET" && parts[0] === "runs" && parts.length === 1)
        return send(200, service.store.listRuns());
      if (method === "GET" && parts[0] === "runs" && parts.length === 2)
        return send(200, service.mustRun(id(1)));
      if (method === "GET" && parts[0] === "runs" && parts[2] === "steps") {
        const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
        const size = Math.min(100, Math.max(1, Number(url.searchParams.get("size") ?? 10)));
        const { steps, total } = service.store.getSteps(id(1), (page - 1) * size, size);
        return send(200, { page, size, total, steps });
      }
      if (method === "GET" && parts[0] === "runs" && parts[2] === "tableaus") {
        const t = service.store.getTableau(id(1), Number(parts[3]));
        if (!t) throw new ApiError("NOT_FOUND", "该轮表不存在", 404);
        return send(200, t);
      }
      if (method === "POST" && parts[0] === "runs" && parts[2] === "verify")
        return send(200, service.verifyCandidate(id(1), (body as any).x));
      if (method === "GET" && parts[0] === "runs" && parts[2] === "export")
        return send(200, service.exportRun(id(1)));
      throw new ApiError("NOT_FOUND", `未知路由 ${method} ${url.pathname}`, 404);
    } catch (e) {
      if (e instanceof ApiError)
        return send(e.httpStatus, { error: { code: e.code, message: e.message } });
      send(500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
}

if (require.main === module) {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  const port = portArg ? Number(portArg.split("=")[1]) : Number(process.env.PORT ?? 0);
  const service = new Service(new Store());
  const server = createServer(service);
  server.listen(port, () => {
    const addr = server.address();
    const actual = typeof addr === "object" && addr ? addr.port : port;
    console.log(`单纯形教学服务已启动: http://127.0.0.1:${actual}`);
    console.log(`数据目录: ${process.cwd()}\\data`);
  });
}
