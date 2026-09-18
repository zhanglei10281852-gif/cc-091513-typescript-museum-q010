import { validationError } from "../domain/errors.js";

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    validationError(`字段 ${field} 必须是非空字符串`, { field });
  }
  return value;
}

export function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, field);
}

export function requireId(value: unknown, field: string): string {
  return requireString(value, field);
}

export function requireInteger(value: unknown, field: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    validationError(`字段 ${field} 必须是不小于 ${min} 的整数`, { field });
  }
  return value;
}

export function requireOneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    validationError(`字段 ${field} 必须是 ${allowed.join(" / ")} 之一`, { field, allowed });
  }
  return value as T;
}

export function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) validationError(`字段 ${field} 必须是数组`, { field });
  return value;
}
