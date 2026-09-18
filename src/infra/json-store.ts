import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { State } from "../domain/types.js";

export function emptyState(): State {
  return {
    seq: 0,
    people: {},
    groups: {},
    tools: {},
    qualifications: [],
    duties: [],
    consents: [],
    materialBatches: {},
    safetyNotices: [],
    loans: [],
    incidents: [],
    decisions: [],
  };
}

/**
 * JSON 文件存储。变更在同步临界区内完成并原子落盘（临时文件 + rename），
 * 保证并发领料的库存判定与持久化一致。
 */
export class JsonStore {
  private state: State;
  private saving = false;

  constructor(private readonly file: string | null) {
    this.state = file && existsSync(file) ? this.load(file) : emptyState();
  }

  private load(file: string): State {
    const raw = readFileSync(file, "utf8").trim();
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as Partial<State>;
    return { ...emptyState(), ...parsed };
  }

  get(): State {
    return this.state;
  }

  /** 在同步临界区内读取并变更状态，随后立即原子持久化。 */
  mutate<T>(fn: (state: State) => T): T {
    const result = fn(this.state);
    this.persist();
    return result;
  }

  nextId(prefix: string): string {
    this.state.seq += 1;
    return `${prefix}_${this.state.seq.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  reset(): void {
    this.state = emptyState();
    this.persist();
  }

  private persist(): void {
    if (!this.file) return;
    if (this.saving) throw new Error("store is not reentrant");
    this.saving = true;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
      renameSync(tmp, this.file);
    } finally {
      this.saving = false;
    }
  }
}
