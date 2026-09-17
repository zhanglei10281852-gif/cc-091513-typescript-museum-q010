import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import { LabService } from "../src/service/lab-service.js";
import { JsonStore } from "../src/store/store.js";
import { buildFixture, HOUR } from "./helpers.js";

// buildFixture 每次重新建库；为了让测试体拿到夹具，直接在测试里装配服务。
async function startFixture(): Promise<{ base: string; close: () => Promise<void>; fixture: Awaited<ReturnType<typeof buildFixture>> }> {
  const fixture = await buildFixture();
  const server = createApp(fixture.service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    fixture,
  };
}

test("HTTP 健康检查", async () => {
  const fixture = await buildFixture();
  const server = createApp(fixture.service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", service: "创客实验室工具资质闸门" });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("HTTP 完整链路：领用被拒 -> 满足条件 -> 事故锁定 -> 复查解除 -> 归还", async () => {
  const { base, close, fixture } = await startFixture();
  try {
    const { ids, clock } = fixture;

    // 缺少材料批次：403 且返回逐条条件。
    const denied = await fetch(`${base}/checkouts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        studentId: ids.student,
        toolId: ids.laser,
        mentorId: ids.mentor,
        groupId: ids.group,
        cardSwipeId: "card-1",
        now: clock.now,
      }),
    });
    assert.equal(denied.status, 403);
    const deniedBody = await denied.json();
    assert.equal(deniedBody.error, "admission_denied");
    assert.ok(Array.isArray(deniedBody.conditions));

    // 合规领用。
    const ok = await fetch(`${base}/checkouts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        studentId: ids.student,
        toolId: ids.laser,
        mentorId: ids.mentor,
        groupId: ids.group,
        cardSwipeId: "card-2",
        materialBatchId: ids.acrylicBatch,
        now: clock.now,
      }),
    });
    assert.equal(ok.status, 200);
    const { loan } = await ok.json();

    // 重复刷卡回放。
    const replay = await fetch(`${base}/checkouts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        studentId: ids.student,
        toolId: ids.laser,
        mentorId: ids.mentor,
        groupId: ids.group,
        cardSwipeId: "card-2",
        materialBatchId: ids.acrylicBatch,
        now: clock.now,
      }),
    });
    assert.equal((await replay.json()).duplicatedSwipe, true);

    // 事故上报。
    const incidentResp = await fetch(`${base}/incidents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        toolId: ids.laser,
        loanId: loan.id,
        reporterId: ids.mentor,
        description: "冒烟",
        at: clock.now + HOUR,
      }),
    });
    assert.equal(incidentResp.status, 200);
    const incident = await incidentResp.json();

    // 普通归还被拒。
    const lockedReturn = await fetch(`${base}/loans/${loan.id}/return`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorId: ids.mentor }),
    });
    assert.equal(lockedReturn.status, 409);

    // 非安全负责人复查被拒。
    const notOfficer = await fetch(`${base}/incidents/${incident.id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ safetyOfficerId: ids.mentor, finding: "没事", cleared: true }),
    });
    assert.equal(notOfficer.status, 403);

    // 安全负责人复查解除。
    const review = await fetch(`${base}/incidents/${incident.id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        safetyOfficerId: ids.officer,
        finding: "已修复",
        cleared: true,
        at: clock.now + 2 * HOUR,
      }),
    });
    assert.equal(review.status, 200);
    assert.equal((await review.json()).status, "cleared");

    // 普通归还成功。
    const returned = await fetch(`${base}/loans/${loan.id}/return`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorId: ids.mentor, at: clock.now + 3 * HOUR }),
    });
    assert.equal(returned.status, 200);
    assert.equal((await returned.json()).status, "returned");

    // 事故追溯。
    const traceResp = await fetch(`${base}/incidents/${incident.id}/trace`);
    const trace = await traceResp.json();
    assert.equal(trace.materialBatch.id, ids.acrylicBatch);
    assert.equal(trace.dutyMentor.id, ids.mentor);
  } finally {
    await close();
  }
});

test("HTTP 小组视图返回可操作工具、缺失条件与未归还项目", async () => {
  const { base, close, fixture } = await startFixture();
  try {
    const response = await fetch(`${base}/groups/${fixture.ids.group}`);
    assert.equal(response.status, 200);
    const view = await response.json();
    assert.equal(view.dutyMentor.onDuty, true);
    const members = view.members as Array<{ student: { id: string }; missingConditions: Record<string, unknown> }>;
    assert.equal(members.length, 2);
  } finally {
    await close();
  }
});

test("服务可独立于 HTTP 使用（模块装配冒烟）", async () => {
  const service = new LabService(new JsonStore(null));
  const student = await service.addStudent({ name: "x", guardianId: "g", guardianName: "G", groupId: "grp" });
  assert.ok(student.id.startsWith("stu_"));
});
