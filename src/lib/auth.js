import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, JWT_TTL, ROLES } from '../config.js';
import { User } from '../models/index.js';
import { unauthorized, forbidden } from './http.js';

export function signToken(user) {
  return jwt.sign({ sub: String(user._id), role: user.role }, JWT_SECRET, { expiresIn: JWT_TTL });
}

/** scrypt with a per-password salt — used only for the admin dashboard login. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/** Verifies the bearer token and loads the user; rejects blocked accounts. */
export async function authenticate(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized();

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      throw unauthorized('Session expired, please sign in again');
    }

    const user = await User.findById(payload.sub);
    if (!user) throw unauthorized('Account no longer exists');
    if (user.status === 'blocked') {
      throw forbidden(user.blockReason || 'This account has been blocked. Please contact support.');
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Route guard: `requireRole('helper')`. */
export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden(`Requires ${roles.join(' or ')} access`));
    next();
  };

export const requireAdmin = requireRole(ROLES.ADMIN);
