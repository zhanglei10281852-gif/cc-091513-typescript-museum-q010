import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "../src/service/lab-service.js";
import { buildFixture, HOUR } from "./helpers.js";

async function expectError<T>(fn: () => Promise<T>, code: string): Promise<ApiError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected error ${code}`);
}

async function checkoutLaser(fixture: Awaited<ReturnType<typeof buildFixture>>, swipe: string) {
  const { service, ids, clock } = fixture;
  return service.checkout({
    studentId: ids.student,
    toolId: ids.laser,
    mentorId: ids.mentor,
    groupId: ids.group,
    cardSwipeId: swipe,
    materialBatchId: ids.acrylicBatch,
    now: clock.now,
  });
}

test("事故上报锁定设备与借用记录，新领用立即被拒", async () => {
  const fixture = await buildFixture();
  const { service, ids, clock } = fixture;
  const { loan } = await checkoutLaser(fixture, "swipe-i1");

  // 另一名资质、授权齐全的学生：事故前本可领用。
  await service.addStudent({ id: "stu3", name: "小吴", guardianId: "gdn3", guardianName: "吴妈妈", groupId: ids.group });
  await service.recordQualification({
    studentId: "stu3",
    riskLevel: "restricted",
    trainingVersion: "laser-safety-v3",
    trainedAt: clock.now - HOUR,
    validUntil: clock.now + 30 * 24 * 3600 * 1000,
    recertifiedAt: clock.now - HOUR,
    state: "active",
  });
  await service.grantConsent({ studentId: "stu3", riskLevel: "restricted", validUntil: clock.now + 30 * 24 * 3600 * 1000 });

  const incident = await service.reportIncident({
    toolId: ids.laser,
    loanId: loan.id,
    reporterId: ids.mentor,
    description: "切割时冒烟",
    at: clock.now + HOUR,
  });
  assert.equal(incident.status, "open");
  assert.deepEqual(incident.lockedLoanIds, [loan.id]);
  assert.equal(incident.trainingVersion, "laser-safety-v3");
  assert.equal(incident.materialBatchId, ids.acrylicBatch);

  // 借用记录进入 locked；普通归还不能解除事故锁定。
  await expectError(
    () => service.returnLoan(loan.id, ids.mentor, clock.now + 2 * HOUR),
    "loan_locked_by_incident",
  );

  // 设备锁定后，其他合格学生的新领用被设备条件拦下。
  const denied = await expectError(
    () =>
      service.checkout({
        studentId: "stu3",
        toolId: ids.laser,
        mentorId: ids.mentor,
        groupId: ids.group,
        cardSwipeId: "swipe-i2",
        materialBatchId: ids.acrylicBatch,
        now: clock.now + HOUR,
      }),
    "admission_denied",
  );
  assert.ok(denied.details?.conditions.some((c) => c.code === "equipment_available" && !c.passed));
});

test("事故锁定独立于普通归还：只有安全负责人复查通过才能解除", async () => {
  const fixture = await buildFixture();
  const { service, ids, clock } = fixture;
  const { loan } = await checkoutLaser(fixture, "swipe-r1");
  const incident = await service.reportIncident({
    toolId: ids.laser,
    loanId: loan.id,
    reporterId: ids.mentor,
    description: "护罩碎裂",
    at: clock.now + HOUR,
  });

  // 非安全负责人不能复查。
  await expectError(
    () =>
      service.reviewIncident({
        incidentId: incident.id,
        safetyOfficerId: ids.mentor,
        finding: "看起来没事",
        cleared: true,
        at: clock.now + 2 * HOUR,
      }),
    "not_safety_officer",
  );

  // 复查未通过：设备维持锁定。
  let reviewed = await service.reviewIncident({
    incidentId: incident.id,
    safetyOfficerId: ids.officer,
    finding: "需要更换护罩",
    cleared: false,
    at: clock.now + 2 * HOUR,
  });
  assert.equal(reviewed.status, "reviewed");
  await expectError(() => checkoutLaser(fixture, "swipe-r2"), "tool_already_out");

  // 复查通过：设备解锁，被锁借用回到 open，再走普通归还入库。
  reviewed = await service.reviewIncident({
    incidentId: incident.id,
    safetyOfficerId: ids.officer,
    finding: "护罩已更换，测试合格",
    cleared: true,
    at: clock.now + 3 * HOUR,
  });
  assert.equal(reviewed.status, "cleared");
  assert.equal(reviewed.review?.safetyOfficerId, ids.officer);

  // 该学生归还后才能再次领用。
  const returned = await service.returnLoan(loan.id, ids.mentor, clock.now + 3 * HOUR);
  assert.equal(returned.status, "returned");
  const again = await checkoutLaser(fixture, "swipe-r3");
  assert.equal(again.duplicatedSwipe, false);
});

test("事故追溯一路串到培训版本、材料批次与值班责任人", async () => {
  const fixture = await buildFixture();
  const { service, ids, clock } = fixture;
  const { loan } = await checkoutLaser(fixture, "swipe-trace");
  const incident = await service.reportIncident({
    toolId: ids.laser,
    loanId: loan.id,
    reporterId: ids.mentor,
    description: "参数异常导致烧穿",
    at: clock.now + HOUR,
  });

  const trace = await service.getIncidentTrace(incident.id);
  assert.equal(trace.incident.id, incident.id);
  assert.equal(trace.loan?.id, loan.id);
  assert.equal(trace.loan?.decisionSnapshot.qualification.trainingVersion, "laser-safety-v3");
  assert.equal(trace.trainingHistory[0]?.trainingVersion, "laser-safety-v3");
  assert.equal(trace.materialBatch?.id, ids.acrylicBatch);
  assert.equal(trace.dutyMentor?.id, ids.mentor);
  assert.equal(trace.student?.id, ids.student);
  assert.equal(trace.equipment?.id, ids.laserEquipment);
  // 快照保留了领用当时的导师当班安排。
  assert.equal(trace.loan?.decisionSnapshot.mentor.onDuty, true);
});

test("导师打开小组视图：成员可操作范围、缺失条件与未归还项目", async () => {
  const fixture = await buildFixture();
  const { service, ids, clock } = fixture;
  const { loan } = await checkoutLaser(fixture, "swipe-g1");

  const view = await service.getGroupView(ids.group, clock.now);
  assert.equal(view.dutyMentor.onDuty, true);
  assert.equal(view.dutyMentor.mentorId, ids.mentor);

  const stu1 = view.members.find((m) => m.student.id === ids.student)!;
  // stu1 持有激光机（未归还），人员侧条件满足；胶枪为 supervised 她没有对应资质
  assert.ok(stu1.openLoans.some((l) => l.id === loan.id));
  assert.ok(stu1.missingConditions[ids.glueGun]?.some((c) => c.code === "qualification_active"));

  const stu2 = view.members.find((m) => m.student.id === ids.untrainedStudent)!;
  const laserMissing = stu2.missingConditions[ids.laser]!;
  assert.ok(laserMissing.some((c) => c.code === "qualification_active"));
  assert.ok(laserMissing.some((c) => c.code === "guardian_consent_valid"));
  assert.equal(stu2.operableTools.includes(ids.laser), false);
});

test("无当班导师时小组视图标记 onDuty=false 且全员缺少导师条件", async () => {
  const fixture = await buildFixture();
  const { service, ids } = fixture;
  const view = await service.getGroupView(ids.group, clock() + 5 * HOUR);
  assert.equal(view.dutyMentor.onDuty, false);
  for (const member of view.members) {
    for (const conditions of Object.values(member.missingConditions)) {
      assert.ok(conditions.some((c) => c.code === "mentor_on_duty"));
    }
  }

  function clock(): number {
    return fixture.clock.now;
  }
});
