import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ApiError, LabService } from "../src/service/lab-service.js";
import { JsonStore } from "../src/store/store.js";

test("数据落盘后重启：借用记录与判定快照可恢复", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lab-store-"));
  try {
    const file = join(dir, "store.json");

    const store1 = new JsonStore(file);
    const service1 = new LabService(store1);
    const groupId = "g";
    const student = await service1.addStudent({ name: "小秦", guardianId: "gd", guardianName: "家长", groupId });
    const equipment = await service1.addEquipment({ name: "设备" });
    const tool = await service1.addTool({ name: "工具", riskLevel: "basic", equipmentId: equipment.id, stock: 1 });
    const mentor = await service1.addMentor({ name: "导师", role: "mentor", dutyAssignments: [] });
    await service1.recordQualification({
      studentId: student.id,
      riskLevel: "basic",
      trainingVersion: "v1",
      trainedAt: Date.now() - 1000,
      validUntil: Date.now() + 10_000,
      state: "active",
    });
    // 导师不在当班，预期被拒；拒绝不应落半成品数据。
    await assert.rejects(
      service1.checkout({
        studentId: student.id,
        toolId: tool.id,
        mentorId: mentor.id,
        groupId,
        cardSwipeId: "card-x",
      }),
      (error: unknown) => error instanceof ApiError && error.code === "admission_denied",
    );

    // 重启进程（新 store 实例）。
    const store2 = new JsonStore(file);
    const service2 = new LabService(store2);
    const groups = await service2.getGroupView(groupId);
    assert.equal(groups.members[0]?.student.id, student.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mutate 临界区串行：并发自增计数不丢失更新", async () => {
  const store = new JsonStore(null);
  await store.mutate((data) => {
    data.tools.push({ id: "counter", name: "c", riskLevel: "basic", equipmentId: "e", stock: 0 });
  });
  await Promise.all(
    Array.from({ length: 50 }, () =>
      store.mutate((data) => {
        const tool = data.tools[0]!;
        const current = tool.stock;
        // 让出事件循环，放大交错风险。
        return new Promise<number>((resolve) => {
          setImmediate(() => {
            tool.stock = current + 1;
            resolve(tool.stock);
          });
        });
      }),
    ),
  );
  const finalStock = await store.read((data) => data.tools[0]!.stock);
  assert.equal(finalStock, 50);
});
