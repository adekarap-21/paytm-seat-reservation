import type { RequestHandler } from 'express';
import { httpRequestsCounter } from '../metrics.js';

export const httpMetrics: RequestHandler = (req, res, next) => {
  res.on('finish', () => {
    const route = req.route?.path ?? req.path;
    httpRequestsCounter.inc({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
};
