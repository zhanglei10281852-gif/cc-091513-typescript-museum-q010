import type { IncomingMessage, ServerResponse } from "node:http";

import { DomainError } from "../domain/errors.js";

export type HttpHandler = (ctx: HttpContext) => Promise<void> | void;

export interface HttpContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

interface Route {
  method: string;
  segments: string[];
  handler: HttpHandler;
}

const MAX_BODY_BYTES = 1_048_576;

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: HttpHandler): this {
    this.routes.push({ method, segments: pattern.split("/").filter(Boolean), handler });
    return this;
  }

  handler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
    return async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const pathSegments = url.pathname.split("/").filter(Boolean);
        const route = this.routes.find((candidate) => {
          if (candidate.method !== (req.method ?? "") || candidate.segments.length !== pathSegments.length) {
            return false;
          }
          return candidate.segments.every((segment, i) => {
            const actual = pathSegments[i] ?? "";
            return segment.startsWith(":") || segment === actual;
          });
        });
        if (!route) {
          sendJson(res, 404, { error: "not_found", message: "路由不存在" });
          return;
        }
        const params: Record<string, string> = {};
        for (let i = 0; i < route.segments.length; i += 1) {
          const expected = route.segments[i] ?? "";
          const actual = pathSegments[i] ?? "";
          if (expected.startsWith(":")) {
            params[expected.slice(1)] = decodeURIComponent(actual);
          }
        }

        const body = await readBody(req);
        await route.handler({ req, res, params, query: url.searchParams, body });
      } catch (error) {
        if (error instanceof DomainError) {
          const status =
            error.code === "not_found"
              ? 404
              : error.code === "validation"
                ? 400
                : error.code === "access_denied"
                  ? 403
                  : 409;
          sendJson(res, status, { error: error.code, message: error.message, details: error.details });
          return;
        }
        const message = error instanceof Error ? error.message : "内部错误";
        sendJson(res, 500, { error: "internal", message });
      }
    };
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new DomainError("validation", "请求体超过 1MB 限制");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new DomainError("validation", "请求体必须是合法 JSON");
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

export function pathParam(ctx: HttpContext, name: string): string {
  const value = ctx.params[name];
  if (typeof value !== "string" || value === "") {
    throw new DomainError("validation", `缺少路径参数 ${name}`, { field: name });
  }
  return value;
}

export function requireBody(ctx: HttpContext): Record<string, unknown> {
  if (ctx.body === null || typeof ctx.body !== "object" || Array.isArray(ctx.body)) {
    throw new DomainError("validation", "请求体必须是 JSON 对象");
  }
  return ctx.body as Record<string, unknown>;
}
