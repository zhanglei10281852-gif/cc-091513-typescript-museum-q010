import type {
  Equipment,
  GuardianConsent,
  MaterialBatch,
  Mentor,
  Qualification,
  SafetyNotice,
  Student,
  Timestamp,
  Tool,
} from "./types.js";

/** 准入判定所需的只读上下文，由服务层装配后交给纯函数策略。 */
export interface AdmissionContext {
  now: Timestamp;
  tool: Tool;
  equipment: Equipment;
  student: Student;
  mentor: Mentor | null;
  /** 请求中指定的当班导师（可能查无此人）。 */
  mentorId: string;
  /** 学生对该风险等级的最新资质。 */
  qualification: Qualification | null;
  consent: GuardianConsent | null;
  /** 该工具型号是否需要登记材料批次（是否有匹配的活跃批次可发）。 */
  materialRequired: boolean;
  materialBatch: MaterialBatch | null;
  requestedBatchId: string | null;
  /** 判定时点生效中的安全公告。 */
  activeNotices: SafetyNotice[];
  requestedQuantity: number;
}
