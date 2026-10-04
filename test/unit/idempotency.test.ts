import { describe, it, expect } from 'vitest';
import { normalize, hashBody } from '../../src/domain/idempotency.js';

describe('idempotency normalize + hash', () => {
  it('sorts seats and trims key', () => {
    const n = normalize({ seats: ['A2','A1'], idempotency_key: ' k  ' });
    expect(n).toEqual({ seats: ['A1','A2'], idempotency_key: 'k' });
  });
  it('hash is deterministic', () => {
    const h1 = hashBody({ seats: ['A1','A2'], idempotency_key: 'k' });
    const h2 = hashBody({ seats: ['A1','A2'], idempotency_key: 'k' });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
  it('different bodies hash differently', () => {
    const h1 = hashBody({ seats: ['A1'], idempotency_key: 'k' });
    const h2 = hashBody({ seats: ['A2'], idempotency_key: 'k' });
    expect(h1).not.toBe(h2);
  });
});
