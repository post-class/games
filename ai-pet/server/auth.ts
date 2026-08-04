import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Db } from './db.js';

const SCRYPT_KEYLEN = 32;
export const SESSION_COOKIE = 'ai_pet_session';

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;
  const key = scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN);
  const expected = Buffer.from(keyHex, 'hex');
  if (expected.length !== key.length) return false;
  return timingSafeEqual(key, expected);
}

export interface AuthedRequest extends Request {
  userId?: number;
}

export function createSession(database: Db, userId: number): string {
  const token = randomBytes(24).toString('base64url');
  database
    .prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now());
  return token;
}

export function destroySession(database: Db, token: string): void {
  database.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function userIdForToken(database: Db, token: string | undefined): number | null {
  if (!token) return null;
  const row = database.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as
    | { user_id: number }
    | undefined;
  return row ? row.user_id : null;
}

/** Cookie ヘッダを自前で読む（cookie-parser を入れない）。 */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

export function setSessionCookie(res: Response, token: string): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`,
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/** ログイン必須ルート用ミドルウェア。 */
export function requireAuth(database: Db) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const userId = userIdForToken(database, readCookie(req, SESSION_COOKIE));
    if (userId === null) {
      res.status(401).json({ error: 'ログインが必要です' });
      return;
    }
    req.userId = userId;
    database.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), userId);
    next();
  };
}

export function validateUserName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 16) return null;
  if (!/^[\p{L}\p{N}_-]+$/u.test(trimmed)) return null;
  return trimmed;
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string') return null;
  if (password.length < 4 || password.length > 128) return null;
  return password;
}
