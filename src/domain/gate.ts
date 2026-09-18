import type {
  ConsentSnapshot,
  DecisionCheck,
  DecisionSnapshot,
  MaterialSnapshot,
  MentorDutySnapshot,
  NoticeSnapshot,
  State,
  Tool,
  TrainingSnapshot,
} from "./types.js";

export interface GateInput {
  state: State;
  now: number;
  personId: string;
  toolId: string;
  /** 请求指定的当班导师；缺省时由小组在班导师中解析。 */
  mentorId?: string | null;
  materialBatchId?: string | null;
  /**
   * 能力视图模式：跳过库存下限与本人未归还等实例态检查，
   * 只衡量“该成员是否具备领用资格”。供导师小组总览使用。
   */
  capabilityOnly?: boolean;
}

export interface GateResult {
  approved: boolean;
  snapshot: DecisionSnapshot;
  mentorId: string | null;
  guardianId: string | null;
  materialBatchId: string | null;
}

function check(code: DecisionCheck["code"], passed: boolean, detail?: string): DecisionCheck {
  return { code, passed, ...(detail === undefined ? {} : { detail }) };
}

/** 统计该工具当前未归还（且未因事故锁定之外）的借出数量。 */
export function openLoansForTool(state: State, toolId: string): number {
  return state.loans.filter((loan) => loan.toolId === toolId && loan.returnedAt === null).length;
}

export function hasOpenLoan(state: State, personId: string, toolId: string): boolean {
  return state.loans.some(
    (loan) => loan.personId === personId && loan.toolId === toolId && loan.returnedAt === null,
  );
}

/** 生效中的安全公告：已生效且未解除。公告生效后立即拒绝新领用。 */
function effectiveNotices(state: State, tool: Tool, now: number): NoticeSnapshot[] {
  return state.safetyNotices
    .filter(
      (notice) =>
        (notice.toolId === null || notice.toolId === tool.id) &&
        notice.effectiveAt <= now &&
        (notice.liftedAt === null || notice.liftedAt > now),
    )
    .map((notice) => ({
      id: notice.id,
      title: notice.title,
      effectiveAt: notice.effectiveAt,
    }));
}

/**
 * 准入判定。纯函数：不修改状态，只产出当时的条件快照。
 * 风险等级策略：
 *  - basic：仅需有效资质；
 *  - supervised：需小组当班导师；
 *  - restricted：需当班导师 + 监护授权；
 * 此外工具可通过 requiresGuardian / requiresMaterial 追加要求。
 */
export function evaluateGate(input: GateInput): GateResult {
  const { state, now, personId, toolId } = input;
  const checks: DecisionCheck[] = [];

  const person = state.people[personId];
  const tool = state.tools[toolId];

  if (!person) {
    return {
      approved: false,
      snapshot: {
        decidedAt: now,
        riskLevel: tool?.riskLevel ?? "basic",
        toolStatus: tool?.status ?? "active",
        stock: { total: tool?.stock ?? 0, reserved: 0, available: tool?.stock ?? 0 },
        training: null,
        mentorDuty: null,
        guardianConsent: null,
        materialBatch: null,
        safetyNotices: [],
        checks: [check("qualification_present", false, "领用人不存在")],
        approved: false,
      },
      mentorId: null,
      guardianId: null,
      materialBatchId: null,
    };
  }
  if (!tool) {
    return {
      approved: false,
      snapshot: {
        decidedAt: now,
        riskLevel: "basic",
        toolStatus: "decommissioned",
        stock: { total: 0, reserved: 0, available: 0 },
        training: null,
        mentorDuty: null,
        guardianConsent: null,
        materialBatch: null,
        safetyNotices: [],
        checks: [check("tool_operational", false, "工具不存在")],
        approved: false,
      },
      mentorId: null,
      guardianId: null,
      materialBatchId: null,
    };
  }

  // 1. 设备停用状态。
  checks.push(
    check("tool_operational", tool.status === "active", tool.status === "active" ? undefined : "设备已停用"),
  );

  // 2. 安全公告。
  const notices = effectiveNotices(state, tool, now);
  checks.push(
    check(
      "safety_notice_clear",
      notices.length === 0,
      notices.length === 0 ? undefined : `${notices.length} 条生效中安全公告`,
    ),
  );

  // 3-5. 培训与复认证。
  const qualification = state.qualifications.find(
    (q) => q.personId === personId && q.toolId === toolId,
  );
  const training: TrainingSnapshot | null = qualification
    ? {
        state: qualification.state,
        trainingVersion: qualification.trainingVersion,
        certifiedAt: qualification.certifiedAt,
        expiresAt: qualification.expiresAt,
      }
    : null;
  checks.push(check("qualification_present", qualification !== undefined));
  checks.push(
    check(
      "qualification_state_active",
      qualification?.state === "active",
      qualification ? `资质状态: ${qualification.state}` : undefined,
    ),
  );
  const expired = qualification !== undefined && qualification.expiresAt <= now;
  checks.push(
    check(
      "qualification_not_expired",
      qualification !== undefined && !expired,
      qualification ? (expired ? `已于 ${new Date(qualification.expiresAt).toISOString()} 过期` : undefined) : undefined,
    ),
  );

  // 6-7. 当班导师（basic 工具不要求；其余风险等级要求本组导师当班）。
  const mentorRequired = tool.riskLevel !== "basic";
  const group = person.groupId ? state.groups[person.groupId] : undefined;
  let mentorId = input.mentorId ?? null;
  let mentorDutySnapshot: MentorDutySnapshot | null = null;

  if (mentorRequired) {
    if (!group) {
      checks.push(check("mentor_in_group", false, "领用人不属于任何实践小组"));
      checks.push(check("mentor_on_duty", false, "无小组可排班"));
    } else {
      if (!mentorId) {
        const onDuty = state.duties.find(
          (duty) =>
            group.mentorIds.includes(duty.mentorId) &&
            duty.startAt <= now &&
            (duty.endAt === null || duty.endAt > now) &&
            (duty.groupId === null || duty.groupId === group.id),
        );
        mentorId = onDuty?.mentorId ?? null;
      }
      const mentorInGroup = mentorId !== null && group.mentorIds.includes(mentorId);
      checks.push(check("mentor_in_group", mentorInGroup));
      const duty =
        mentorId !== null
          ? state.duties.find(
              (d) =>
                d.mentorId === mentorId &&
                d.startAt <= now &&
                (d.endAt === null || d.endAt > now) &&
                (d.groupId === null || d.groupId === group.id),
            )
          : undefined;
      checks.push(check("mentor_on_duty", duty !== undefined));
      if (mentorInGroup && duty) {
        mentorDutySnapshot = {
          mentorId: duty.mentorId,
          dutyId: duty.id,
          groupId: duty.groupId,
          startAt: duty.startAt,
        };
      }
    }
  }

  // 8. 监护授权（restricted 工具或工具显式要求）。
  const guardianRequired = tool.requiresGuardian || tool.riskLevel === "restricted";
  const consentRecord = guardianRequired
    ? state.consents.find(
        (consent) =>
          consent.studentId === personId &&
          consent.toolId === toolId &&
          consent.grantedAt <= now &&
          consent.expiresAt > now,
      )
    : undefined;
  const consentSnapshot: ConsentSnapshot | null = consentRecord
    ? {
        id: consentRecord.id,
        guardianId: consentRecord.guardianId,
        grantedAt: consentRecord.grantedAt,
        expiresAt: consentRecord.expiresAt,
      }
    : null;
  if (guardianRequired) {
    checks.push(
      check(
        "guardian_consent",
        consentRecord !== undefined,
        consentRecord === undefined ? "缺少有效监护人确认" : undefined,
      ),
    );
  }

  // 9. 材料批次（属于领用当次的供应条件，不计入成员“可操作范围”能力视图）。
  const batch = tool.requiresMaterial && input.materialBatchId
    ? state.materialBatches[input.materialBatchId]
    : undefined;
  let materialSnapshot: MaterialSnapshot | null = null;
  if (tool.requiresMaterial && !input.capabilityOnly) {
    if (!input.materialBatchId) {
      checks.push(check("material_batch", false, "未指定材料批次"));
    } else if (!batch) {
      checks.push(check("material_batch", false, "材料批次不存在"));
    } else {
      const batchAllowsTool = batch.toolIds === null || batch.toolIds.includes(toolId);
      const batchHealthy = batch.status === "ok" && batch.quantity >= 1;
      materialSnapshot = {
        id: batch.id,
        name: batch.name,
        status: batch.status,
        quantity: batch.quantity,
        toolIds: batch.toolIds,
      };
      checks.push(
        check(
          "material_batch",
          batchAllowsTool && batchHealthy,
          !batchAllowsTool
            ? "批次不适用于该工具"
            : batch.status !== "ok"
              ? `批次状态: ${batch.status}`
              : batch.quantity < 1
                ? "材料库存不足"
                : undefined,
        ),
      );
    }
  }

  // 10. 工具库存下限（并发领料在服务层的同步临界区内二次确认）。
  const reserved = openLoansForTool(state, toolId);
  if (!input.capabilityOnly) {
    const inventoryOk = reserved < tool.stock;
    checks.push(
      check(
        "tool_inventory",
        inventoryOk,
        inventoryOk ? undefined : `库存下限: ${reserved}/${tool.stock} 已全部借出`,
      ),
    );

    // 11. 本人未归还项目：尚未归还的工具不能再次流转。
    const alreadyOpen = hasOpenLoan(state, personId, toolId);
    checks.push(
      check("no_open_loan", !alreadyOpen, alreadyOpen ? "存在尚未归还的同工具借出" : undefined),
    );
  }

  const approved = checks.every((c) => c.passed);
  const snapshot: DecisionSnapshot = {
    decidedAt: now,
    riskLevel: tool.riskLevel,
    toolStatus: tool.status,
    stock: { total: tool.stock, reserved, available: Math.max(tool.stock - reserved, 0) },
    training,
    mentorDuty: mentorDutySnapshot,
    guardianConsent: consentSnapshot,
    materialBatch: materialSnapshot,
    safetyNotices: notices,
    checks,
    approved,
  };

  return {
    approved,
    snapshot,
    mentorId,
    guardianId: consentRecord?.guardianId ?? null,
    materialBatchId: batch?.id ?? null,
  };
}
