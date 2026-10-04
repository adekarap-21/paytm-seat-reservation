import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';

describe('ops', () => {
  it('GET /healthz returns 200 ok', async () => {
    const res = await request(createApp()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /metrics returns Prometheus text with http_requests_total', async () => {
    const app = createApp();
    await request(app).get('/healthz');
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('http_requests_total');
  });
});
