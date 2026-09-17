import type {
  ActorRole,
  CheckoutEventType,
  EquipmentStatus,
  QualificationState,
  RiskLevel,
} from "./enums.js";

/** 统一使用毫秒时间戳，便于序列化与测试注入时钟。 */
export type Timestamp = number;

export interface Person {
  id: string;
  name: string;
  role: ActorRole;
}

export interface Student {
  id: string;
  name: string;
  /** 监护人（家长）标识。 */
  guardianId: string;
  guardianName: string;
  groupId: string;
}

export interface Mentor extends Person {
  role: "mentor";
  /** 当班安排：key 为实践小组，value 为班次起止时间。 */
  dutyAssignments: DutyAssignment[];
}

export interface DutyAssignment {
  groupId: string;
  startsAt: Timestamp;
  endsAt: Timestamp;
}

export interface SafetyOfficer extends Person {
  role: "safety_officer";
}

/**
 * 某学生针对某风险等级的资质。
 * 状态机：training -> active -> expired（到期未复认证）；
 * active/expired -> suspended（安全处置），复查后可恢复。
 */
export interface Qualification {
  id: string;
  studentId: string;
  riskLevel: RiskLevel;
  state: QualificationState;
  /** 培训课程版本，事故追溯的关键证据。 */
  trainingVersion: string;
  trainedAt: Timestamp;
  /** 本次认证有效期；过期后 state 应为 expired。 */
  validUntil: Timestamp;
  /** 最近一次复认证时间。 */
  recertifiedAt: Timestamp | null;
}

/** 工具（可借出的实物个体，如一台激光切割机或一把热熔胶枪）。 */
export interface Tool {
  id: string;
  name: string;
  /** 工具型号的风险等级，决定准入条件组合。 */
  riskLevel: RiskLevel;
  /** 所属设备（如激光切割机机身）；手持小工具可与设备同 id。 */
  equipmentId: string;
  /** 当前库存数量（并发领料需要守住的下限为 0）。 */
  stock: number;
}

export interface Equipment {
  id: string;
  name: string;
  status: EquipmentStatus;
  /** 停用/锁定原因说明。 */
  statusReason: string | null;
}

/**
 * 安全公告：生效后立刻拒绝相关工具的新领用，即使其他条件全部满足。
 * 通过 riskLevel 或精确 toolId 圈定影响范围。
 */
export interface SafetyNotice {
  id: string;
  title: string;
  riskLevel: RiskLevel | null;
  toolId: string | null;
  effectiveAt: Timestamp;
  /** 撤销时间；null 表示持续生效。 */
  revokedAt: Timestamp | null;
}

/** 材料批次，领用必须记录实际发放批次。 */
export interface MaterialBatch {
  id: string;
  name: string;
  /** 批次状态：可用才能用于新领用。 */
  active: boolean;
  /** 该批次适配的工具型号；空数组表示通用耗材。 */
  toolIds: string[];
}

/**
 * 监护授权：监护人对“学生 + 风险等级”在有效期内的确认。
 * restricted 工具必须持有有效授权（对应耗材领用记录需监护人确认）。
 */
export interface GuardianConsent {
  id: string;
  studentId: string;
  riskLevel: RiskLevel;
  guardianId: string;
  grantedAt: Timestamp;
  validUntil: Timestamp;
  revokedAt: Timestamp | null;
}

/** 借用记录状态。 */
export type LoanStatus = "open" | "returned" | "locked";

export interface Loan {
  id: string;
  /** 领用的工具型号/物料条目。 */
  toolId: string;
  studentId: string;
  mentorId: string;
  groupId: string;
  quantity: number;
  materialBatchId: string | null;
  checkedOutAt: Timestamp;
  /** 幂等键：同一张卡（同一卡序列号）重复刷卡只产生一次借出。 */
  cardSwipeId: string;
  status: LoanStatus;
  returnedAt: Timestamp | null;
  /** 关联事故（被锁定时）。 */
  incidentId: string | null;
  /** 借出当时冻结的全部准入条件。 */
  decisionSnapshot: AdmissionSnapshot;
}

/** 领用时点逐项准入条件的冻结快照，事后可解释“当时凭什么放行”。 */
export interface AdmissionSnapshot {
  decidedAt: Timestamp;
  toolId: string;
  riskLevel: RiskLevel;
  studentId: string;
  qualification: {
    state: QualificationState;
    trainingVersion: string;
    validUntil: Timestamp;
    recertifiedAt: Timestamp | null;
  };
  mentor: {
    mentorId: string;
    onDuty: boolean;
    assignment: DutyAssignment | null;
  };
  guardianConsent: {
    required: boolean;
    consentId: string | null;
    validUntil: Timestamp | null;
  };
  materialBatch: {
    required: boolean;
    batchId: string | null;
    active: boolean;
  };
  equipment: {
    equipmentId: string;
    status: EquipmentStatus;
  };
  safetyNotices: string[];
  /** 逐条判定结果。 */
  conditions: ConditionResult[];
  admitted: boolean;
}

export interface ConditionResult {
  code: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface Incident {
  id: string;
  toolId: string;
  equipmentId: string;
  loanId: string | null;
  studentId: string;
  mentorId: string;
  materialBatchId: string | null;
  reportedAt: Timestamp;
  description: string;
  /** 事故发生时关联的培训版本（从资质快照/当前资质带出）。 */
  trainingVersion: string | null;
  status: "open" | "reviewed" | "cleared";
  /** 锁定的借用记录 id 列表（独立于普通归还）。 */
  lockedLoanIds: string[];
  review: IncidentReview | null;
}

export interface IncidentReview {
  reviewedAt: Timestamp;
  safetyOfficerId: string;
  finding: string;
  /** 复查结论是否解除设备锁定。 */
  cleared: boolean;
}

/** 事件流水（checkout_events 枚举的落地）。 */
export interface CheckoutEventRecord {
  id: string;
  loanId: string;
  type: CheckoutEventType;
  at: Timestamp;
  actorId: string;
  note?: string;
}

export interface CheckoutRequest {
  studentId: string;
  toolId: string;
  mentorId: string;
  groupId: string;
  cardSwipeId: string;
  quantity?: number;
  materialBatchId?: string | null;
  now?: Timestamp;
}

export interface AdmissionDecision {
  admitted: boolean;
  conditions: ConditionResult[];
  snapshot: AdmissionSnapshot;
}
