import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestsCounter = new Counter({
  name: 'http_requests_total', help: 'HTTP requests',
  labelNames: ['method','route','status'], registers: [registry],
});
export const reservationsCounter = new Counter({
  name: 'reservations_total', help: 'Reservation outcomes',
  labelNames: ['outcome','show_id'], registers: [registry],
});
export const cancellationsCounter = new Counter({
  name: 'cancellations_total', help: 'Cancellations',
  labelNames: ['show_id'], registers: [registry],
});
export const reserveLatencyHistogram = new Histogram({
  name: 'reserve_latency_seconds', help: 'POST /reserve latency',
  labelNames: ['show_id'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});
export const seatsAvailableGauge = new Gauge({
  name: 'seats_available', help: 'Available seats per show',
  labelNames: ['show_id'], registers: [registry],
});
export const seatsConfirmedGauge = new Gauge({
  name: 'seats_confirmed', help: 'Confirmed seats per show',
  labelNames: ['show_id'], registers: [registry],
});
export const sseSubscribersGauge = new Gauge({
  name: 'sse_subscribers', help: 'Current SSE subscribers per show',
  labelNames: ['show_id'], registers: [registry],
});
