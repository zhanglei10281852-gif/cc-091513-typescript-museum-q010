import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  CheckoutEventRecord,
  Equipment,
  GuardianConsent,
  Incident,
  Loan,
  MaterialBatch,
  Mentor,
  Qualification,
  SafetyNotice,
  SafetyOfficer,
  Student,
  Tool,
} from "../domain/types.js";

export interface StoreData {
  students: Student[];
  mentors: Mentor[];
  safetyOfficers: SafetyOfficer[];
  qualifications: Qualification[];
  tools: Tool[];
  equipment: Equipment[];
  notices: SafetyNotice[];
  materialBatches: MaterialBatch[];
  consents: GuardianConsent[];
  loans: Loan[];
  incidents: Incident[];
  events: CheckoutEventRecord[];
}

export function emptyStoreData(): StoreData {
  return {
    students: [],
    mentors: [],
    safetyOfficers: [],
    qualifications: [],
    tools: [],
    equipment: [],
    notices: [],
    materialBatches: [],
    consents: [],
    loans: [],
    incidents: [],
    events: [],
  };
}

/**
 * JSON 文件存储。进程内通过承诺链互斥队列串行化所有写操作，
 * 保证并发领料时“判定—扣库存—落库”不会交错执行。
 */
export class JsonStore {
  private data: StoreData;
  private tail: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private readonly file: string | null;

  constructor(file: string | null) {
    this.file = file;
    this.data = emptyStoreData();
  }

  async load(): Promise<void> {
    if (!this.file) {
      this.loaded = true;
      return;
    }
    try {
      const raw = await readFile(this.file, "utf8");
      this.data = { ...emptyStoreData(), ...(JSON.parse(raw) as StoreData) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  /** 在读/写快照上执行只读操作。 */
  async read<T>(fn: (data: StoreData) => T): Promise<T> {
    if (!this.loaded) await this.load();
    return fn(this.data);
  }

  /**
   * 排他执行变更：同一时刻只有一个变更临界区在运行，
   * fn 返回后原子写盘，写盘失败则本次变更不生效。
   */
  async mutate<T>(fn: (data: StoreData) => T | Promise<T>): Promise<T> {
    if (!this.loaded) await this.load();
    const run = this.tail.then(async () => {
      const result = await fn(this.data);
      await this.persist();
      return result;
    });
    // 队列不因单次失败断裂：吞掉已对调用方暴露的拒绝。
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async persist(): Promise<void> {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await rename(tmp, this.file);
  }
}
