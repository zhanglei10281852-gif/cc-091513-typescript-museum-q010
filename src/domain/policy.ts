import type { AdmissionContext } from "./policy-context.js";
import type { AdmissionDecision, AdmissionSnapshot, ConditionResult } from "./types.js";

/**
 * 准入判定：纯函数，不触碰存储。所有“当时依据”都在返回快照中冻结，
 * 业务服务负责在领用发生的同一事务里持久化该快照。
 */
export function evaluateAdmission(ctx: AdmissionContext): AdmissionDecision {
  const { now, tool, equipment, student, mentor, qualification, consent, materialRequired, materialBatch, activeNotices, requestedQuantity } = ctx;

  const conditions: ConditionResult[] = [];

  // 1. 设备未停用、未被事故锁定。
  const equipmentAvailable = equipment.status === "available";
  conditions.push({
    code: "equipment_available",
    label: "设备处于可用状态（未停用、未被事故锁定）",
    passed: equipmentAvailable,
    detail: equipmentAvailable
      ? `设备 ${equipment.id} 当前可用`
      : `设备 ${equipment.id} 状态为 ${equipment.status}${equipment.statusReason ? `：${equipment.statusReason}` : ""}`,
  });

  // 2. 无生效中的安全公告（公告一旦生效立即拒绝新领用）。
  const noticeClear = activeNotices.length === 0;
  conditions.push({
    code: "safety_notice_clear",
    label: "无生效中的安全公告",
    passed: noticeClear,
    detail: noticeClear
      ? "没有针对该工具或风险等级的生效公告"
      : `生效公告：${activeNotices.map((n) => `${n.id}（${n.title}）`).join("、")}`,
  });

  // 3. 培训与复认证：资质处于 active 且在有效期内。
  let qualPassed = false;
  let qualDetail: string;
  if (!qualification) {
    qualDetail = `缺少风险等级 ${tool.riskLevel} 的培训资质`;
  } else if (qualification.state === "training") {
    qualDetail = `培训尚未完成（培训版本 ${qualification.trainingVersion}）`;
  } else if (qualification.state === "suspended") {
    qualDetail = "资质已被暂停，需安全复查恢复";
  } else if (qualification.state === "expired" || qualification.validUntil <= now) {
    qualDetail = `资质已过期（有效期至 ${new Date(qualification.validUntil).toISOString()}），需复认证`;
  } else if (qualification.riskLevel !== tool.riskLevel) {
    qualDetail = `持有的是 ${qualification.riskLevel} 资质，不满足 ${tool.riskLevel} 要求`;
  } else {
    qualPassed = true;
    qualDetail = `资质有效，培训版本 ${qualification.trainingVersion}，有效期至 ${new Date(qualification.validUntil).toISOString()}`;
  }
  conditions.push({
    code: "qualification_active",
    label: "培训资质有效且已按要求复认证",
    passed: qualPassed,
    detail: qualDetail,
  });

  // 4. 当班导师：导师在该小组当班时段内。
  const assignment = mentor?.dutyAssignments.find(
    (a) => a.groupId === student.groupId && a.startsAt <= now && now < a.endsAt,
  ) ?? null;
  const mentorOnDuty = assignment !== null;
  conditions.push({
    code: "mentor_on_duty",
    label: "存在覆盖该实践小组当前时段的当班导师",
    passed: mentorOnDuty,
    detail: mentorOnDuty
      ? `当班导师 ${mentor!.id}（${mentor!.name}）值守至 ${new Date(assignment!.endsAt).toISOString()}`
      : `导师 ${ctx.mentorId} 当前不在小组 ${student.groupId} 的当班时段内`,
  });

  // 5. 监护授权：restricted 工具必须持有监护人有效授权。
  const consentRequired = tool.riskLevel === "restricted";
  let consentPassed: boolean;
  let consentDetail: string;
  if (!consentRequired) {
    consentPassed = true;
    consentDetail = `风险等级 ${tool.riskLevel} 不要求监护授权`;
  } else if (!consent) {
    consentPassed = false;
    consentDetail = "缺少监护人授权记录（耗材领用需监护人确认）";
  } else if (consent.revokedAt !== null) {
    consentPassed = false;
    consentDetail = `监护授权已被撤销（监护人 ${consent.guardianId}）`;
  } else if (consent.validUntil <= now) {
    consentPassed = false;
    consentDetail = `监护授权已于 ${new Date(consent.validUntil).toISOString()} 到期`;
  } else {
    consentPassed = true;
    consentDetail = `监护人 ${consent.guardianId} 授权有效至 ${new Date(consent.validUntil).toISOString()}`;
  }
  conditions.push({
    code: "guardian_consent_valid",
    label: "监护授权在有效期内（restricted 工具必需）",
    passed: consentPassed,
    detail: consentDetail,
  });

  // 6. 材料批次：登记过耗材的工具必须随领用记录有效批次。
  let batchPassed: boolean;
  let batchDetail: string;
  if (!materialRequired) {
    batchPassed = true;
    batchDetail = "该工具不涉及登记耗材，无需材料批次";
  } else if (!ctx.requestedBatchId) {
    batchPassed = false;
    batchDetail = "该工具领用必须登记材料批次";
  } else if (!materialBatch) {
    batchPassed = false;
    batchDetail = `材料批次 ${ctx.requestedBatchId} 不存在`;
  } else if (!materialBatch.active) {
    batchPassed = false;
    batchDetail = `材料批次 ${materialBatch.id} 已停用`;
  } else if (!materialBatch.toolIds.includes(tool.id)) {
    batchPassed = false;
    batchDetail = `材料批次 ${materialBatch.id} 与工具 ${tool.id} 不匹配`;
  } else {
    batchPassed = true;
    batchDetail = `材料批次 ${materialBatch.id}（${materialBatch.name}）有效且与工具匹配`;
  }
  conditions.push({
    code: "material_batch_valid",
    label: "材料批次有效并与工具匹配",
    passed: batchPassed,
    detail: batchDetail,
  });

  // 7. 库存下限：可用库存必须覆盖本次数量。
  const stockPassed = tool.stock >= requestedQuantity;
  conditions.push({
    code: "stock_available",
    label: "库存数量满足本次领用（不击穿库存下限）",
    passed: stockPassed,
    detail: `可用库存 ${tool.stock}，本次申请 ${requestedQuantity}`,
  });

  const admitted = conditions.every((c) => c.passed);

  const snapshot: AdmissionSnapshot = {
    decidedAt: now,
    toolId: tool.id,
    riskLevel: tool.riskLevel,
    studentId: student.id,
    qualification: {
      state: qualification?.state ?? "training",
      trainingVersion: qualification?.trainingVersion ?? "none",
      validUntil: qualification?.validUntil ?? 0,
      recertifiedAt: qualification?.recertifiedAt ?? null,
    },
    mentor: {
      mentorId: mentor?.id ?? ctx.mentorId,
      onDuty: mentorOnDuty,
      assignment,
    },
    guardianConsent: {
      required: consentRequired,
      consentId: consentRequired ? (consent?.id ?? null) : null,
      validUntil: consentRequired ? (consent?.validUntil ?? null) : null,
    },
    materialBatch: {
      required: materialRequired,
      batchId: materialRequired ? (materialBatch?.id ?? ctx.requestedBatchId ?? null) : null,
      active: materialRequired ? (materialBatch?.active ?? false) : true,
    },
    equipment: {
      equipmentId: equipment.id,
      status: equipment.status,
    },
    safetyNotices: activeNotices.map((n) => n.id),
    conditions,
    admitted,
  };

  return { admitted, conditions, snapshot };
}
