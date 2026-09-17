/**
 * 公开枚举，取值与 reference/domain.json 保持一致。
 */

export const RISK_LEVELS = ["basic", "supervised", "restricted"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const QUALIFICATION_STATES = [
  "training",
  "active",
  "expired",
  "suspended",
] as const;
export type QualificationState = (typeof QUALIFICATION_STATES)[number];

export const CHECKOUT_EVENTS = [
  "checked_out",
  "returned",
  "overdue",
  "locked",
] as const;
export type CheckoutEventType = (typeof CHECKOUT_EVENTS)[number];

/** 设备状态：可用 / 事故锁定 / 停用（报废或长期下线）。 */
export const EQUIPMENT_STATUSES = [
  "available",
  "locked",
  "decommissioned",
] as const;
export type EquipmentStatus = (typeof EQUIPMENT_STATUSES)[number];

export const ACTOR_ROLES = ["student", "mentor", "safety_officer"] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];
