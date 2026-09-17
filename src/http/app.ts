import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { ApiError, LabService } from "../service/lab-service.js";
import type { JsonStore } from "../store/store.js";
import { serviceName } from "./service-info.js";

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: (params: Record<string, string>, body: unknown) => Promise<unknown>;
}

export function createApp(service: LabService): Server {
  const routes: Route[] = [];

  function add(
    method: string,
    path: string,
    handler: (params: Record<string, string>, body: any) => Promise<unknown>,
  ): void {
    const paramNames: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:([a-zA-Z]+)/g, (_match, name: string) => {
        paramNames.push(name);
        return "([^/]+)";
      })}$`,
    );
    routes.push({ method, pattern, paramNames, handler });
  }

  // 领用与归还
  add("POST", "/checkouts", (_p, b) => service.checkout(b));
  add("POST", "/loans/:id/return", (p, b) =>
    service.returnLoan(p.id, b?.actorId ?? "unknown", b?.at),
  );

  // 事故与安全复查
  add("POST", "/incidents", (_p, b) => service.reportIncident(b));
  add("POST", "/incidents/:id/review", (p, b) =>
    service.reviewIncident({ ...b, incidentId: p.id }),
  );
  add("GET", "/incidents", () => service.listOpenIncidents());
  add("GET", "/incidents/:id/trace", (p) => service.getIncidentTrace(p.id));

  // 导师小组视图
  add("GET", "/groups/:id", (p, b) => service.getGroupView(p.id, b?.at));

  // 逾期扫描
  add("POST", "/maintenance/mark-overdue", (_p, b) =>
    service.markOverdue(b?.loanTimeoutMs ?? 7 * 24 * 3600 * 1000, b?.at),
  );

  // 基础数据维护
  add("POST", "/admin/students", (_p, b) => service.addStudent(b));
  add("POST", "/admin/mentors", (_p, b) => service.addMentor(b));
  add("POST", "/admin/safety-officers", (_p, b) => service.addSafetyOfficer(b));
  add("POST", "/admin/tools", (_p, b) => service.addTool(b));
  add("POST", "/admin/equipment", (_p, b) => service.addEquipment(b));
  add("POST", "/admin/equipment/:id/status", (p, b) =>
    service.setEquipmentStatus(p.id, b?.status, b?.reason ?? ""),
  );
  add("POST", "/admin/qualifications", (_p, b) => service.recordQualification(b));
  add("POST", "/admin/notices", (_p, b) => service.addSafetyNotice(b));
  add("POST", "/admin/notices/:id/revoke", (p, b) => service.revokeSafetyNotice(p.id));
  add("POST", "/admin/material-batches", (_p, b) => service.addMaterialBatch(b));
  add("POST", "/admin/consents", (_p, b) => service.grantConsent(b));

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      sendError(response, error);
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { status: "ok", service: serviceName });
      return;
    }

    const body = await readBody(request);
    for (const route of routes) {
      if (route.method !== request.method) continue;
      const match = url.pathname.match(route.pattern);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, index) => {
        params[name] = decodeURIComponent(match[index + 1] ?? "");
      });
      const result = await route.handler(params, body);
      sendJson(response, 200, result ?? { ok: true });
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === "GET") return null;
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError("invalid_json", 400, "请求体不是合法 JSON");
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    sendJson(response, error.statusCode, {
      error: error.code,
      message: error.message,
      ...(error.details ?? {}),
    });
    return;
  }
  const message = error instanceof Error ? error.message : "internal_error";
  sendJson(response, 500, { error: "internal_error", message });
}

/** 供入口与测试复用：基于一个存储构建服务与 HTTP 应用。 */
export function createServiceApp(store: JsonStore, now?: () => number): Server {
  return createApp(new LabService(store, now ? { now } : {}));
}
