import { ulid } from 'ulid';
import type { RequestHandler } from 'express';

declare global {
  namespace Express { interface Request { id: string; } }
}

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('X-Request-Id');
  req.id = incoming && /^[A-Z0-9]{26}$/.test(incoming) ? incoming : ulid();
  res.setHeader('X-Request-Id', req.id);
  next();
};
