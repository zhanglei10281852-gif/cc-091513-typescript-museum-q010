import type { Clock } from "../domain/clock.js";
import { DomainError, conflict, notFound, validationError } from "../domain/errors.js";
import { evaluateGate } from "../domain/gate.js";
import type {
  AuditDecision,
  GuardianConsent,
  Incident,
  Loan,
  MaterialBatch,
  MentorDuty,
  Person,
  PersonRole,
  PracticeGroup,
  Qualification,
  QualificationState,
  RiskLevel,
  SafetyNotice,
  State,
  Tool,
} from "../domain/types.js";
import { JsonStore } from "../infra/json-store.js";
import { optionalString, requireArray, requireId, requireInteger, requireOneOf, requireString } from "./validation.js";

const RISK_LEVELS = ["basic", "supervised", "restricted"] as const;
const ROLES = ["student", "mentor", "safety_officer", "guardian"] as const;
const QUAL_STATES = ["training", "active", "expired", "suspended"] as const;

export interface CreatePersonInput {
  name?: unknown;
  role?: unknown;
  groupId?: unknown;
}

export interface UpsertToolInput {
  name?: unknown;
  riskLevel?: unknown;
  stock?: unknown;
  requiresGuardian?: unknown;
  requiresMaterial?: unknown;
  status?: unknown;
}

export interface UpsertQualificationInput {
  state?: unknown;
  trainingVersion?: unknown;
  certifiedAt?: unknown;
  expiresAt?: unknown;
}

export interface CheckoutInput {
  personId?: unknown;
  toolId?: unknown;
  mentorId?: unknown;
  materialBatchId?: unknown;
  requestId?: unknown;
}

export interface GroupOverviewMember {
  personId: string;
  name: string;
  role: PersonRole;
  capabilities: Array<{ toolId: string; toolName: string; riskLevel: RiskLevel; approved: boolean }>;
  missingConditions: Array<{ toolId: string; toolName: string; missing: string[] }>;
  openLoans: Array<{
    loanId: string;
    toolId: string;
    toolName: string;
    checkedOutAt: number;
    materialBatchId: string | null;
    locked: boolean;
    incidentId: string | null;
  }>;
}

export interface GroupOverview {
  group: PracticeGroup;
  mentors: Person[];
  members: GroupOverviewMember[];
}

export interface IncidentTrace {
  incident: Incident;
  loan: (Loan & { materialBatch: MaterialSnapshotView | null }) | null;
  tool: Tool | null;
  person: Person | null;
  mentor: Person | null;
  guardian: Person | null;
  materialBatch: MaterialSnapshotView | null;
  training: Qualification | null;
  decision: AuditDecision | null;
}

interface MaterialSnapshotView {
  id: string;
  name: string;
  status: string;
  quantity: number;
}

/**
 * 实验室业务服务。所有写操作通过 store.mutate 进入同步临界区：
 * Node 单线程下判定 + 状态变更 + 持久化原子完成，天然守住并发库存下限。
 */
export class LabService {
  constructor(
    private readonly store: JsonStore,
    private readonly clock: Clock,
  ) {}

  // ---------- 基础档案 ----------

  createPerson(input: CreatePersonInput): Person {
    const name = requireString(input.name, "name");
    const role = requireOneOf(input.role, "role", ROLES);
    const groupId = optionalString(input.groupId, "groupId");
    return this.store.mutate((state) => {
      if (groupId && !state.groups[groupId]) notFound("实践小组", groupId);
      const id = this.store.nextId("person");
      const person: Person = { id, name, role, groupId };
      state.people[id] = person;
      return person;
    });
  }

  listPeople(): Person[] {
    return Object.values(this.store.get().people);
  }

  createGroup(input: Record<string, unknown>): PracticeGroup {
    const name = requireString(input.name, "name");
    const mentorIds = (input.mentorIds === undefined ? [] : requireArray(input.mentorIds, "mentorIds")).map((v) =>
      requireId(v, "mentorIds[]"),
    );
    const memberIds = (input.memberIds === undefined ? [] : requireArray(input.memberIds, "memberIds")).map((v) =>
      requireId(v, "memberIds[]"),
    );
    return this.store.mutate((state) => {
      for (const id of [...mentorIds, ...memberIds]) {
        if (!state.people[id]) notFound("人员", id);
      }
      const id = this.store.nextId("group");
      const group: PracticeGroup = { id, name, mentorIds, memberIds };
      state.groups[id] = group;
      for (const memberId of memberIds) {
        const person = state.people[memberId];
        if (person) person.groupId = id;
      }
      return group;
    });
  }

  addGroupMember(groupId: string, personId: string): PracticeGroup {
    return this.store.mutate((state) => {
      const group = state.groups[groupId];
      if (!group) notFound("实践小组", groupId);
      const person = state.people[personId];
      if (!person) notFound("人员", personId);
      if (!group.memberIds.includes(personId)) group.memberIds.push(personId);
      person.groupId = groupId;
      return group;
    });
  }

  listGroups(): PracticeGroup[] {
    return Object.values(this.store.get().groups);
  }

  upsertTool(id: string, input: UpsertToolInput): Tool {
    const name = requireString(input.name, "name");
    const riskLevel = requireOneOf(input.riskLevel, "riskLevel", RISK_LEVELS);
    const stock = requireInteger(input.stock, "stock", 0);
    const requiresGuardian = input.requiresGuardian === true;
    const requiresMaterial = input.requiresMaterial === true;
    const status = input.status === undefined ? "active" : requireOneOf(input.status, "status", ["active", "decommissioned"] as const);
    return this.store.mutate((state) => {
      const existing = state.tools[id];
      const tool: Tool = {
        id,
        name,
        riskLevel,
        stock,
        requiresGuardian,
        requiresMaterial,
        status,
        createdAt: existing?.createdAt ?? this.clock.now(),
      };
      state.tools[id] = tool;
      return tool;
    });
  }

  setToolStatus(id: string, status: "active" | "decommissioned"): Tool {
    return this.store.mutate((state) => {
      const tool = state.tools[id];
      if (!tool) notFound("工具", id);
      tool.status = status;
      return tool;
    });
  }

  listTools(): Tool[] {
    return Object.values(this.store.get().tools);
  }

  // ---------- 培训与复认证 ----------

  upsertQualification(personId: string, toolId: string, input: UpsertQualificationInput): Qualification {
    const state0 = requireOneOf(input.state, "state", QUAL_STATES);
    const trainingVersion = requireString(input.trainingVersion, "trainingVersion");
    const expiresAt = requireInteger(input.expiresAt, "expiresAt", 0);
    const certifiedAt = input.certifiedAt === undefined ? this.clock.now() : requireInteger(input.certifiedAt, "certifiedAt", 0);
    return this.store.mutate((state) => {
      if (!state.people[personId]) notFound("人员", personId);
      if (!state.tools[toolId]) notFound("工具", toolId);
      let qualification = state.qualifications.find((q) => q.personId === personId && q.toolId === toolId);
      if (!qualification) {
        qualification = { personId, toolId, state: state0, trainingVersion, certifiedAt, expiresAt };
        state.qualifications.push(qualification);
      } else {
        qualification.state = state0;
        qualification.trainingVersion = trainingVersion;
        qualification.certifiedAt = certifiedAt;
        qualification.expiresAt = expiresAt;
      }
      return qualification;
    });
  }

  listQualifications(): Qualification[] {
    return this.store.get().qualifications;
  }

  // ---------- 当班导师 ----------

  startDuty(mentorId: string, groupId?: string | null): MentorDuty {
    return this.store.mutate((state) => {
      const mentor = state.people[mentorId];
      if (!mentor) notFound("导师", mentorId);
      if (mentor.role !== "mentor") throw new DomainError("access_denied", "该人员不是导师", { role: mentor.role });
      if (groupId && !state.groups[groupId]) notFound("实践小组", groupId);
      const id = this.store.nextId("duty");
      const duty: MentorDuty = { id, mentorId, groupId: groupId ?? null, startAt: this.clock.now(), endAt: null };
      state.duties.push(duty);
      return duty;
    });
  }

  endDuty(dutyId: string): MentorDuty {
    return this.store.mutate((state) => {
      const duty = state.duties.find((d) => d.id === dutyId);
      if (!duty) notFound("当班记录", dutyId);
      duty.endAt = this.clock.now();
      return duty;
    });
  }

  listDuties(): MentorDuty[] {
    return this.store.get().duties;
  }

  // ---------- 监护授权 ----------

  grantConsent(input: Record<string, unknown>): GuardianConsent {
    const studentId = requireId(input.studentId, "studentId");
    const guardianId = requireId(input.guardianId, "guardianId");
    const toolId = requireId(input.toolId, "toolId");
    const expiresAt = requireInteger(input.expiresAt, "expiresAt", 0);
    return this.store.mutate((state) => {
      if (!state.people[studentId]) notFound("学生", studentId);
      const guardian = state.people[guardianId];
      if (!guardian) notFound("监护人", guardianId);
      if (guardian.role !== "guardian") throw new DomainError("access_denied", "授权人不是监护人", { role: guardian.role });
      if (!state.tools[toolId]) notFound("工具", toolId);
      const id = this.store.nextId("consent");
      const consent: GuardianConsent = { id, studentId, guardianId, toolId, grantedAt: this.clock.now(), expiresAt };
      state.consents.push(consent);
      return consent;
    });
  }

  // ---------- 材料批次 ----------

  upsertMaterialBatch(
    id: string,
    input: Record<string, unknown>,
  ): MaterialBatch {
    const name = requireString(input.name, "name");
    const quantity = requireInteger(input.quantity, "quantity", 0);
    const status = input.status === undefined ? "ok" : requireOneOf(input.status, "status", ["ok", "quarantined", "recalled"] as const);
    const toolIds =
      input.toolIds === undefined || input.toolIds === null
        ? null
        : requireArray(input.toolIds, "toolIds").map((v) => requireId(v, "toolIds[]"));
    return this.store.mutate((state) => {
      if (toolIds) for (const toolId of toolIds) if (!state.tools[toolId]) notFound("工具", toolId);
      const batch: MaterialBatch = { id, name, toolIds, quantity, status };
      state.materialBatches[id] = batch;
      return batch;
    });
  }

  listMaterialBatches(): MaterialBatch[] {
    return Object.values(this.store.get().materialBatches);
  }

  // ---------- 安全公告 ----------

  publishNotice(input: Record<string, unknown>): SafetyNotice {
    const title = requireString(input.title, "title");
    const toolId = optionalString(input.toolId, "toolId");
    const effectiveAt = input.effectiveAt === undefined ? this.clock.now() : requireInteger(input.effectiveAt, "effectiveAt", 0);
    return this.store.mutate((state) => {
      if (toolId && !state.tools[toolId]) notFound("工具", toolId);
      const id = this.store.nextId("notice");
      const notice: SafetyNotice = { id, title, toolId, effectiveAt, liftedAt: null };
      state.safetyNotices.push(notice);
      return notice;
    });
  }

  liftNotice(noticeId: string): SafetyNotice {
    return this.store.mutate((state) => {
      const notice = state.safetyNotices.find((n) => n.id === noticeId);
      if (!notice) notFound("安全公告", noticeId);
      notice.liftedAt = this.clock.now();
      return notice;
    });
  }

  listNotices(): SafetyNotice[] {
    return this.store.get().safetyNotices;
  }

  // ---------- 借出 / 归还 ----------

  /**
   * 工具领用（刷卡）。
   * - requestId 相同的重复刷卡只返回首次借出；
   * - 资质过期或安全公告生效立即拒绝，并保存被拒判定；
   * - 整个判定与落库在同一同步临界区内，并发领料不会击穿库存下限。
   */
  checkout(input: CheckoutInput): { loan: Loan; decision: AuditDecision; reused: boolean } {
    const personId = requireId(input.personId, "personId");
    const toolId = requireId(input.toolId, "toolId");
    const mentorId = optionalString(input.mentorId, "mentorId");
    const materialBatchId = optionalString(input.materialBatchId, "materialBatchId");
    const requestId = optionalString(input.requestId, "requestId");

    return this.store.mutate((state) => {
      if (!state.people[personId]) notFound("人员", personId);
      if (!state.tools[toolId]) notFound("工具", toolId);

      // 幂等：同一次刷卡重复到达，直接回放既有借出。
      if (requestId) {
        const existingLoan = state.loans.find((loan) => loan.requestId === requestId);
        if (existingLoan) {
          const existingDecision = state.decisions.find((d) => d.loanId === existingLoan.id && d.outcome === "approved");
          if (!existingDecision) conflict("幂等请求缺少原始判定记录", { requestId });
          return { loan: existingLoan, decision: existingDecision, reused: true };
        }
        const denied = state.decisions.find((d) => d.requestId === requestId && d.outcome === "denied");
        if (denied) {
          // 重复刷卡幂等回放原始拒绝（同码同条件），不产生新判定。
          throw new DomainError("access_denied", "准入判定未通过，领用被拒绝", {
            decisionId: denied.id,
            reused: true,
            missing: denied.snapshot.checks.filter((c) => !c.passed).map((c) => c.code),
            snapshot: denied.snapshot,
          });
        }
      }

      const result = evaluateGate({ state, now: this.clock.now(), personId, toolId, mentorId, materialBatchId });

      const decisionId = this.store.nextId("decision");
      const decision: AuditDecision = {
        id: decisionId,
        requestId,
        loanId: null,
        personId,
        toolId,
        mentorId: result.mentorId,
        materialBatchId: result.materialBatchId,
        at: result.snapshot.decidedAt,
        outcome: result.approved ? "approved" : "denied",
        snapshot: result.snapshot,
      };
      state.decisions.push(decision);

      if (!result.approved) {
        const missing = result.snapshot.checks.filter((c) => !c.passed).map((c) => c.code);
        throw new DomainError("access_denied", "准入判定未通过，领用被拒绝", {
          decisionId,
          missing,
          snapshot: result.snapshot,
        });
      }

      const loanId = this.store.nextId("loan");
      const loan: Loan = {
        id: loanId,
        requestId,
        personId,
        toolId,
        checkedOutAt: result.snapshot.decidedAt,
        returnedAt: null,
        mentorId: result.mentorId ?? mentorId ?? "",
        guardianId: result.guardianId,
        materialBatchId: result.materialBatchId,
        materialQty: result.materialBatchId ? 1 : 0,
        snapshot: result.snapshot,
        events: [{ kind: "checked_out", at: result.snapshot.decidedAt, operatorId: personId }],
      };
      decision.loanId = loanId;
      state.loans.push(loan);

      if (result.materialBatchId) {
        const batch = state.materialBatches[result.materialBatchId];
        if (batch) batch.quantity -= 1;
      }
      return { loan, decision, reused: false };
    });
  }

  /**
   * 普通归还。事故锁定独立于归还：只要关联事故尚未由安全负责人复查解除，
   * 普通归还即被拒绝；解除后普通归还方可闭环（locked 事件仍留在历史中）。
   */
  returnLoan(loanId: string): Loan {
    return this.store.mutate((state) => {
      const loan = state.loans.find((l) => l.id === loanId);
      if (!loan) notFound("借出记录", loanId);
      if (loan.returnedAt !== null) conflict("该借出已归还", { loanId });
      const activeLock = loan.events
        .filter((e) => e.kind === "locked" && e.incidentId !== undefined)
        .map((e) => state.incidents.find((i) => i.id === e.incidentId))
        .find((incident) => incident !== undefined && incident.status !== "released");
      if (activeLock) {
        conflict("工具处于事故锁定，普通归还无效，须由安全负责人完成复查并解除", {
          loanId,
          incidentId: activeLock.id,
        });
      }
      const now = this.clock.now();
      loan.returnedAt = now;
      loan.events.push({ kind: "returned", at: now, operatorId: null });
      return loan;
    });
  }

  getLoan(loanId: string): Loan {
    const loan = this.store.get().loans.find((l) => l.id === loanId);
    if (!loan) notFound("借出记录", loanId);
    return loan;
  }

  listLoans(includeReturned = false): Loan[] {
    const state = this.store.get();
    return includeReturned ? state.loans : state.loans.filter((l) => l.returnedAt === null);
  }

  // ---------- 事故与锁定 ----------

  /**
   * 开启事故：立即锁定借出（独立事件，不构成归还），并下发工具级安全公告，
   * 公告生效起新领用一律拒绝。
   */
  openIncident(input: Record<string, unknown>): Incident {
    const toolId = requireId(input.toolId, "toolId");
    const description = requireString(input.description, "description");
    const loanId = optionalString(input.loanId, "loanId");
    const personId = optionalString(input.personId, "personId");
    const reportedBy = optionalString(input.reportedBy, "reportedBy");
    return this.store.mutate((state) => {
      if (!state.tools[toolId]) notFound("工具", toolId);
      let loan: Loan | undefined;
      if (loanId) {
        loan = state.loans.find((l) => l.id === loanId);
        if (!loan) notFound("借出记录", loanId);
        if (loan.toolId !== toolId) validationError("借出记录与工具不一致", { loanId, toolId });
      }
      const now = this.clock.now();
      const incidentId = this.store.nextId("incident");
      const noticeId = this.store.nextId("notice");
      state.safetyNotices.push({
        id: noticeId,
        title: `事故 ${incidentId} 安全锁定`,
        toolId,
        effectiveAt: now,
        liftedAt: null,
      });
      const incident: Incident = {
        id: incidentId,
        loanId,
        toolId,
        personId: personId ?? loan?.personId ?? null,
        description,
        reportedBy,
        reportedAt: now,
        status: "open",
        reviewedAt: null,
        reviewedBy: null,
        releasedAt: null,
        releasedBy: null,
        lockNoticeId: noticeId,
        timeline: [{ at: now, by: reportedBy, action: "opened", note: description }],
      };
      state.incidents.push(incident);
      if (loan && !loan.events.some((e) => e.kind === "locked")) {
        loan.events.push({ kind: "locked", at: now, operatorId: reportedBy, incidentId });
      }
      return incident;
    });
  }

  /** 安全负责人完成复查（open -> reviewed），可附复查意见。 */
  reviewIncident(incidentId: string, reviewerId: string, note: string): Incident {
    return this.store.mutate((state) => {
      const incident = state.incidents.find((i) => i.id === incidentId);
      if (!incident) notFound("事故记录", incidentId);
      const reviewer = state.people[reviewerId];
      if (!reviewer) notFound("复查人", reviewerId);
      if (reviewer.role !== "safety_officer") throw new DomainError("access_denied", "只有安全负责人可以复查事故", { role: reviewer.role });
      if (incident.status === "released") conflict("事故已解除锁定", { incidentId });
      const now = this.clock.now();
      incident.status = "reviewed";
      incident.reviewedAt = now;
      incident.reviewedBy = reviewerId;
      incident.timeline.push({ at: now, by: reviewerId, action: "reviewed", note });
      return incident;
    });
  }

  /**
   * 解除事故锁定（reviewed -> released）：只有完成复查后由安全负责人执行。
   * 解除时 lift 事故公告，工具恢复新领用；被锁定借出另行通过普通归还闭环。
   */
  releaseIncident(incidentId: string, safetyOfficerId: string, note: string): Incident {
    return this.store.mutate((state) => {
      const incident = state.incidents.find((i) => i.id === incidentId);
      if (!incident) notFound("事故记录", incidentId);
      const officer = state.people[safetyOfficerId];
      if (!officer) notFound("安全负责人", safetyOfficerId);
      if (officer.role !== "safety_officer") throw new DomainError("access_denied", "只有安全负责人可以解除锁定", { role: officer.role });
      if (incident.status === "open") conflict("事故尚未完成复查，不能解除锁定", { incidentId });
      if (incident.status === "released") conflict("事故锁定已解除", { incidentId });
      const now = this.clock.now();
      incident.status = "released";
      incident.releasedAt = now;
      incident.releasedBy = safetyOfficerId;
      incident.timeline.push({ at: now, by: safetyOfficerId, action: "released", note });
      if (incident.lockNoticeId) {
        const notice = state.safetyNotices.find((n) => n.id === incident.lockNoticeId);
        if (notice && notice.liftedAt === null) notice.liftedAt = now;
      }
      return incident;
    });
  }

  listIncidents(): Incident[] {
    return this.store.get().incidents;
  }

  /** 安全人员视角：从事故记录一路追到培训版本、材料批次与值班责任人。 */
  traceIncident(incidentId: string): IncidentTrace {
    const state = this.store.get();
    const incident = state.incidents.find((i) => i.id === incidentId);
    if (!incident) notFound("事故记录", incidentId);
    const loan = incident.loanId ? state.loans.find((l) => l.id === incident.loanId) ?? null : null;
    const tool = state.tools[incident.toolId] ?? null;
    const personId = incident.personId ?? loan?.personId ?? null;
    const person = personId ? state.people[personId] ?? null : null;
    const mentorId = loan?.mentorId ?? null;
    const mentor = mentorId ? state.people[mentorId] ?? null : null;
    const guardianId = loan?.guardianId ?? null;
    const guardian = guardianId ? state.people[guardianId] ?? null : null;
    const batchId = incident.loanId ? loan?.materialBatchId ?? null : null;
    const batch = batchId ? state.materialBatches[batchId] ?? null : null;
    // 借出发生当时的培训版本以快照为准；若无借出则回落到当前资质。
    const training =
      personId && loan
        ? loan.snapshot.training
          ? {
              personId,
              toolId: incident.toolId,
              state: loan.snapshot.training.state as QualificationState,
              trainingVersion: loan.snapshot.training.trainingVersion,
              certifiedAt: loan.snapshot.training.certifiedAt,
              expiresAt: loan.snapshot.training.expiresAt,
            }
          : null
        : personId
          ? state.qualifications.find((q) => q.personId === personId && q.toolId === incident.toolId) ?? null
          : null;
    const decision = loan ? state.decisions.find((d) => d.loanId === loan.id) ?? null : null;
    return {
      incident,
      loan: loan
        ? { ...loan, materialBatch: batch ? { id: batch.id, name: batch.name, status: batch.status, quantity: batch.quantity } : null }
        : null,
      tool,
      person,
      mentor,
      guardian,
      materialBatch: batch ? { id: batch.id, name: batch.name, status: batch.status, quantity: batch.quantity } : null,
      training,
      decision,
    };
  }

  // ---------- 导师视图 ----------

  /**
   * 导师打开实践小组：成员可操作范围（对所有工具的干跑判定）、
   * 缺失条件清单、未归还项目（含事故锁定）。判定不落库、不发料。
   */
  groupOverview(groupId: string): GroupOverview {
    const state = this.store.get();
    const group = state.groups[groupId];
    if (!group) notFound("实践小组", groupId);
    const now = this.clock.now();
    const mentors = group.mentorIds.map((id) => state.people[id]).filter((p): p is Person => p !== undefined);
    const members = group.memberIds.map((memberId) => state.people[memberId]).filter((p): p is Person => p !== undefined);

    const memberViews: GroupOverviewMember[] = members.map((person) => {
      const capabilities: GroupOverviewMember["capabilities"] = [];
      const missingConditions: GroupOverviewMember["missingConditions"] = [];
      for (const tool of Object.values(state.tools)) {
        // 干跑判定（能力模式）：只展示成员可操作范围与资质缺口，
        // 不把库存余量、本人未归还等实例态计入“缺失条件”。
        const result = evaluateGate({ state, now, personId: person.id, toolId: tool.id, capabilityOnly: true });
        capabilities.push({ toolId: tool.id, toolName: tool.name, riskLevel: tool.riskLevel, approved: result.approved });
        const missing = result.snapshot.checks.filter((c) => !c.passed).map((c) => c.code);
        if (missing.length > 0) missingConditions.push({ toolId: tool.id, toolName: tool.name, missing });
      }
      const openLoans = state.loans
        .filter((loan) => loan.personId === person.id && loan.returnedAt === null)
        .map((loan) => {
          const lockedEvent = loan.events.find((e) => e.kind === "locked");
          const tool = state.tools[loan.toolId];
          return {
            loanId: loan.id,
            toolId: loan.toolId,
            toolName: tool?.name ?? loan.toolId,
            checkedOutAt: loan.checkedOutAt,
            materialBatchId: loan.materialBatchId,
            locked: lockedEvent !== undefined,
            incidentId: lockedEvent?.incidentId ?? null,
          };
        });
      return { personId: person.id, name: person.name, role: person.role, capabilities, missingConditions, openLoans };
    });

    return { group, mentors, members: memberViews };
  }

  // ---------- 审计 ----------

  listDecisions(): AuditDecision[] {
    return this.store.get().decisions;
  }

  // ---------- 测试运维 ----------

  reset(): void {
    this.store.reset();
  }

  /** 仅供测试与导入：直接读取不可变状态。 */
  state(): State {
    return this.store.get();
  }
}
