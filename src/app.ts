import { createServer, type Server } from "node:http";

import { LabService } from "./application/lab-service.js";
import { systemClock, type Clock } from "./domain/clock.js";
import { JsonStore } from "./infra/json-store.js";
import { pathParam, requireBody, Router, sendJson } from "./http/router.js";

export const serviceName = "创客实验室工具资质闸门";

export function healthPayload(): { status: "ok"; service: string } {
  return { status: "ok", service: serviceName };
}

/** 组装路由。service 可注入，便于测试使用内存存储与固定时钟。 */
export function buildRouter(service: LabService): Router {
  const router = new Router();

  router.add("GET", "/health", (ctx) => {
    sendJson(ctx.res, 200, healthPayload());
  });

  // ---------- 人员与小组 ----------
  router.add("POST", "/people", (ctx) => {
    sendJson(ctx.res, 201, service.createPerson(requireBody(ctx)));
  });
  router.add("GET", "/people", (ctx) => {
    sendJson(ctx.res, 200, service.listPeople());
  });
  router.add("POST", "/groups", (ctx) => {
    sendJson(ctx.res, 201, service.createGroup(requireBody(ctx)));
  });
  router.add("GET", "/groups", (ctx) => {
    sendJson(ctx.res, 200, service.listGroups());
  });
  router.add("POST", "/groups/:id/members", (ctx) => {
    const body = requireBody(ctx);
    const personId = typeof body.personId === "string" ? body.personId : "";
    sendJson(ctx.res, 200, service.addGroupMember(pathParam(ctx, "id"), personId));
  });
  router.add("GET", "/groups/:id/overview", (ctx) => {
    sendJson(ctx.res, 200, service.groupOverview(pathParam(ctx, "id")));
  });

  // ---------- 工具 ----------
  router.add("PUT", "/tools/:id", (ctx) => {
    sendJson(ctx.res, 200, service.upsertTool(pathParam(ctx, "id"), requireBody(ctx)));
  });
  router.add("GET", "/tools", (ctx) => {
    sendJson(ctx.res, 200, service.listTools());
  });
  router.add("POST", "/tools/:id/status", (ctx) => {
    const body = requireBody(ctx);
    const status = body.status === "active" ? "active" : body.status === "decommissioned" ? "decommissioned" : null;
    if (status === null) {
      sendJson(ctx.res, 400, { error: "validation", message: "status 必须是 active 或 decommissioned" });
      return;
    }
    sendJson(ctx.res, 200, service.setToolStatus(pathParam(ctx, "id"), status));
  });

  // ---------- 资质 ----------
  router.add("PUT", "/people/:personId/qualifications/:toolId", (ctx) => {
    sendJson(
      ctx.res,
      200,
      service.upsertQualification(pathParam(ctx, "personId"), pathParam(ctx, "toolId"), requireBody(ctx)),
    );
  });
  router.add("GET", "/qualifications", (ctx) => {
    sendJson(ctx.res, 200, service.listQualifications());
  });

  // ---------- 当班导师 ----------
  router.add("POST", "/mentors/:id/duty", (ctx) => {
    const body = requireBody(ctx);
    const groupId = body.groupId === undefined || body.groupId === null ? null : String(body.groupId);
    sendJson(ctx.res, 201, service.startDuty(pathParam(ctx, "id"), groupId));
  });
  router.add("POST", "/duties/:id/end", (ctx) => {
    sendJson(ctx.res, 200, service.endDuty(pathParam(ctx, "id")));
  });
  router.add("GET", "/duties", (ctx) => {
    sendJson(ctx.res, 200, service.listDuties());
  });

  // ---------- 监护授权 ----------
  router.add("POST", "/consents", (ctx) => {
    sendJson(ctx.res, 201, service.grantConsent(requireBody(ctx)));
  });

  // ---------- 材料批次 ----------
  router.add("PUT", "/materials/:id", (ctx) => {
    sendJson(ctx.res, 200, service.upsertMaterialBatch(pathParam(ctx, "id"), requireBody(ctx)));
  });
  router.add("GET", "/materials", (ctx) => {
    sendJson(ctx.res, 200, service.listMaterialBatches());
  });

  // ---------- 安全公告 ----------
  router.add("POST", "/notices", (ctx) => {
    sendJson(ctx.res, 201, service.publishNotice(requireBody(ctx)));
  });
  router.add("POST", "/notices/:id/lift", (ctx) => {
    sendJson(ctx.res, 200, service.liftNotice(pathParam(ctx, "id")));
  });
  router.add("GET", "/notices", (ctx) => {
    sendJson(ctx.res, 200, service.listNotices());
  });

  // ---------- 借出 / 归还 ----------
  router.add("POST", "/checkouts", (ctx) => {
    const result = service.checkout(requireBody(ctx));
    sendJson(ctx.res, result.reused ? 200 : 201, result);
  });
  router.add("POST", "/loans/:id/return", (ctx) => {
    sendJson(ctx.res, 200, service.returnLoan(pathParam(ctx, "id")));
  });
  router.add("GET", "/loans/:id", (ctx) => {
    sendJson(ctx.res, 200, service.getLoan(pathParam(ctx, "id")));
  });
  router.add("GET", "/loans", (ctx) => {
    const includeReturned = ctx.query.get("returned") === "true";
    sendJson(ctx.res, 200, service.listLoans(includeReturned));
  });

  // ---------- 事故 ----------
  router.add("POST", "/incidents", (ctx) => {
    sendJson(ctx.res, 201, service.openIncident(requireBody(ctx)));
  });
  router.add("POST", "/incidents/:id/review", (ctx) => {
    const body = requireBody(ctx);
    sendJson(
      ctx.res,
      200,
      service.reviewIncident(
        pathParam(ctx, "id"),
        typeof body.reviewerId === "string" ? body.reviewerId : "",
        typeof body.note === "string" ? body.note : "",
      ),
    );
  });
  router.add("POST", "/incidents/:id/release", (ctx) => {
    const body = requireBody(ctx);
    sendJson(
      ctx.res,
      200,
      service.releaseIncident(
        pathParam(ctx, "id"),
        typeof body.safetyOfficerId === "string" ? body.safetyOfficerId : "",
        typeof body.note === "string" ? body.note : "",
      ),
    );
  });
  router.add("GET", "/incidents", (ctx) => {
    sendJson(ctx.res, 200, service.listIncidents());
  });
  router.add("GET", "/incidents/:id/trace", (ctx) => {
    sendJson(ctx.res, 200, service.traceIncident(pathParam(ctx, "id")));
  });

  // ---------- 审计 ----------
  router.add("GET", "/decisions", (ctx) => {
    sendJson(ctx.res, 200, service.listDecisions());
  });

  // ---------- 测试运维 ----------
  router.add("POST", "/admin/reset", (ctx) => {
    service.reset();
    sendJson(ctx.res, 200, { ok: true });
  });

  return router;
}

export function createApp(service?: LabService): Server {
  const resolved =
    service ??
    new LabService(
      new JsonStore(process.env.STATE_FILE ?? ".runtime/lab-state.json"),
      systemClock,
    );
  return createServer(buildRouter(resolved).handler());
}

export function createTestApp(clock?: Clock): { server: Server; service: LabService } {
  const service = new LabService(new JsonStore(null), clock ?? systemClock);
  return { server: createServer(buildRouter(service).handler()), service };
}
