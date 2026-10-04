export class DomainError extends Error {
  constructor(public code: string, public status: number, message: string) {
    super(message);
    this.name = 'DomainError';
  }
}
export class ValidationError extends DomainError { constructor(msg: string) { super('validation_error', 400, msg); } }
export class NotFoundError   extends DomainError { constructor(msg: string) { super('not_found',       404, msg); } }
export class ConflictError   extends DomainError { constructor(code: string, msg: string) { super(code, 409, msg); } }
export class ForbiddenError  extends DomainError { constructor(msg: string) { super('forbidden',       403, msg); } }
export class UnauthorizedError extends DomainError { constructor(msg: string) { super('unauthorized',  401, msg); } }
