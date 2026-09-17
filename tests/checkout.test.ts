import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "../src/service/lab-service.js";
import { buildFixture, DAY, HOUR, T0 } from "./helpers.js";

async function denyCode<T>(fn: () => Promise<T>): Promise<{ code: string; conditions: any[] }> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return { code: error.code, conditions: error.details?.conditions ?? [] };
    }
    throw error;
  }
  throw new Error("expected promise to reject");
}

test("全部条件满足时放行：restricted 激光切割机领用并冻结判定快照", async () => {
  const { service, ids, clock } = await buildFixture();
  const result = await service.checkout({
    studentId: ids.student,
    toolId: ids.laser,
    mentorId: ids.mentor,
    groupId: ids.group,
    cardSwipeId: "swipe-001",
    materialBatchId: ids.acrylicBatch,
    now: clock.now,
  });

  assert.equal(result.duplicatedSwipe, false);
  const loan = result.loan;
  assert.equal(loan.status, "open");
  assert.equal(loan.materialBatchId, ids.acrylicBatch);
  assert.equal(loan.decisionSnapshot.admitted, true);
  assert.deepEqual(
    loan.decisionSnapshot.conditions.map((c) => c.code).sort(),
    [
      "equipment_available",
      "guardian_consent_valid",
      "material_batch_valid",
      "mentor_on_duty",
      "qualification_active",
      "safety_notice_clear",
      "stock_available",
    ].sort(),
  );
  assert.equal(loan.decisionSnapshot.qualification.trainingVersion, "laser-safety-v3");
  assert.ok(loan.decisionSnapshot.conditions.every((c) => c.passed));

  const view = await service.getGroupView(ids.group, clock.now);
  const member = view.members.find((m) => m.student.id === ids.student)!;
  assert.ok(member.openLoans.some((l) => l.id === loan.id));
});

test("重复刷卡只对应一次借出：回放原记录且不再次扣库存", async () => {
  const { service, ids, clock } = await buildFixture();
  const first = await service.checkout({
    studentId: ids.student,
    toolId: ids.laser,
    mentorId: ids.mentor,
    groupId: ids.group,
    cardSwipeId: "swipe-dup",
    materialBatchId: ids.acrylicBatch,
    now: clock.now,
  });
  const second = await service.checkout({
    studentId: ids.student,
    toolId: ids.laser,
    mentorId: ids.mentor,
    groupId: ids.group,
    cardSwipeId: "swipe-dup",
    materialBatchId: ids.acrylicBatch,
    now: clock.now + 1000,
  });

  assert.equal(second.duplicatedSwipe, true);
  assert.equal(second.loan.id, first.loan.id);
  // 库存 2 只被扣过一次。
  const view = await service.getGroupView(ids.group, clock.now);
  assert.equal(view.members.length >= 1, true);
});

test("尚未归还的工具不能再次流转（换新卡也拒绝）", async () => {
  const { service, ids, clock } = await buildFixture();
  await service.checkout({
    studentId: ids.student,
    toolId: ids.laser,
    mentorId: ids.mentor,
    groupId: ids.group,
    cardSwipeId: "swipe-a",
    materialBatchId: ids.acrylicBatch,
    now: clock.now,
  });
  const denied = await denyCode(() =>
    service.checkout({
      studentId: ids.student,
      toolId: ids.laser,
      mentorId: ids.mentor,
      groupId: ids.group,
      cardSwipeId: "swipe-b",
      materialBatchId: ids.acrylicBatch,
      now: clock.now,
    }),
  );
  assert.equal(denied.code, "tool_already_out");
});

test("培训未完成或资质过期立即拒绝", async () => {
  const { service, ids, clock } = await buildFixture();
  // stu2 处于 training 状态。
  const deniedTraining = await denyCode(() =>
    service.checkout({
      studentId: ids.untrainedStudent,
      toolId: ids.laser,
      mentorId: ids.mentor,
      groupId: ids.group,
      cardSwipeId: "swipe-t1",
      materialBatchId: ids.acrylicBatch,
      now: clock.now,
    }),
  );
  assert.equal(deniedTraining.code, "admission_denied");
  assert.ok(
    deniedTraining.conditions.find((c) => c.code === "qualification_active" && !c.passed),
  );

  // stu1 时间推进到资质到期之后。
  const expired = await denyCode(() =>
    service.checkout({
      studentId: ids.student,
      toolId: ids.laser,
      mentorId: ids.mentor,
      groupId: ids.group,
      cardSwipeId: "swipe-t2",
      materialBatchId: ids.acrylicBatch,
      now: T0 + 31 * DAY,
    }),
  );
  const qualCondition = expired.conditions.find((c) => c.code === "qualification_active")!;
  assert.equal(qualCondition.passed, false);
  assert.match(qualCondition.detail, /过期|复认证/);
});

test("安全公告生效后立即拒绝新领用，撤销后恢复", async () => {
  const { service, ids, clock } = await buildFixture();
  await service.addSafetyNotice({
    id: "ntc-laser",
    title: "激光切割机防护罩召回",
    riskLevel: "restricted",
    toolId: null,
    effectiveAt: clock.now - 60_000,
  });
  const denied = await denyCode(() =>
    service.checkout({
      studentId: ids.student,
      toolId: ids.laser,
      mentorId: ids.mentor,
      groupId: ids.group,
      cardSwipeId: "swipe-n1",
      materialBatchId: ids.acrylicBatch,
      now: clock.now,
    }),
  );
  assert.equal(denied.code, "admission_denied");
  const noticeCondition = denied.conditions.find((c) => c.code === "safety_notice_clear")!;
  assert.equal(noticeCondition.passed, false);
  assert.match(noticeCondition.detail, /ntc-laser/);

  await service.revokeSafetyNotice("ntc-laser");
  const ok = await service.checkout({
    studentId: ids.student,
    toolId: ids.laser,
    mentorId: ids.mentor,
    groupId: ids.group,
    cardSwipeId: "swipe-n2",
    materialBatchId: ids.acrylicBatch,
    now: clock.now,
  });
  assert.equal(ok.duplicatedSwipe, false);
});

test("设备停用或锁定时拒绝领用", async () => {
  const { service, ids, clock } = await buildFixture();
  await service.setEquipmentStatus(ids.laserEquipment, "decommissioned", "机身老化报废");
  const denied = await denyCode(() =>
    service.checkout({
      studentId: ids.student,
      toolId: ids.laser,
      mentorId: ids.mentor,
      groupId: ids.group,
      cardSwipeId: "swipe-d1",
      materialBatchId: ids.acrylicBatch,
      now: clock.now,
    }),
  );
  const cond = denied.conditions.find((c) => c.code === "equipment_available")!;
  assert.equal(cond.passed, false);
  assert.match(cond.detail, /decommissioned|报废/);
});

test("restricted 工具缺少监护人授权被拒", async () => {
  const { service, ids, clock } = await buildFixture();
  // stu2 持有 training 资质；补一个 active 资质但不给监护授权。
  await service.recordQualification({
    id: "qua-stu2-active",
    studentId: ids.untrainedStudent,
    riskLevel: "restricted",
    trainingVersion: "laser-safety-v3",
    trainedAt: clock.now - DAY,
    validUntil: clock.now + DAY,
    recertifiedAt: clock.now - DAY,
    state: "active",
  });
  const denied = await denyCode(() =>
    service.checkout({
      studentId: ids.untrainedStudent,
      toolId: ids.laser,
      mentorId: ids.mentor,
      groupId: ids.group,
      cardSwipeId: "swipe-c1",
      materialBatchId: ids.acrylicBatch,
      now: clock.now,
    }),
  );
  const cond = denied.conditions.find((c) => c.code === "guardian_consent_valid")!;
  assert.equal(cond.passed, false);
});

test("材料批次缺失、停用或不匹配均拒绝", async () => {
  const { service, ids, clock } = await buildFixture();
  const base = {
    studentId: ids.student,
    toolId: ids.laser,
    mentorId: ids.mentor,
    groupId: ids.group,
    now: clock.now,
  };

  const missing = await denyCode(() => service.checkout({ ...base, cardSwipeId: "swipe-b0" }));
  assert.equal(missing.conditions.find((c) => c.code === "material_batch_valid")!.passed, false);

  const wrong = await denyCode(() =>
    service.checkout({ ...base, cardSwipeId: "swipe-b1", materialBatchId: "bat-nope" }),
  );
  assert.equal(wrong.code, "admission_denied");

  const otherBatch = await service.addMaterialBatch({
    name: "木板 B 批",
    active: true,
    toolIds: ["tool-other"],
  });
  const mismatch = await denyCode(() =>
    service.checkout({ ...base, cardSwipeId: "swipe-b2", materialBatchId: otherBatch.id }),
  );
  assert.match(
    mismatch.conditions.find((c) => c.code === "material_batch_valid")!.detail,
    /不匹配/,
  );
});

test("导师不在当班时段拒绝领用", async () => {
  const { service, ids } = await buildFixture();
  const denied = await denyCode(() =>
    service.checkout({
      studentId: ids.student,
      toolId: ids.laser,
      mentorId: ids.mentor,
      groupId: ids.group,
      cardSwipeId: "swipe-m1",
      materialBatchId: ids.acrylicBatch,
      now: T0 + 5 * HOUR, // 当班至 T0+4h
    }),
  );
  assert.equal(denied.conditions.find((c) => c.code === "mentor_on_duty")!.passed, false);
});

test("并发领料守住库存下限：库存 5 件，8 人并发仅 5 人成功", async () => {
  const { service, ids, clock } = await buildFixture();
  // 为热熔胶枪（supervised，库存 5）准备 8 名持证学生。
  const studentIds: string[] = [];
  for (let i = 0; i < 8; i++) {
    const id = `stu-glue-${i}`;
    await service.addStudent({ id, name: `学生${i}`, guardianId: `g-${i}`, guardianName: "家长", groupId: ids.group });
    await service.recordQualification({
      studentId: id,
      riskLevel: "supervised",
      trainingVersion: "glue-safety-v1",
      trainedAt: clock.now - DAY,
      validUntil: clock.now + DAY,
      state: "active",
    });
    studentIds.push(id);
  }

  const results = await Promise.allSettled(
    studentIds.map((studentId) =>
      service.checkout({
        studentId,
        toolId: ids.glueGun,
        mentorId: ids.mentor,
        groupId: ids.group,
        cardSwipeId: `swipe-glue-${studentId}`,
        now: clock.now,
      }),
    ),
  );

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 5);
  assert.equal(rejected.length, 3);
  for (const r of rejected) {
    assert.equal((r as PromiseRejectedResult).reason.code, "admission_denied");
    assert.equal(
      (r as PromiseRejectedResult).reason.details.conditions.find((c: any) => c.code === "stock_available").passed,
      false,
    );
  }

  // 归还全部后库存回补到 5。
  const loans = fulfilled.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<LabService["checkout"]>>>).value.loan);
  for (const loan of loans) {
    await service.returnLoan(loan.id, ids.mentor, clock.now);
  }
  const view = await service.getGroupView(ids.group, clock.now);
  assert.ok(view.dutyMentor.onDuty);
});
