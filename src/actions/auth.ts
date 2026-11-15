// Bootstrap & auth actions: getbootstrap, login, logout, setupworkspace,
// registerworkspace, updatemylanguage.
import { query, withTx, txQuery, Tx } from '../db';
import { ApiError } from '../errors';
import { checkPassword, createSession, deleteSession, hashPassword, publicUser, requireAuth } from '../auth';
import { mapPlan } from '../lib/common';
import { optStr, reqStr } from '../util';
import { HandlerCtx } from './types';

async function listPlans(): Promise<Record<string, unknown>[]> {
  const res = await query('SELECT * FROM plans ORDER BY id');
  return res.rows.map(mapPlan);
}

async function createWorkspaceWithAdmin(input: {
  workspaceName: string;
  ownerName: string;
  adminName: string;
  username: string;
  password: string;
  currency: string;
  language: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  plan: string;
}): Promise<{ token: string; user: Record<string, unknown> }> {
  if (input.username.length < 3) throw new ApiError('Username must be at least 3 characters', 400);
  if (input.password.length < 4) throw new ApiError('Password must be at least 4 characters', 400);
  const planRes = await query('SELECT id FROM plans WHERE name = $1', [input.plan]);
  if (planRes.rows.length === 0) throw new ApiError(`Unknown plan: ${input.plan}`, 400);
  const planId = planRes.rows[0].id as number;

  return withTx(async (client) => {
    const ws = await txQuery<{ id: number }>(
      client,
      'INSERT INTO workspaces (name, owner_name, phone, email, address) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [input.workspaceName, input.ownerName, input.phone, input.email, input.address],
    );
    const workspaceId = ws.rows[0].id;
    const branch = await txQuery<{ id: number }>(
      client,
      "INSERT INTO branches (workspace_id, name, is_main) VALUES ($1, 'Main Branch', TRUE) RETURNING id",
      [workspaceId],
    );
    const branchId = branch.rows[0].id;
    const passwordHash = await hashPassword(input.password);
    const user = await txQuery<{ id: number }>(
      client,
      `INSERT INTO users (workspace_id, branch_id, name, username, password_hash, role, language)
       VALUES ($1,$2,$3,$4,$5,'Admin',$6) RETURNING id`,
      [workspaceId, branchId, input.adminName, input.username, passwordHash, input.language],
    );
    const userId = user.rows[0].id;
    await txQuery(
      client,
      `INSERT INTO app_settings (workspace_id, currency, tax_rate, language)
       VALUES ($1,$2,0,$3)`,
      [workspaceId, input.currency, input.language],
    );
    const endsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await txQuery(
      client,
      `INSERT INTO subscriptions (workspace_id, plan_id, billing_cycle, status, ends_at)
       VALUES ($1,$2,'monthly', $3, $4)`,
      [workspaceId, planId, input.plan === 'Free Trial' ? 'trial' : 'active', endsAt.toISOString()],
    );
    const token = await createSessionTx(client, userId);
    const sessionUser = {
      id: userId,
      workspaceId,
      workspaceName: input.workspaceName,
      workspaceStatus: 'active',
      branchId,
      name: input.adminName,
      username: input.username,
      role: 'Admin',
      language: input.language,
      isActive: true,
      isSwmAdmin: false,
    };
    return { token, user: publicUser(sessionUser) };
  });
}

// createSession needs the same transaction so the session is atomic with
// the workspace creation; the public helper uses its own connection.
async function createSessionTx(client: Tx, userId: number): Promise<string> {
  const crypto = await import('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  const secret = process.env.SESSION_SECRET || 'pharmapro-dev-secret';
  const tokenHash = crypto.createHmac('sha256', secret).update(token).digest('hex');
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await txQuery(client, 'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1,$2,$3)', [
    userId,
    tokenHash,
    expires.toISOString(),
  ]);
  return token;
}

export async function getbootstrap(ctx: HandlerCtx, _body: Record<string, unknown>): Promise<unknown> {
  const count = await query<{ n: string }>('SELECT COUNT(*)::text AS n FROM workspaces');
  const plans = await listPlans();
  const result: Record<string, unknown> = {
    hasWorkspace: Number(count.rows[0].n) > 0,
    plans,
    session: null,
  };
  if (ctx.auth) result.session = publicUser(ctx.auth.user);
  return result;
}

export async function login(_ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const username = reqStr(body, 'username');
  const password = reqStr(body, 'password');
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
    password_hash: string;
  }>(
    `SELECT u.id, u.workspace_id, w.name AS workspace_name, w.status AS workspace_status,
            u.branch_id, u.name, u.username, u.role, u.language, u.is_active, u.is_swm_admin,
            u.password_hash
       FROM users u JOIN workspaces w ON w.id = u.workspace_id
      WHERE u.username = $1
      ORDER BY u.id ASC`,
    [username],
  );
  const row = res.rows[0];
  if (!row || !row.is_active) throw new ApiError('Login failed. Check the username and password.', 401);
  if (row.workspace_status === 'suspended') {
    throw new ApiError('This workspace is suspended. Contact SWM support.', 403);
  }
  if (!(await checkPassword(password, row.password_hash))) {
    throw new ApiError('Login failed. Check the username and password.', 401);
  }
  const token = await createSession(row.id);
  const sessionUser = {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    workspaceStatus: row.workspace_status,
    branchId: row.branch_id,
    name: row.name,
    username: row.username,
    role: row.role,
    language: row.language,
    isActive: row.is_active,
    isSwmAdmin: row.is_swm_admin,
  };
  return { token, user: publicUser(sessionUser) };
}

export async function logout(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const token = body.token as string | undefined;
  if (token) await deleteSession(token);
  return { ok: true };
}

export async function setupworkspace(_ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const existing = await query<{ n: string }>('SELECT COUNT(*)::text AS n FROM workspaces');
  if (Number(existing.rows[0].n) > 0) {
    throw new ApiError('A workspace already exists. Use registerworkspace to create another one.', 400);
  }
  return createWorkspaceWithAdmin({
    workspaceName: reqStr(body, 'workspaceName'),
    ownerName: reqStr(body, 'ownerName'),
    adminName: reqStr(body, 'adminName'),
    username: reqStr(body, 'username'),
    password: reqStr(body, 'password'),
    currency: optStr(body, 'currency', 'AFN'),
    language: optStr(body, 'language', 'fa'),
    phone: (optStr(body, 'phone', '') || null) as string | null,
    email: (optStr(body, 'email', '') || null) as string | null,
    address: (optStr(body, 'address', '') || null) as string | null,
    plan: optStr(body, 'plan', 'Free Trial'),
  });
}

export async function registerworkspace(_ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  return createWorkspaceWithAdmin({
    workspaceName: reqStr(body, 'workspaceName'),
    ownerName: reqStr(body, 'ownerName'),
    adminName: optStr(body, 'adminName', reqStr(body, 'ownerName')),
    username: reqStr(body, 'username'),
    password: reqStr(body, 'password'),
    currency: optStr(body, 'currency', 'AFN'),
    language: optStr(body, 'language', 'fa'),
    phone: (optStr(body, 'phone', '') || null) as string | null,
    email: (optStr(body, 'email', '') || null) as string | null,
    address: (optStr(body, 'address', '') || null) as string | null,
    plan: optStr(body, 'plan', 'Free Trial'),
  });
}

export async function updatemylanguage(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const language = reqStr(body, 'language');
  if (!['en', 'fa', 'ps', 'ar'].includes(language)) {
    throw new ApiError('language must be one of en, fa, ps, ar', 400);
  }
  await query('UPDATE users SET language = $1 WHERE id = $2', [language, auth.user.id]);
  return { ok: true, language };
}
