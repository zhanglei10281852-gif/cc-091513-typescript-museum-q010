// 领域类型：创客实验室工具资质闸门。
// 所有业务记录使用稳定标识；借出事件只追加、不改写，
// 决策当时的条件以快照形式附着，供事故追溯。

export type RiskLevel = "basic" | "supervised" | "restricted";
export type QualificationState = "training" | "active" | "expired" | "suspended";
export type CheckoutEventKind = "checked_out" | "returned" | "overdue" | "locked";
export type PersonRole = "student" | "mentor" | "safety_officer" | "guardian";
export type ToolOperationalStatus = "active" | "decommissioned";
export type MaterialStatus = "ok" | "quarantined" | "recalled";
export type IncidentStatus = "open" | "reviewed" | "released";

export interface Person {
  id: string;
  name: string;
  role: PersonRole;
  groupId: string | null;
}

export interface PracticeGroup {
  id: string;
  name: string;
  mentorIds: string[];
  memberIds: string[];
}

export interface Tool {
  id: string;
  name: string;
  riskLevel: RiskLevel;
  /** 可同时借出的单元数量（激光切割机这类设备为 1）。 */
  stock: number;
  requiresGuardian: boolean;
  requiresMaterial: boolean;
  status: ToolOperationalStatus;
  createdAt: number;
}

export interface Qualification {
  personId: string;
  toolId: string;
  state: QualificationState;
  /** 培训课程版本，事故追溯的关键线索。 */
  trainingVersion: string;
  certifiedAt: number;
  /** 复认证截止时间（epoch ms）。 */
  expiresAt: number;
}

export interface MentorDuty {
  id: string;
  mentorId: string;
  /** null 表示跨组当班；否则限定实践小组。 */
  groupId: string | null;
  startAt: number;
  endAt: number | null;
}

export interface GuardianConsent {
  id: string;
  studentId: string;
  guardianId: string;
  toolId: string;
  grantedAt: number;
  expiresAt: number;
}

export interface MaterialBatch {
  id: string;
  name: string;
  /** null 表示通用于所有工具；否则仅限指定工具领用。 */
  toolIds: string[] | null;
  quantity: number;
  status: MaterialStatus;
}

export interface SafetyNotice {
  id: string;
  title: string;
  /** null 表示全站公告，对所有工具生效。 */
  toolId: string | null;
  effectiveAt: number;
  liftedAt: number | null;
}

/** 准入判定的单项检查结果。code 同时用于 API 缺失条件展示。 */
export interface DecisionCheck {
  code:
    | "tool_operational"
    | "safety_notice_clear"
    | "qualification_present"
    | "qualification_state_active"
    | "qualification_not_expired"
    | "mentor_in_group"
    | "mentor_on_duty"
    | "guardian_consent"
    | "material_batch"
    | "tool_inventory"
    | "no_open_loan";
  passed: boolean;
  detail?: string;
}

export interface TrainingSnapshot {
  state: QualificationState;
  trainingVersion: string;
  certifiedAt: number;
  expiresAt: number;
}

export interface MentorDutySnapshot {
  mentorId: string;
  dutyId: string;
  groupId: string | null;
  startAt: number;
}

export interface ConsentSnapshot {
  id: string;
  guardianId: string;
  grantedAt: number;
  expiresAt: number;
}

export interface MaterialSnapshot {
  id: string;
  name: string;
  status: MaterialStatus;
  quantity: number;
  toolIds: string[] | null;
}

export interface NoticeSnapshot {
  id: string;
  title: string;
  effectiveAt: number;
}

/** 借出发生当下采用的全部条件，历史冻结，不随后续资质变化而改变。 */
export interface DecisionSnapshot {
  decidedAt: number;
  riskLevel: RiskLevel;
  toolStatus: ToolOperationalStatus;
  stock: { total: number; reserved: number; available: number };
  training: TrainingSnapshot | null;
  mentorDuty: MentorDutySnapshot | null;
  guardianConsent: ConsentSnapshot | null;
  materialBatch: MaterialSnapshot | null;
  safetyNotices: NoticeSnapshot[];
  checks: DecisionCheck[];
  approved: boolean;
}

export interface CheckoutEvent {
  kind: CheckoutEventKind;
  at: number;
  operatorId: string | null;
  incidentId?: string;
  note?: string;
}

export interface Loan {
  id: string;
  /** 刷卡/请求幂等键：同一次刷卡重复到达只对应一次借出。 */
  requestId: string | null;
  personId: string;
  toolId: string;
  checkedOutAt: number;
  returnedAt: number | null;
  mentorId: string;
  guardianId: string | null;
  materialBatchId: string | null;
  materialQty: number;
  snapshot: DecisionSnapshot;
  events: CheckoutEvent[];
}

export interface AuditDecision {
  id: string;
  requestId: string | null;
  loanId: string | null;
  personId: string;
  toolId: string;
  mentorId: string | null;
  materialBatchId: string | null;
  at: number;
  outcome: "approved" | "denied";
  snapshot: DecisionSnapshot;
}

export type IncidentAction = "opened" | "reviewed" | "released";

export interface IncidentTimelineEntry {
  at: number;
  by: string | null;
  action: IncidentAction;
  note: string;
}

export interface Incident {
  id: string;
  loanId: string | null;
  toolId: string;
  personId: string | null;
  description: string;
  reportedBy: string | null;
  reportedAt: number;
  status: IncidentStatus;
  reviewedAt: number | null;
  reviewedBy: string | null;
  releasedAt: number | null;
  releasedBy: string | null;
  /** 事故开启时自动下发、解除时 lifted 的工具级安全公告。 */
  lockNoticeId: string | null;
  timeline: IncidentTimelineEntry[];
}

export interface State {
  seq: number;
  people: Record<string, Person>;
  groups: Record<string, PracticeGroup>;
  tools: Record<string, Tool>;
  qualifications: Qualification[];
  duties: MentorDuty[];
  consents: GuardianConsent[];
  materialBatches: Record<string, MaterialBatch>;
  safetyNotices: SafetyNotice[];
  loans: Loan[];
  incidents: Incident[];
  decisions: AuditDecision[];
}
