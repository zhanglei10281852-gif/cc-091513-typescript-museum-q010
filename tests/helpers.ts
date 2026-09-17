import { LabService } from "../src/service/lab-service.js";
import { JsonStore } from "../src/store/store.js";

export const T0 = Date.parse("2026-09-17T08:00:00Z");
export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;

export interface Fixture {
  service: LabService;
  clock: { now: number };
  ids: {
    group: string;
    student: string;
    untrainedStudent: string;
    mentor: string;
    officer: string;
    laserEquipment: string;
    laser: string;
    glueEquipment: string;
    glueGun: string;
    acrylicBatch: string;
  };
}

/** 搭建内存数据：1 名持 restricted 有效资质+监护授权的学生、激光切割机与胶枪。 */
export async function buildFixture(): Promise<Fixture> {
  const clock = { now: T0 };
  const service = new LabService(new JsonStore(null), { now: () => clock.now });

  const group = "g1";
  const student = await service
    .addStudent({ id: "stu1", name: "小林", guardianId: "gdn1", guardianName: "林妈妈", groupId: group })
    .then((s) => s.id);
  await service.addStudent({ id: "stu2", name: "小周", guardianId: "gdn2", guardianName: "周爸爸", groupId: group });
  const mentor = (
    await service.addMentor({
      id: "men1",
      name: "王老师",
      role: "mentor",
      dutyAssignments: [{ groupId: group, startsAt: T0 - HOUR, endsAt: T0 + 4 * HOUR }],
    })
  ).id;
  const officer = (await service.addSafetyOfficer({ id: "saf1", name: "陈安全" })).id;

  const laserEquipment = (await service.addEquipment({ id: "eqp-laser", name: "激光切割机 #1" })).id;
  const laser = (
    await service.addTool({ id: "tool-laser", name: "激光切割机", riskLevel: "restricted", equipmentId: laserEquipment, stock: 2 })
  ).id;
  const glueEquipment = (await service.addEquipment({ id: "eqp-glue", name: "热熔胶枪柜" })).id;
  const glueGun = (
    await service.addTool({ id: "tool-glue", name: "热熔胶枪", riskLevel: "supervised", equipmentId: glueEquipment, stock: 5 })
  ).id;

  const acrylicBatch = (
    await service.addMaterialBatch({ id: "bat-acrylic", name: "亚克力板 A 批", active: true, toolIds: [laser] })
  ).id;

  await service.recordQualification({
    id: "qua-laser-stu1",
    studentId: student,
    riskLevel: "restricted",
    trainingVersion: "laser-safety-v3",
    trainedAt: T0 - 30 * DAY,
    validUntil: T0 + 30 * DAY,
    recertifiedAt: T0 - 30 * DAY,
    state: "active",
  });
  await service.recordQualification({
    studentId: "stu2",
    riskLevel: "restricted",
    trainingVersion: "laser-safety-v3",
    trainedAt: T0 - 2 * DAY,
    validUntil: T0 + 30 * DAY,
    state: "training",
  });
  await service.grantConsent({
    id: "con-stu1-restricted",
    studentId: student,
    riskLevel: "restricted",
    validUntil: T0 + 30 * DAY,
  });

  return {
    service,
    clock,
    ids: {
      group,
      student,
      untrainedStudent: "stu2",
      mentor,
      officer,
      laserEquipment,
      laser,
      glueEquipment,
      glueGun,
      acrylicBatch,
    },
  };
}
