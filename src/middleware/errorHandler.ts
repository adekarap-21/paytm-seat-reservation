import type { ErrorRequestHandler } from 'express';
import { DomainError } from '../domain/errors.js';
import { logger } from '../logger.js';

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof DomainError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  logger.error({ err, req_id: req.id, route: req.path }, 'unhandled_error');
  res.status(500).json({ error: 'internal_error', message: 'internal server error' });
};
