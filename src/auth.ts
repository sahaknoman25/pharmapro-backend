// Auth: bcrypt password hashing, random session tokens stored hashed
// (sha256) with expiry. A token identifies the user AND the workspace.
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query } from './db';
import { ApiError } from './errors';

export interface SessionUser {
  id: number;
  workspaceId: number;
  workspaceName: string;
  workspaceStatus: string;
  branchId: number | null;
  name: string;
  username: string;
  role: string;
  language: string;
  isActive: boolean;
  isSwmAdmin: boolean;
}

export interface AuthContext {
  user: SessionUser;
  workspaceId: number;
}

const SESSION_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function checkPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

function hashToken(token: string): string {
  const secret = process.env.SESSION_SECRET || 'pharmapro-dev-secret';
  return crypto.createHmac('sha256', secret).update(token).digest('hex');
}

export async function createSession(userId: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await query(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, hashToken(token), expires.toISOString()],
  );
  return token;
}

export async function deleteSession(token: string): Promise<void> {
  await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

/** Resolves a raw token to its user + workspace, or null if invalid/expired. */
export async function resolveToken(token: string | undefined | null): Promise<AuthContext | null> {
  if (!token || typeof token !== 'string') return null;
  const res = await query<{
    id: number;
    workspace_id: number;
    workspace_name: string;
    workspace_status: string;
    branch_id: number | null;
    name: string;
    username: string;
    role: string;
    language: string;
    is_active: boolean;
    is_swm_admin: boolean;
  }>(
    `SELECT u.id, u.workspace_id, w.name AS workspace_name, w.status AS workspace_status,
            u.branch_id, u.name, u.username, u.role, u.language, u.is_active, u.is_swm_admin
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN workspaces w ON w.id = u.workspace_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  if (!r.is_active) return null;
  return {
    user: {
      id: r.id,
      workspaceId: r.workspace_id,
      workspaceName: r.workspace_name,
      workspaceStatus: r.workspace_status,
      branchId: r.branch_id,
      name: r.name,
      username: r.username,
      role: r.role,
      language: r.language,
      isActive: r.is_active,
      isSwmAdmin: r.is_swm_admin,
    },
    workspaceId: r.workspace_id,
  };
}

export function requireAuth(ctx: AuthContext | null): AuthContext {
  if (!ctx) throw new ApiError('Not signed in. Please log in again.', 401);
  if (ctx.user.workspaceStatus === 'suspended') {
    throw new ApiError('This workspace is suspended. Contact SWM support.', 403);
  }
  return ctx;
}

export function requireRoles(ctx: AuthContext, roles: string[]): void {
  if (!roles.includes(ctx.user.role)) {
    throw new ApiError(`Role ${ctx.user.role} is not allowed to do this.`, 403);
  }
}

export function requireSwmAdmin(ctx: AuthContext): void {
  if (!ctx.user.isSwmAdmin) {
    throw new ApiError('Only the SWM platform admin can do this.', 403);
  }
}

export function publicUser(u: SessionUser): Record<string, unknown> {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    branchId: u.branchId,
    language: u.language,
    workspaceId: u.workspaceId,
    workspaceName: u.workspaceName,
  };
}
