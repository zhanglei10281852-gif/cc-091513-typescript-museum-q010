import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { createTestApp } from "../src/app.js";
import type { LabService } from "../src/application/lab-service.js";
import type { Server } from "node:http";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 18, 2, 0, 0);

const clock = {
  current: T0,
  now(): number {
    return clock.current;
  },
};

describe("工具资质闸门 端到端", () => {
  let server: Server;
  let service: LabService;
  let base: string;

  let studentA: string;
  let studentB: string;
  let studentC: string;
  let mentorId: string;
  let officerId: string;
  let guardianId: string;
  let groupId: string;
  const laser = "laser-cutter";
  const drill = "drill-press";
  const printer = "printer-3d";

  async function request(method: string, path: string, body?: unknown) {
    const init: RequestInit = {
      method,
      headers: { "content-type": "application/json" },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`${base}${path}`, init);
    const json = (await response.json()) as any;
    return { status: response.status, json };
  }

  const setup = async () => {
    // 人员
    const people = [
      ["安小武", "student"],
      ["贝小宁", "student"],
      ["陈小川", "student"],
      ["丁导师", "mentor"],
      ["安安全官", "safety_officer"],
      ["老安", "guardian"],
    ] as const;
    const created = await Promise.all(
      people.map(([name, role]) => request("POST", "/people", { name, role })),
    );
    const ids = created.map((r) => String((r.json as { id: string }).id));
    studentA = ids[0]!;
    studentB = ids[1]!;
    studentC = ids[2]!;
    mentorId = ids[3]!;
    officerId = ids[4]!;
    guardianId = ids[5]!;

    // 实践小组（导师 + 三名学生）
    const group = await request("POST", "/groups", {
      name: "周六激光小组",
      mentorIds: [mentorId],
      memberIds: [studentA, studentB, studentC],
    });
    groupId = String(group.json.id);

    // 工具：激光切割机（restricted、需材料、库存 1）、台钻（supervised、库存 1）、3D 打印机（basic）
    await request("PUT", `/tools/${laser}`, {
      name: "激光切割机",
      riskLevel: "restricted",
      stock: 1,
      requiresGuardian: true,
      requiresMaterial: true,
    });
    await request("PUT", `/tools/${drill}`, {
      name: "台钻",
      riskLevel: "supervised",
      stock: 1,
    });
    await request("PUT", `/tools/${printer}`, {
      name: "3D 打印机",
      riskLevel: "basic",
      stock: 5,
    });

    // 材料批次
    await request("PUT", "/materials/acrylic-ok", {
      name: "亚克力板批次 A",
      toolIds: [laser],
      quantity: 10,
      status: "ok",
    });
    await request("PUT", "/materials/acrylic-bad", {
      name: "亚克力板批次 X",
      toolIds: [laser],
      quantity: 10,
      status: "quarantined",
    });
  };

  before(async () => {
    const app = createTestApp(clock);
    server = app.server;
    service = app.service;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
    await setup();
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  test("未完成培训的学生领用被拒绝，并留下被拒判定快照", async () => {
    const denied = await request("POST", "/checkouts", { personId: studentA, toolId: laser });
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.json.details.missing, [
      "qualification_present",
      "qualification_state_active",
      "qualification_not_expired",
      "mentor_in_group",
      "mentor_on_duty",
      "guardian_consent",
      "material_batch",
    ]);

    const decisions = await request("GET", "/decisions");
    const list = decisions.json as unknown as Array<{ outcome: string; snapshot: { approved: boolean } }>;
    assert.equal(list.length, 1);
    assert.equal(list[0]!.outcome, "denied");
    assert.equal(list[0]!.snapshot.approved, false);
  });

  test("培训中、过期资质都被拒绝；复认证有效后进入下一项检查", async () => {
    await request("PUT", `/people/${studentA}/qualifications/${laser}`, {
      state: "training",
      trainingVersion: "laser-v1",
      expiresAt: T0 + 30 * DAY,
    });
    const training = await request("POST", "/checkouts", { personId: studentA, toolId: laser });
    assert.equal(training.status, 403);
    assert.ok((training.json.details.missing as string[]).includes("qualification_state_active"));

    await request("PUT", `/people/${studentA}/qualifications/${laser}`, {
      state: "expired",
      trainingVersion: "laser-v1",
      expiresAt: T0 - DAY,
    });
    const expired = await request("POST", "/checkouts", { personId: studentA, toolId: laser });
    assert.equal(expired.status, 403);
    assert.ok((expired.json.details.missing as string[]).includes("qualification_not_expired"));

    await request("PUT", `/people/${studentA}/qualifications/${laser}`, {
      state: "active",
      trainingVersion: "laser-v2",
      certifiedAt: T0 - 2 * DAY,
      expiresAt: T0 + 30 * DAY,
    });
    const qualified = await request("POST", "/checkouts", { personId: studentA, toolId: laser });
    assert.equal(qualified.status, 403);
    const missing = qualified.json.details.missing as string[];
    assert.ok(!missing.includes("qualification_state_active"));
    assert.ok(!missing.includes("qualification_not_expired"));
    assert.ok(missing.includes("mentor_on_duty"));
  });

  test("当班导师缺失、监护授权缺失、材料批次问题逐级拦截", async () => {
    // 导师当班 → 缺监护授权
    await request("POST", `/mentors/${mentorId}/duty`, { groupId });
    const noConsent = await request("POST", "/checkouts", { personId: studentA, toolId: laser });
    assert.equal(noConsent.status, 403);
    assert.deepEqual(noConsent.json.details.missing, ["guardian_consent", "material_batch"]);

    // 监护授权 → 缺材料批次
    await request("POST", "/consents", {
      studentId: studentA,
      guardianId,
      toolId: laser,
      expiresAt: T0 + 10 * DAY,
    });
    const noMaterial = await request("POST", "/checkouts", { personId: studentA, toolId: laser });
    assert.equal(noMaterial.status, 403);
    assert.deepEqual(noMaterial.json.details.missing, ["material_batch"]);

    // 隔离批次拒绝
    const quarantined = await request("POST", "/checkouts", {
      personId: studentA,
      toolId: laser,
      materialBatchId: "acrylic-bad",
    });
    assert.equal(quarantined.status, 403);
    assert.deepEqual(quarantined.json.details.missing, ["material_batch"]);
  });

  let loanId: string;
  let decisionId: string;

  test("条件齐备时领用成功，冻结当时全部条件并扣减材料", async () => {
    const ok = await request("POST", "/checkouts", {
      personId: studentA,
      toolId: laser,
      materialBatchId: "acrylic-ok",
      requestId: "swipe-001",
    });
    assert.equal(ok.status, 201);
    const body = ok.json as {
      loan: { id: string; events: unknown[]; snapshot: { training: { trainingVersion: string } } };
      decision: { id: string };
      reused: boolean;
    };
    assert.equal(body.reused, false);
    loanId = body.loan.id;
    decisionId = body.decision.id;
    assert.equal((body.loan.events[0] as { kind: string }).kind, "checked_out");
    assert.equal(body.loan.snapshot.training.trainingVersion, "laser-v2");

    const batch = await request("GET", "/materials");
    const acrylic = (batch.json as unknown as Array<{ id: string; quantity: number }>).find(
      (b) => b.id === "acrylic-ok",
    );
    assert.equal(acrylic!.quantity, 9);
  });

  test("重复刷卡只对应一次借出：回放原记录且不重复扣料", async () => {
    const again = await request("POST", "/checkouts", {
      personId: studentA,
      toolId: laser,
      materialBatchId: "acrylic-ok",
      requestId: "swipe-001",
    });
    assert.equal(again.status, 200);
    assert.equal((again.json as { reused: boolean }).reused, true);
    assert.equal((again.json as { loan: { id: string } }).loan.id, loanId);
    const batch = await request("GET", "/materials");
    const acrylic = (batch.json as unknown as Array<{ id: string; quantity: number }>).find(
      (b) => b.id === "acrylic-ok",
    );
    assert.equal(acrylic!.quantity, 9);
  });

  test("尚未归还的工具不能再次流转", async () => {
    const twice = await request("POST", "/checkouts", {
      personId: studentA,
      toolId: laser,
      materialBatchId: "acrylic-ok",
    });
    assert.equal(twice.status, 403);
    assert.ok((twice.json.details.missing as string[]).includes("no_open_loan"));
  });

  test("并发领料守住库存下限：库存 1 时两人同时刷卡仅一人成功", async () => {
    for (const student of [studentB, studentC]) {
      await request("PUT", `/people/${student}/qualifications/${drill}`, {
        state: "active",
        trainingVersion: "drill-v1",
        expiresAt: T0 + 30 * DAY,
      });
    }
    const [first, second] = await Promise.all([
      request("POST", "/checkouts", { personId: studentB, toolId: drill, requestId: "drill-b" }),
      request("POST", "/checkouts", { personId: studentC, toolId: drill, requestId: "drill-c" }),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [201, 403]);
    const loser = first.status === 403 ? first : second;
    assert.ok((loser.json.details.missing as string[]).includes("tool_inventory"));
  });

  test("被拒刷卡重复请求幂等回放原始拒绝，不产生新判定", async () => {
    const first = await request("POST", "/checkouts", { personId: studentC, toolId: laser, requestId: "swipe-deny" });
    assert.equal(first.status, 403);
    const before = (await request("GET", "/decisions")).json.length;
    const again = await request("POST", "/checkouts", { personId: studentC, toolId: laser, requestId: "swipe-deny" });
    assert.equal(again.status, 403);
    assert.equal(again.json.details.reused, true);
    const after = (await request("GET", "/decisions")).json.length;
    assert.equal(after, before);
  });

  test("安全公告生效后立即拒绝新领用，解除后恢复", async () => {
    // basic 工具：3D 打印机，学生 B 有资质
    await request("PUT", `/people/${studentB}/qualifications/${printer}`, {
      state: "active",
      trainingVersion: "printer-v1",
      expiresAt: T0 + 30 * DAY,
    });
    const before = await request("POST", "/checkouts", { personId: studentB, toolId: printer, requestId: "p1" });
    assert.equal(before.status, 201);
    await request("POST", `/loans/${(before.json as { loan: { id: string } }).loan.id}/return`);

    const notice = await request("POST", "/notices", {
      title: "3D 打印机喷嘴隐患",
      toolId: printer,
    });
    const blocked = await request("POST", "/checkouts", { personId: studentB, toolId: printer, requestId: "p2" });
    assert.equal(blocked.status, 403);
    assert.ok((blocked.json.details.missing as string[]).includes("safety_notice_clear"));

    await request("POST", `/notices/${String(notice.json.id)}/lift`);
    const after = await request("POST", "/checkouts", { personId: studentB, toolId: printer, requestId: "p3" });
    assert.equal(after.status, 201);
  });

  test("停用设备拒绝领用", async () => {
    await request("POST", `/tools/${printer}/status`, { status: "decommissioned" });
    const blocked = await request("POST", "/checkouts", { personId: studentB, toolId: printer, requestId: "p4" });
    assert.equal(blocked.status, 403);
    assert.ok((blocked.json.details.missing as string[]).includes("tool_operational"));
    await request("POST", `/tools/${printer}/status`, { status: "active" });
  });

  let incidentId: string;

  test("事故锁定独立于普通归还：未复查解除前归还被拒绝", async () => {
    const incident = await request("POST", "/incidents", {
      toolId: laser,
      loanId,
      description: "使用中出现焦糊味与异常反光",
      reportedBy: mentorId,
    });
    assert.equal(incident.status, 201);
    incidentId = String(incident.json.id);

    const loan = await request("GET", `/loans/${loanId}`);
    const kinds = ((loan.json as { events: Array<{ kind: string }> }).events || []).map((e) => e.kind);
    assert.ok(kinds.includes("locked"));
    assert.equal((loan.json as { returnedAt: number | null }).returnedAt, null);

    const normalReturn = await request("POST", `/loans/${loanId}/return`);
    assert.equal(normalReturn.status, 409);

    // 事故公告同时封锁新领用
    const newCheckout = await request("POST", "/checkouts", {
      personId: studentB,
      toolId: laser,
      materialBatchId: "acrylic-ok",
      requestId: "laser-during-incident",
    });
    assert.equal(newCheckout.status, 403);
    assert.ok((newCheckout.json.details.missing as string[]).includes("safety_notice_clear"));
  });

  test("只有安全负责人完成复查后才能解除事故锁定，随后归还闭环", async () => {
    // 未复查直接解除 → 409
    const early = await request("POST", `/incidents/${incidentId}/release`, {
      safetyOfficerId: officerId,
      note: "尝试直接解除",
    });
    assert.equal(early.status, 409);

    // 非安全负责人复查 → 403
    const wrongRole = await request("POST", `/incidents/${incidentId}/review`, {
      reviewerId: mentorId,
      note: "导师不能复查",
    });
    assert.equal(wrongRole.status, 403);

    const reviewed = await request("POST", `/incidents/${incidentId}/review`, {
      reviewerId: officerId,
      note: "现场复查：排烟管堵塞，已清理，设备复检合格",
    });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.json.status, "reviewed");

    const released = await request("POST", `/incidents/${incidentId}/release`, {
      safetyOfficerId: officerId,
      note: "准予恢复使用",
    });
    assert.equal(released.status, 200);
    assert.equal(released.json.status, "released");

    // 公告解除后普通归还成功
    const returned = await request("POST", `/loans/${loanId}/return`);
    assert.equal(returned.status, 200);
    assert.notEqual((returned.json as { returnedAt: number | null }).returnedAt, null);

    // 工具恢复新领用
    const recovered = await request("POST", "/checkouts", {
      personId: studentA,
      toolId: laser,
      materialBatchId: "acrylic-ok",
      requestId: "laser-after-release",
    });
    assert.equal(recovered.status, 201);
    loanId = (recovered.json as { loan: { id: string } }).loan.id;
    await request("POST", `/loans/${loanId}/return`);
  });

  test("导师打开小组即可看到成员可操作范围、缺失条件与未归还项目", async () => {
    // 台钻仍被学生 B 借出（未归还）
    const overview = await request("GET", `/groups/${groupId}/overview`);
    assert.equal(overview.status, 200);
    const body = overview.json as {
      mentors: Array<{ id: string }>;
      members: Array<{
        personId: string;
        capabilities: Array<{ toolId: string; approved: boolean }>;
        missingConditions: Array<{ toolId: string; missing: string[] }>;
        openLoans: Array<{ toolId: string; locked: boolean; incidentId: string | null }>;
      }>;
    };
    assert.equal(body.mentors[0]!.id, mentorId);
    assert.equal(body.members.length, 3);

    const memberB = body.members.find((m) => m.personId === studentB)!;
    const laserCap = memberB.capabilities.find((c) => c.toolId === laser)!;
    assert.equal(laserCap.approved, false); // 缺激光资质、监护授权
    const laserMissing = memberB.missingConditions.find((m) => m.toolId === laser)!;
    assert.ok(laserMissing.missing.includes("qualification_present"));
    assert.ok(laserMissing.missing.includes("guardian_consent"));
    // 能力视图不把库存/未归还计入缺失条件
    assert.ok(!laserMissing.missing.includes("tool_inventory"));

    const open = memberB.openLoans.find((l) => l.toolId === drill);
    assert.ok(open);
    assert.equal(open!.locked, false);

    const memberA = body.members.find((m) => m.personId === studentA)!;
    // 成员 A 具备激光切割机完整资质（导师当班 + 监护授权），能力视图不要求当场选批次
    const memberALaser = memberA.capabilities.find((c) => c.toolId === laser)!;
    assert.equal(memberALaser.approved, true);
    assert.equal(memberA.missingConditions.some((m) => m.toolId === laser), false);
  });

  test("安全人员可从事故一路追到培训版本、材料批次与值班责任人", async () => {
    const trace = await request("GET", `/incidents/${incidentId}/trace`);
    assert.equal(trace.status, 200);
    const body = trace.json as {
      incident: { status: string };
      training: { trainingVersion: string };
      materialBatch: { id: string };
      mentor: { id: string };
      guardian: { id: string };
      decision: { id: string; snapshot: { mentorDuty: { dutyId: string } } };
    };
    assert.equal(body.incident.status, "released");
    assert.equal(body.training.trainingVersion, "laser-v2");
    assert.equal(body.materialBatch.id, "acrylic-ok");
    assert.equal(body.mentor.id, mentorId);
    assert.equal(body.guardian.id, guardianId);
    assert.equal(body.decision.id, decisionId);
    assert.ok(body.decision.snapshot.mentorDuty.dutyId);
  });

  test("服务层直接断言：历史判定快照不受后续资质变化影响", () => {
    const loan = service.getLoan(loanId);
    assert.equal(loan.snapshot.training?.trainingVersion, "laser-v2");
    assert.equal(loan.snapshot.approved, true);
    // 事后把资质改为过期，快照不变
    service.upsertQualification(studentA, laser, {
      state: "expired",
      trainingVersion: "laser-v9",
      expiresAt: T0 - DAY,
    });
    const frozen = service.getLoan(loanId);
    assert.equal(frozen.snapshot.training?.trainingVersion, "laser-v2");
    assert.equal(frozen.snapshot.approved, true);
  });
});
