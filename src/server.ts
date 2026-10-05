import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { AppError, ERROR_CODES, LIMITS } from './constants.js';
import { openDatabase, type Database } from './db.js';
import { validateModelInput, validateSolveOptions } from './validation.js';
import { solve } from './simplex.js';
import { enumerate2d } from './enumerate2d.js';
import {
  countIterations,
  createModel,
  getIteration,
  getIterationsPage,
  getModelOrThrow,
  getRunOrThrow,
  listModels,
  listRuns,
  saveRun,
} from './store.js';
import { compareRuns, exportRun, verifyCandidate } from './service.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..');
const dbPath = process.env.LP_DB_PATH ?? join(projectRoot, 'data', 'lp.sqlite');
const db: Database = openDatabase(dbPath);

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2 * 1024 * 1024) {
      throw new AppError(ERROR_CODES.VALIDATION_LIMIT, '请求体超过 2MB 限制');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')) as unknown;
  } catch {
    throw new AppError(ERROR_CODES.INVALID_JSON, '请求体不是合法 JSON');
  }
}

function send(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

interface RouteContext {
  body: unknown;
  query: URLSearchParams;
}

type RouteHandler = (ctx: RouteContext, match: string[]) => unknown | Promise<unknown>;
const routes = new Map<string, RouteHandler>();

routes.set('GET /health', () => ({
  ok: true,
  service: 'primal-simplex-lp',
  algorithmVersion: 'primal-simplex-bland-v1.0.0',
  limits: LIMITS,
}));

routes.set('POST /models', (ctx) => {
  const input = validateModelInput(ctx.body);
  const model = createModel(db, input);
  return { model };
});

routes.set('GET /models', () => ({ models: listModels(db) }));

routes.set('GET /models/:id', ((_ctx, match) => {
  const model = getModelOrThrow(db, match[1]);
  return { model };
}));

routes.set('POST /models/validate', (ctx) => {
  const input = validateModelInput(ctx.body);
  return { valid: true, normalized: input };
});

routes.set('POST /models/:id/solve', (ctx, match) => {
  const model = getModelOrThrow(db, match[1]);
  const body = (typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {}) as Record<string, unknown>;
  const options = validateSolveOptions(body);
  const result = solve(model, options);
  const stored = saveRun(db, model, options, result);
  return {
    runId: stored.id,
    modelId: model.id,
    frozenAt: stored.createdAt,
    options,
    result: stripTableau(stored.result),
  };
});

function stripTableau(result: ReturnType<typeof solve>) {
  return {
    ...result,
    iterationsRecords: result.iterationsRecords.map((record) => ({ ...record, tableau: '<分页通过 /runs/:id/iterations 获取>' })),
  };
}

routes.set('GET /models/:id/runs', (_ctx, match) => {
  getModelOrThrow(db, match[1]);
  return { runs: listRuns(db, match[1]).map(summarizeRun) };
});

function summarizeRun(run: ReturnType<typeof getRunOrThrow>) {
  return {
    id: run.id,
    status: run.status,
    objective: run.objective,
    iterations: run.result.iterations,
    createdAt: run.createdAt,
    options: run.options,
  };
}

routes.set('GET /runs', (_ctx, _match) => ({ runs: listRuns(db).map(summarizeRun) }));

routes.set('GET /runs/:id', (_ctx, match) => {
  const run = getRunOrThrow(db, match[1]);
  const model = getModelOrThrow(db, run.modelId);
  return { run: summarizeRun(run), model, result: stripTableau(run.result), iterationCount: countIterations(db, run.id) };
});

routes.set('GET /runs/:id/iterations', (ctx, match) => {
  const run = getRunOrThrow(db, match[1]);
  const total = countIterations(db, run.id);
  let page = Number.parseInt(ctx.query.get('page') ?? '0', 10);
  let pageSize = Number.parseInt(ctx.query.get('pageSize') ?? '50', 10);
  if (!Number.isInteger(page) || page < 0) page = 0;
  if (!Number.isInteger(pageSize) || pageSize <= 0) pageSize = 50;
  if (pageSize > 200) pageSize = 200;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (page >= totalPages) {
    throw new AppError(ERROR_CODES.PAGE_OUT_OF_RANGE, `页码 ${page} 超出范围（共 ${totalPages} 页，从 0 开始）`, {
      totalPages,
    });
  }
  const records = getIterationsPage(db, run.id, pageSize, page * pageSize);
  return { runId: run.id, total, page, pageSize, totalPages, records };
});

routes.set('GET /runs/:id/iterations/:n', (ctx, match) => {
  const runId = match[1];
  getRunOrThrow(db, runId);
  const iteration = Number.parseInt(match[2], 10);
  if (!Number.isInteger(iteration) || iteration < 0) {
    throw new AppError(ERROR_CODES.ITERATION_NOT_FOUND, '轮次必须是非负整数');
  }
  return { runId, record: getIteration(db, runId, iteration) };
});

routes.set('POST /models/:id/verify', (ctx, match) => {
  const body = (typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {}) as Record<string, unknown>;
  return { verification: verifyCandidate(db, match[1], body.point, typeof body.tolerance === 'number' ? body.tolerance : undefined) };
});

routes.set('GET /runs/:id/compare/:otherId', (_ctx, match) => ({
  comparison: compareRuns(db, match[1], match[2]),
}));

routes.set('GET /runs/:id/export', (_ctx, match) => ({ export: exportRun(db, match[1]) }));

routes.set('GET /models/:id/enumerate2d', (_ctx, match) => {
  const model = getModelOrThrow(db, match[1]);
  return { enumeration: enumerate2d(model) };
});

function matchRoute(method: string, pathname: string): { handler: (ctx: RouteContext, match: string[]) => unknown; params: string[] } | null {
  for (const [key, handler] of routes) {
    const [routeMethod, pattern] = key.split(' ');
    if (routeMethod !== method) continue;
    const patternParts = pattern.split('/').filter(Boolean);
    const pathParts = pathname.split('/').filter(Boolean);
    if (patternParts.length !== pathParts.length) continue;
    const params: string[] = [''];
    let matched = true;
    for (let i = 0; i < patternParts.length; i += 1) {
      if (patternParts[i].startsWith(':')) {
        params.push(decodeURIComponent(pathParts[i]));
      } else if (patternParts[i] !== pathParts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler, params };
  }
  return null;
}

export const app = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const matched = matchRoute(req.method ?? 'GET', url.pathname);
    if (!matched) {
      send(res, 404, { error: { code: 'NOT_FOUND', message: `无此路由：${req.method} ${url.pathname}` } });
      return;
    }
    const body = req.method === 'POST' ? await readJson(req) : {};
    const result = await matched.handler({ body, query: url.searchParams }, matched.params);
    send(res, 200, result);
  } catch (error) {
    if (error instanceof AppError) {
      const httpStatus =
        error.code === ERROR_CODES.MODEL_NOT_FOUND ||
        error.code === ERROR_CODES.RUN_NOT_FOUND ||
        error.code === ERROR_CODES.ITERATION_NOT_FOUND
          ? 404
          : 400;
      send(res, httpStatus, { error: { code: error.code, message: error.message, details: error.details } });
    } else {
      console.error(error);
      send(res, 500, {
        error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
});

export function listenOnFreePort(preferred?: number): Promise<{ port: number; server: Server }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, attemptsLeft: number) => {
      const probe = app.listen(port, () => {
        const address = probe.address();
        const actualPort = typeof address === 'object' && address ? address.port : port;
        resolve({ port: actualPort, server: probe });
      });
      probe.on('error', (error: NodeJS.ErrnoException) => {
        if ((error.code === 'EADDRINUSE' || error.code === 'EACCES') && attemptsLeft > 0) {
          tryListen(0, attemptsLeft - 1);
        } else {
          reject(error);
        }
      });
    };
    tryListen(preferred ?? 0, preferred === undefined ? 0 : 20);
  });
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('server.js')) {
  const preferred = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : undefined;
  listenOnFreePort(preferred).then(({ port }) => {
    console.log(`[primal-simplex-lp] 数据文件：${dbPath}`);
    console.log(`[primal-simplex-lp] HTTP API 已启动：http://localhost:${port}`);
    console.log('[primal-simplex-lp] 健康检查：GET /health');
  });
}
