// 领域错误：携带稳定 code，HTTP 层据此映射状态码。

export type DomainErrorCode =
  | "not_found"
  | "conflict"
  | "validation"
  | "access_denied";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: unknown;

  constructor(code: DomainErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function notFound(kind: string, id: string): never {
  throw new DomainError("not_found", `${kind} 不存在: ${id}`, { kind, id });
}

export function conflict(message: string, details?: unknown): never {
  throw new DomainError("conflict", message, details);
}

export function validationError(message: string, details?: unknown): never {
  throw new DomainError("validation", message, details);
}
