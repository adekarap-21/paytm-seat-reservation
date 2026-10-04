import { describe, it, expect } from 'vitest';
import { DomainError, ValidationError, NotFoundError } from '../../src/domain/errors.js';

describe('DomainError', () => {
  it('ValidationError is 400 validation_error', () => {
    const e = new ValidationError('bad');
    expect(e.status).toBe(400);
    expect(e.code).toBe('validation_error');
  });
  it('NotFoundError is 404 not_found', () => {
    const e = new NotFoundError('nope');
    expect(e.status).toBe(404);
    expect(e.code).toBe('not_found');
  });
  it('DomainError instances are catchable', () => {
    const e = new DomainError('x', 418, 'teapot');
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(418);
  });
});
