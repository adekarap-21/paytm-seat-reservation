import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { UnauthorizedError } from '../domain/errors.js';
import { config } from '../config.js';
import { userIdForToken } from '../auth.js';

declare global {
  namespace Express { interface Request { userId?: number; } }
}

export const requireUser: RequestHandler = (req, _res, next) => {
  const h = req.header('Authorization');
  if (!h || !h.startsWith('Bearer ')) return next(new UnauthorizedError('missing bearer token'));
  const token = h.slice(7).trim();
  const uid = userIdForToken(token);
  if (!uid) return next(new UnauthorizedError('invalid token'));
  req.userId = uid;
  next();
};

export const requireAdmin: RequestHandler = (req, _res, next) => {
  const got = req.header('X-Admin-Token') ?? '';
  const want = config.adminToken;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return next(new UnauthorizedError('invalid admin token'));
  }
  next();
};
