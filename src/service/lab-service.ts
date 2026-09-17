import type {
  AdmissionSnapshot,
  CheckoutEventRecord,
  CheckoutRequest,
  ConditionResult,
  Equipment,
  GuardianConsent,
  Incident,
  IncidentReview,
  Loan,
  MaterialBatch,
  Mentor,
  Qualification,
  SafetyNotice,
  SafetyOfficer,
  Student,
  Timestamp,
  Tool,
} from "../domain/types.js";
import { evaluateAdmission } from "../domain/policy.js";
import type { JsonStore, StoreData } from "./store.js";

export class ApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: { conditions?: ConditionResult[] };

  constructor(
    code: string,
    statusCode: number,
    message: string,
    details?: { conditions?: ConditionResult[] },
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export interface CheckoutResult {
  loan: Loan;
  /** true 表示该卡刷过且已产生过借出，本次为幂等回放，不重复出库。 */
  duplicatedSwipe: boolean;
}

export interface GroupMemberView {
  student: Student;
  /** 当前可直接领用的工具 id。 */
  operableTools: string[];
  /** 工具 -> 未满足条件明细。 */
  missingConditions: Record<string, ConditionResult[]>;
  /** 未归还（含事故锁定）借用。 */
  openLoans: Loan[];
}

export interface GroupView {
  groupId: string;
  at: Timestamp;
  dutyMentor: { mentorId: string; name: string; onDuty: boolean };
  members: GroupMemberView[];
}

export interface IncidentTrace {
  incident: Incident;
  loan: (Loan & { snapshot: AdmissionSnapshot }) | null;
  trainingHistory: Qualification[];
  materialBatch: MaterialBatch | null;
  dutyMentor: Mentor | null;
  student: Student | null;
  equipment: Equipment | null;
}

let sequence = 0;
function newId(prefix: string, now: Timestamp): string {
  sequence = (sequence + 1) % 1_000_000;
  return `${prefix}_${now.toString(36)}${sequence.toString(36).padStart(3, "0")}${Math.random().toString(36).slice(2, 6)}`;
}

export interface LabServiceOptions {
  now?: () => Timestamp;
}

export class LabService {
  private readonly now: () => Timestamp;
  private readonly store: JsonStore;

  constructor(store: JsonStore, options: LabServiceOptions = {}) {
    this.store = store;
    this.now = options.now ?? (() => Date.now());
  }

  // ---------- 基础数据维护（管理员/排课侧） ----------

  async addStudent(input: Omit<Student, "id"> & { id?: string }): Promise<Student> {
    return this.store.mutate((data) => {
      const student: Student = {
        id: input.id ?? newId("stu", this.now()),
        name: input.name,
        guardianId: input.guardianId,
        guardianName: input.guardianName,
        groupId: input.groupId,
      };
      data.students.push(student);
      return student;
    });
  }

  async addMentor(input: Omit<Mentor, "id"> & { id?: string }): Promise<Mentor> {
    return this.store.mutate((data) => {
      const mentor: Mentor = {
        id: input.id ?? newId("men", this.now()),
        name: input.name,
        role: "mentor",
        dutyAssignments: input.dutyAssignments,
      };
      data.mentors.push(mentor);
      return mentor;
    });
  }

  async addSafetyOfficer(input: Omit<SafetyOfficer, "id" | "role"> & { id?: string }): Promise<SafetyOfficer> {
    return this.store.mutate((data) => {
      const officer: SafetyOfficer = {
        id: input.id ?? newId("saf", this.now()),
        name: input.name,
        role: "safety_officer",
      };
      data.safetyOfficers.push(officer);
      return officer;
    });
  }

  async addTool(input: Omit<Tool, "id"> & { id?: string }): Promise<Tool> {
    return this.store.mutate((data) => {
      const tool: Tool = {
        id: input.id ?? newId("tool", this.now()),
        name: input.name,
        riskLevel: input.riskLevel,
        equipmentId: input.equipmentId,
        stock: input.stock,
      };
      data.tools.push(tool);
      return tool;
    });
  }

  async addEquipment(input: Omit<Equipment, "status" | "statusReason"> & { id?: string }): Promise<Equipment> {
    return this.store.mutate((data) => {
      const equipment: Equipment = {
        id: input.id ?? newId("eqp", this.now()),
        name: input.name,
        status: "available",
        statusReason: null,
      };
      data.equipment.push(equipment);
      return equipment;
    });
  }

  async setEquipmentStatus(equipmentId: string, status: Equipment["status"], reason: string): Promise<Equipment> {
    return this.store.mutate((data) => {
      const equipment = mustFind(data.equipment, (e) => e.id === equipmentId, "equipment_not_found");
      equipment.status = status;
      equipment.statusReason = reason;
      return equipment;
    });
  }

  async recordQualification(input: {
    id?: string;
    studentId: string;
    riskLevel: Qualification["riskLevel"];
    trainingVersion: string;
    trainedAt: Timestamp;
    validUntil: Timestamp;
    recertifiedAt?: Timestamp | null;
    state?: Qualification["state"];
  }): Promise<Qualification> {
    return this.store.mutate((data) => {
      mustFind(data.students, (s) => s.id === input.studentId, "student_not_found");
      const now = this.now();
      const state = input.state ?? (input.validUntil <= now ? "expired" : "active");
      const qualification: Qualification = {
        id: input.id ?? newId("qua", now),
        studentId: input.studentId,
        riskLevel: input.riskLevel,
        state,
        trainingVersion: input.trainingVersion,
        trainedAt: input.trainedAt,
        validUntil: input.validUntil,
        recertifiedAt: input.recertifiedAt ?? null,
      };
      data.qualifications.push(qualification);
      return qualification;
    });
  }

  async addSafetyNotice(input: Omit<SafetyNotice, "id" | "revokedAt"> & { id?: string }): Promise<SafetyNotice> {
    return this.store.mutate((data) => {
      const notice: SafetyNotice = {
        id: input.id ?? newId("ntc", this.now()),
        title: input.title,
        riskLevel: input.riskLevel,
        toolId: input.toolId,
        effectiveAt: input.effectiveAt,
        revokedAt: null,
      };
      data.notices.push(notice);
      return notice;
    });
  }

  async revokeSafetyNotice(noticeId: string): Promise<SafetyNotice> {
    return this.store.mutate((data) => {
      const notice = mustFind(data.notices, (n) => n.id === noticeId, "notice_not_found");
      notice.revokedAt = this.now();
      return notice;
    });
  }

  async addMaterialBatch(input: Omit<MaterialBatch, "id"> & { id?: string }): Promise<MaterialBatch> {
    return this.store.mutate((data) => {
      const batch: MaterialBatch = {
        id: input.id ?? newId("bat", this.now()),
        name: input.name,
        active: input.active,
        toolIds: input.toolIds,
      };
      data.materialBatches.push(batch);
      return batch;
    });
  }

  async grantConsent(input: {
    id?: string;
    studentId: string;
    riskLevel: GuardianConsent["riskLevel"];
    guardianId?: string;
    grantedAt?: Timestamp;
    validUntil: Timestamp;
  }): Promise<GuardianConsent> {
    return this.store.mutate((data) => {
      const student = mustFind(data.students, (s) => s.id === input.studentId, "student_not_found");
      const consent: GuardianConsent = {
        id: input.id ?? newId("con", this.now()),
        studentId: input.studentId,
        riskLevel: input.riskLevel,
        guardianId: input.guardianId ?? student.guardianId,
        grantedAt: input.grantedAt ?? this.now(),
        validUntil: input.validUntil,
        revokedAt: null,
      };
      data.consents.push(consent);
      return consent;
    });
  }

  // ---------- 领用 ----------

  async checkout(request: CheckoutRequest): Promise<CheckoutResult> {
    const now = request.now ?? this.now();
    const quantity = request.quantity ?? 1;
    if (quantity <= 0) throw new ApiError("invalid_quantity", 400, "领用数量必须大于 0");

    return this.store.mutate((data) => {
      // 幂等：同一次刷卡只对应一次借出，重复刷卡直接回放原记录。
      const existingBySwipe = data.loans.find((l) => l.cardSwipeId === request.cardSwipeId);
      if (existingBySwipe) {
        return { loan: existingBySwipe, duplicatedSwipe: true };
      }

      const student = mustFind(data.students, (s) => s.id === request.studentId, "student_not_found");
      const tool = mustFind(data.tools, (t) => t.id === request.toolId, "tool_not_found");
      const equipment = mustFind(data.equipment, (e) => e.id === tool.equipmentId, "equipment_not_found");
      if (student.groupId !== request.groupId) {
        throw new ApiError("group_mismatch", 400, `学生 ${student.id} 不属于小组 ${request.groupId}`);
      }

      // 尚未归还的工具不能再次流转。
      const openLoan = data.loans.find(
        (l) => l.studentId === student.id && l.toolId === tool.id && l.status !== "returned",
      );
      if (openLoan) {
        throw new ApiError("tool_already_out", 409, `工具尚未归还（借用记录 ${openLoan.id}），不能再次领用`);
      }

      const mentor = data.mentors.find((m) => m.id === request.mentorId) ?? null;
      const qualification = this.findQualification(data, student.id, tool.riskLevel);
      const consent = this.findConsent(data, student.id, tool.riskLevel, now);
      const materialRequired = data.materialBatches.some((b) => b.toolIds.includes(tool.id));
      const requestedBatchId = request.materialBatchId === undefined ? null : request.materialBatchId;
      const materialBatch = requestedBatchId
        ? (data.materialBatches.find((b) => b.id === requestedBatchId) ?? null)
        : null;
      const activeNotices = this.findActiveNotices(data, tool, now);

      const decision = evaluateAdmission({
        now,
        tool,
        equipment,
        student,
        mentor,
        mentorId: request.mentorId,
        qualification,
        consent,
        materialRequired,
        materialBatch,
        requestedBatchId,
        activeNotices,
        requestedQuantity: quantity,
      });

      if (!decision.admitted) {
        throw new ApiError(
          "admission_denied",
          403,
          "准入条件未全部满足，拒绝本次领用",
          { conditions: decision.conditions },
        );
      }

      // 临界区内串行执行：库存判定与扣减不可能与并发领料交错。
      tool.stock -= quantity;

      const loan: Loan = {
        id: newId("loan", now),
        toolId: tool.id,
        studentId: student.id,
        mentorId: mentor?.id ?? request.mentorId,
        groupId: student.groupId,
        quantity,
        materialBatchId: materialRequired ? materialBatch!.id : null,
        checkedOutAt: now,
        cardSwipeId: request.cardSwipeId,
        status: "open",
        returnedAt: null,
        incidentId: null,
        decisionSnapshot: decision.snapshot,
      };
      data.loans.push(loan);
      this.appendEvent(data, loan.id, "checked_out", now, student.id, `刷卡 ${request.cardSwipeId} 借出`);
      return { loan, duplicatedSwipe: false };
    });
  }

  // ---------- 普通归还 ----------

  async returnLoan(loanId: string, actorId: string, at?: Timestamp): Promise<Loan> {
    const now = at ?? this.now();
    return this.store.mutate((data) => {
      const loan = mustFind(data.loans, (l) => l.id === loanId, "loan_not_found");
      if (loan.status === "returned") {
        throw new ApiError("loan_already_returned", 409, `借用记录 ${loanId} 已归还`);
      }
      // 事故锁定独立于普通归还：归还动作不能解除锁定。
      if (loan.status === "locked") {
        throw new ApiError(
          "loan_locked_by_incident",
          409,
          `借用记录 ${loanId} 已被事故 ${loan.incidentId} 锁定，普通归还不能解除，须由安全负责人复查`,
        );
      }
      loan.status = "returned";
      loan.returnedAt = now;
      const tool = mustFind(data.tools, (t) => t.id === loan.toolId, "tool_not_found");
      tool.stock += loan.quantity;
      this.appendEvent(data, loan.id, "returned", now, actorId, "普通归还，库存回补");
      return loan;
    });
  }

  // ---------- 事故上报与锁定 ----------

  async reportIncident(input: {
    toolId: string;
    loanId?: string | null;
    reporterId: string;
    description: string;
    at?: Timestamp;
  }): Promise<Incident> {
    const now = input.at ?? this.now();
    return this.store.mutate((data) => {
      const tool = mustFind(data.tools, (t) => t.id === input.toolId, "tool_not_found");
      const equipment = mustFind(data.equipment, (e) => e.id === tool.equipmentId, "equipment_not_found");

      let loan: Loan | null = null;
      if (input.loanId) {
        loan = mustFind(data.loans, (l) => l.id === input.loanId, "loan_not_found");
        if (loan.toolId !== tool.id) {
          throw new ApiError("loan_tool_mismatch", 400, "借用记录与事故工具不一致");
        }
      }

      // 事故锁定设备：新领用立即被拦（设备状态 + 策略第一道条件）。
      equipment.status = "locked";
      equipment.statusReason = `事故调查中：${input.description}`;

      const qualification = this.findQualification(
        data,
        loan?.studentId ?? "",
        tool.riskLevel,
      );
      const incident: Incident = {
        id: newId("inc", now),
        toolId: tool.id,
        equipmentId: equipment.id,
        loanId: loan?.id ?? null,
        studentId: loan?.studentId ?? "",
        mentorId: loan?.mentorId ?? input.reporterId,
        materialBatchId: loan?.materialBatchId ?? null,
        reportedAt: now,
        description: input.description,
        trainingVersion: qualification?.trainingVersion ?? loan?.decisionSnapshot.qualification.trainingVersion ?? null,
        status: "open",
        lockedLoanIds: [],
        review: null,
      };

      if (loan && loan.status !== "returned") {
        loan.status = "locked";
        loan.incidentId = incident.id;
        incident.lockedLoanIds.push(loan.id);
        this.appendEvent(data, loan.id, "locked", now, input.reporterId, `事故 ${incident.id} 锁定`);
      }

      data.incidents.push(incident);
      return incident;
    });
  }

  // ---------- 安全复查（解除事故锁定的唯一途径） ----------

  async reviewIncident(input: {
    incidentId: string;
    safetyOfficerId: string;
    finding: string;
    cleared: boolean;
    at?: Timestamp;
  }): Promise<Incident> {
    const now = input.at ?? this.now();
    return this.store.mutate((data) => {
      const officer = data.safetyOfficers.find((o) => o.id === input.safetyOfficerId);
      if (!officer) {
        throw new ApiError("not_safety_officer", 403, `只有安全负责人可以完成事故复查（${input.safetyOfficerId} 不是）`);
      }
      const incident = mustFind(data.incidents, (i) => i.id === input.incidentId, "incident_not_found");
      if (incident.status === "cleared") {
        throw new ApiError("incident_already_cleared", 409, `事故 ${incident.id} 已完成复查并解除`);
      }

      const review: IncidentReview = {
        reviewedAt: now,
        safetyOfficerId: officer.id,
        finding: input.finding,
        cleared: input.cleared,
      };
      incident.review = review;

      if (input.cleared) {
        // 解除设备锁定，恢复新领用；被锁借用记录转回未归还状态，再走普通归还入库。
        const equipment = mustFind(data.equipment, (e) => e.id === incident.equipmentId, "equipment_not_found");
        equipment.status = "available";
        equipment.statusReason = null;
        for (const loanId of incident.lockedLoanIds) {
          const loan = data.loans.find((l) => l.id === loanId);
          if (loan && loan.status === "locked") {
            loan.status = "open";
            loan.incidentId = null;
          }
        }
        incident.status = "cleared";
      } else {
        incident.status = "reviewed";
      }
      return incident;
    });
  }

  // ---------- 导师小组视图 ----------

  async getGroupView(groupId: string, at?: Timestamp): Promise<GroupView> {
    const now = at ?? this.now();
    return this.store.read((data) => {
      const members = data.students.filter((s) => s.groupId === groupId);
      const dutyMentor = this.findDutyMentor(data, groupId, now);

      const view: GroupMemberView[] = members.map((student) => {
        const operableTools: string[] = [];
        const missingConditions: Record<string, ConditionResult[]> = {};

        for (const tool of data.tools) {
          const equipment = data.equipment.find((e) => e.id === tool.equipmentId);
          if (!equipment) continue;
          const decision = evaluateAdmission({
            now,
            tool,
            equipment,
            student,
            mentor: dutyMentor,
            mentorId: dutyMentor?.id ?? "",
            qualification: this.findQualification(data, student.id, tool.riskLevel),
            consent: this.findConsent(data, student.id, tool.riskLevel, now),
            materialRequired: false, // 只读视图只评估人员/设备侧条件，批次以实际领用登记为准
            materialBatch: null,
            requestedBatchId: null,
            activeNotices: this.findActiveNotices(data, tool, now),
            requestedQuantity: 1,
          });
          const failed = decision.conditions.filter((c) => !c.passed);
          // 已持有未归还（含事故锁定）的工具不能再次流转。
          const heldLoan = data.loans.find(
            (l) => l.studentId === student.id && l.toolId === tool.id && l.status !== "returned",
          );
          if (heldLoan) {
            failed.push({
              code: "tool_already_out",
              label: "该工具存在未归还或事故锁定的借用",
              passed: false,
              detail:
                heldLoan.status === "locked"
                  ? `借用记录 ${heldLoan.id} 已被事故 ${heldLoan.incidentId} 锁定，等待安全复查`
                  : `借用记录 ${heldLoan.id} 尚未归还，归还前不能再次领用`,
            });
          }
          if (failed.length === 0) operableTools.push(tool.id);
          else missingConditions[tool.id] = failed;
        }

        const openLoans = data.loans.filter(
          (l) => l.studentId === student.id && l.status !== "returned",
        );
        return { student, operableTools, missingConditions, openLoans };
      });

      return {
        groupId,
        at: now,
        dutyMentor: dutyMentor
          ? { mentorId: dutyMentor.id, name: dutyMentor.name, onDuty: true }
          : { mentorId: "", name: "", onDuty: false },
        members: view,
      };
    });
  }

  // ---------- 安全人员事故追溯 ----------

  async getIncidentTrace(incidentId: string): Promise<IncidentTrace> {
    return this.store.read((data) => {
      const incident = mustFind(data.incidents, (i) => i.id === incidentId, "incident_not_found");
      const loan = data.loans.find((l) => l.id === incident.loanId) ?? null;
      const tool = data.tools.find((t) => t.id === incident.toolId) ?? null;
      const trainingHistory = data.qualifications
        .filter((q) => q.studentId === incident.studentId && (!tool || q.riskLevel === tool.riskLevel))
        .sort((a, b) => a.trainedAt - b.trainedAt);
      const materialBatch = data.materialBatches.find((b) => b.id === incident.materialBatchId) ?? null;
      const dutyMentor = data.mentors.find((m) => m.id === incident.mentorId) ?? null;
      const student = data.students.find((s) => s.id === incident.studentId) ?? null;
      const equipment = data.equipment.find((e) => e.id === incident.equipmentId) ?? null;
      return { incident, loan, trainingHistory, materialBatch, dutyMentor, student, equipment };
    });
  }

  async listOpenIncidents(): Promise<Incident[]> {
    return this.store.read((data) => data.incidents.filter((i) => i.status !== "cleared"));
  }

  // ---------- 逾期标记（枚举事件落地） ----------

  async markOverdue(loanTimeoutMs: number, at?: Timestamp): Promise<CheckoutEventRecord[]> {
    const now = at ?? this.now();
    return this.store.mutate((data) => {
      const created: CheckoutEventRecord[] = [];
      for (const loan of data.loans) {
        if (loan.status === "returned") continue;
        if (now - loan.checkedOutAt <= loanTimeoutMs) continue;
        const already = data.events.some((e) => e.loanId === loan.id && e.type === "overdue");
        if (already) continue;
        created.push(this.appendEvent(data, loan.id, "overdue", now, "system", "超过借用时限"));
      }
      return created;
    });
  }

  // ---------- 内部装配辅助 ----------

  private findQualification(data: StoreData, studentId: string, riskLevel: Tool["riskLevel"]): Qualification | null {
    const matches = data.qualifications
      .filter((q) => q.studentId === studentId && q.riskLevel === riskLevel)
      .sort((a, b) => b.trainedAt - a.trainedAt);
    return matches[0] ?? null;
  }

  private findConsent(data: StoreData, studentId: string, riskLevel: Tool["riskLevel"], now: Timestamp): GuardianConsent | null {
    const student = data.students.find((s) => s.id === studentId);
    return (
      data.consents.find(
        (c) =>
          c.studentId === studentId &&
          c.riskLevel === riskLevel &&
          c.revokedAt === null &&
          c.validUntil > now &&
          (!student || c.guardianId === student.guardianId),
      ) ?? null
    );
  }

  private findActiveNotices(data: StoreData, tool: Tool, now: Timestamp): SafetyNotice[] {
    return data.notices.filter(
      (n) =>
        n.effectiveAt <= now &&
        n.revokedAt === null &&
        (n.toolId === tool.id || (n.riskLevel !== null && n.riskLevel === tool.riskLevel)),
    );
  }

  private findDutyMentor(data: StoreData, groupId: string, now: Timestamp): Mentor | null {
    return (
      data.mentors.find((m) =>
        m.dutyAssignments.some((a) => a.groupId === groupId && a.startsAt <= now && now < a.endsAt),
      ) ?? null
    );
  }

  private appendEvent(
    data: StoreData,
    loanId: string,
    type: CheckoutEventRecord["type"],
    now: Timestamp,
    actorId: string,
    note: string,
  ): CheckoutEventRecord {
    const event: CheckoutEventRecord = {
      id: newId("evt", now),
      loanId,
      type,
      at: now,
      actorId,
      note,
    };
    data.events.push(event);
    return event;
  }
}

function mustFind<T>(items: T[], predicate: (item: T) => boolean, code: string): T {
  const found = items.find(predicate);
  if (!found) throw new ApiError(code, 404, code);
  return found;
}
