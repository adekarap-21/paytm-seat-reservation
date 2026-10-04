import { describe, it, expect } from 'vitest';
import { ReserveBody } from '../../src/routes/reserve.js';

describe('reserve request validation', () => {
  it('test_rejects_duplicate_seat_ids', () => {
    const r = ReserveBody.safeParse({ seats: ['A12', 'A12'], idempotency_key: 'k1' });
    expect(r.success).toBe(false);
  });
  it('rejects empty seats', () => {
    const r = ReserveBody.safeParse({ seats: [], idempotency_key: 'k' });
    expect(r.success).toBe(false);
  });
  it('rejects empty idem key', () => {
    const r = ReserveBody.safeParse({ seats: ['A1'], idempotency_key: '' });
    expect(r.success).toBe(false);
  });
  it('accepts a valid single-seat body', () => {
    const r = ReserveBody.safeParse({ seats: ['A1'], idempotency_key: 'k1' });
    expect(r.success).toBe(true);
  });
});
