// Employees, branches, settings, subscription, backup/restore, SWM admin.
import { query, withTx, txQuery } from '../db';
import { ApiError } from '../errors';
import { hashPassword, requireAuth, requireRoles, requireSwmAdmin } from '../auth';
import { audit, mapAudit, mapBranch, mapEmployee, mapPlan } from '../lib/common';
import {
  fmtDate,
  fmtTs,
  optBool,
  optInt,
  optIntNull,
  optStr,
  optStrNull,
  reqInt,
  reqNum,
  reqStr,
} from '../util';
import { HandlerCtx } from './types';

export async function listusers(ctx: HandlerCtx, _body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const res = await query<Record<string, unknown>>(
    'SELECT * FROM users WHERE workspace_id = $1 ORDER BY name ASC',
    [auth.workspaceId],
  );
  return res.rows.map(mapEmployee);
}

export async function saveuser(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  requireRoles(auth, ['Admin']);
  const name = reqStr(body, 'name');
  const id = body.id === undefined || body.id === null ? null : (body.id as number);
  if (id !== null && !Number.isInteger(id)) throw new ApiError('id must be an integer', 400);
  const username = optStrNull(body, 'username');
  const password = optStr(body, 'password', '');
  const role = optStr(body, 'role', 'Cashier');
  if (!['Admin', 'Pharmacist', 'Cashier', 'Inventory Manager'].includes(role)) {
    throw new ApiError('Invalid role', 400);
  }
  const shift = optStr(body, 'shift', 'Day');
  const branchId = optIntNull(body, 'branchId');
  const isActive = optBool(body, 'isActive', true);
  const language = optStr(body, 'language', 'fa');

  if (branchId !== null) {
    const b = await query('SELECT id FROM branches WHERE id = $1 AND workspace_id = $2', [
      branchId,
      auth.workspaceId,
    ]);
    if (b.rows.length === 0) throw new ApiError('Branch not found', 404);
  }

  if (id === null) {
    if (!username || username.length < 3) throw new ApiError('username (min 3) is required', 400);
    if (password.length < 4) throw new ApiError('password (min 4) is required', 400);
    const passwordHash = await hashPassword(password);
    try {
      const res = await query<Record<string, unknown>>(
        `INSERT INTO users (workspace_id, branch_id, name, username, password_hash, role, shift, language, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [auth.workspaceId, branchId, name, username, passwordHash, role, shift, language, isActive],
      );
      return mapEmployee(res.rows[0]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new ApiError('Username already exists in this workspace', 400);
      }
      throw e;
    }
  }

  const existing = await query<Record<string, unknown>>(
    'SELECT * FROM users WHERE id = $1 AND workspace_id = $2',
    [id, auth.workspaceId],
  );
  if (existing.rows.length === 0) throw new ApiError('User not found', 404);
  const current = existing.rows[0];
  // Never deactivate the last active Admin.
  if (current.role === 'Admin' && isActive === false) {
    const admins = await query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM users WHERE workspace_id=$1 AND role='Admin' AND is_active=TRUE AND id <> $2",
      [auth.workspaceId, id],
    );
    if (Number(admins.rows[0].n) === 0) {
      throw new ApiError('Cannot deactivate the last active Admin', 400);
    }
  }
  const sets: string[] = [
    'name=$3', 'role=$4', 'shift=$5', 'branch_id=$6', 'is_active=$7', 'language=$8',
  ];
  const params: unknown[] = [id, auth.workspaceId, name, role, shift, branchId, isActive, language];
  if (username) {
    sets.push(`username=$${params.length + 1}`);
    params.push(username);
  }
  if (password) {
    if (password.length < 4) throw new ApiError('password must be at least 4 characters', 400);
    sets.push(`password_hash=$${params.length + 1}`);
    params.push(await hashPassword(password));
  }
  const res = await query<Record<string, unknown>>(
    `UPDATE users SET ${sets.join(', ')} WHERE id=$1 AND workspace_id=$2 RETURNING *`,
    params,
  );
  return mapEmployee(res.rows[0]);
}

export async function listbranches(ctx: HandlerCtx, _body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const res = await query<Record<string, unknown>>(
    'SELECT * FROM branches WHERE workspace_id = $1 ORDER BY is_main DESC, id ASC',
    [auth.workspaceId],
  );
  return res.rows.map(mapBranch);
}

export async function savebranch(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  requireRoles(auth, ['Admin']);
  const name = reqStr(body, 'name');
  const address = optStrNull(body, 'address');
  const phone = optStrNull(body, 'phone');
  const res = await query<Record<string, unknown>>(
    `INSERT INTO branches (workspace_id, name, address, phone, is_main)
     VALUES ($1,$2,$3,$4,FALSE) RETURNING *`,
    [auth.workspaceId, name, address, phone],
  );
  return mapBranch(res.rows[0]);
}

export async function updateworkspacesettings(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  requireRoles(auth, ['Admin']);
  const name = reqStr(body, 'name');
  const currency = reqStr(body, 'currency');
  const taxRate = reqNum(body, 'taxRate');
  if (taxRate < 0 || taxRate > 100) throw new ApiError('taxRate must be 0-100', 400);
  const language = reqStr(body, 'language');
  if (!['en', 'fa', 'ps', 'ar'].includes(language)) {
    throw new ApiError('language must be one of en, fa, ps, ar', 400);
  }
  const address = optStrNull(body, 'address');
  const phone = optStrNull(body, 'phone');
  const email = optStrNull(body, 'email');
  await query('UPDATE workspaces SET name=$2, phone=$3, email=$4, address=$5 WHERE id=$1', [
    auth.workspaceId, name, phone, email, address,
  ]);
  await query(
    `INSERT INTO app_settings (workspace_id, currency, tax_rate, language)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (workspace_id) DO UPDATE SET currency=$2, tax_rate=$3, language=$4`,
    [auth.workspaceId, currency, taxRate, language],
  );
  return { name, currency, taxRate, language, address: address ?? undefined, phone: phone ?? undefined, email: email ?? undefined };
}

export async function getsubscription(ctx: HandlerCtx, _body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const sub = await query<Record<string, unknown>>(
    `SELECT s.*, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.workspace_id = $1 ORDER BY s.id DESC LIMIT 1`,
    [auth.workspaceId],
  );
  const plans = await query<Record<string, unknown>>('SELECT * FROM plans ORDER BY id');
  const payments = await query<Record<string, unknown>>(
    'SELECT id, amount, method, created_at FROM platform_payments WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 20',
    [auth.workspaceId],
  );
  const s = sub.rows[0];
  return {
    planName: s?.plan_name,
    status: s?.status,
    billingCycle: s?.billing_cycle,
    startDate: s ? fmtDate(s.started_at) : undefined,
    endDate: s ? fmtDate(s.ends_at) : undefined,
    plans: plans.rows.map(mapPlan),
    payments: payments.rows.map((p) => ({
      id: p.id,
      amount: p.amount,
      method: p.method,
      createdAt: fmtTs(p.created_at) ?? undefined,
    })),
  };
}

export async function changeplan(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  requireRoles(auth, ['Admin']);
  const planName = reqStr(body, 'planName');
  const billingCycle = optStr(body, 'billingCycle', 'monthly');
  if (!['monthly', 'yearly'].includes(billingCycle)) {
    throw new ApiError('billingCycle must be monthly or yearly', 400);
  }
  const method = optStr(body, 'method', 'Cash');
  return withTx(async (client) => {
    const plan = await txQuery<Record<string, unknown>>(
      client,
      'SELECT * FROM plans WHERE name = $1',
      [planName],
    );
    if (plan.rows.length === 0) throw new ApiError(`Unknown plan: ${planName}`, 400);
    const p = plan.rows[0];
    const amount = billingCycle === 'yearly' ? Number(p.price_yearly) : Number(p.price_monthly);
    const current = await txQuery<{ id: number }>(
      client,
      'SELECT id FROM subscriptions WHERE workspace_id=$1 ORDER BY id DESC LIMIT 1',
      [auth.workspaceId],
    );
    const endsAt = new Date(Date.now() + (billingCycle === 'yearly' ? 365 : 30) * 24 * 60 * 60 * 1000);
    let subId: number;
    if (current.rows.length > 0) {
      subId = current.rows[0].id;
      await txQuery(
        client,
        `UPDATE subscriptions SET plan_id=$2, billing_cycle=$3, status='active', started_at=now(), ends_at=$4 WHERE id=$1`,
        [subId, p.id, billingCycle, endsAt.toISOString()],
      );
    } else {
      const created = await txQuery<{ id: number }>(
        client,
        `INSERT INTO subscriptions (workspace_id, plan_id, billing_cycle, status, ends_at)
         VALUES ($1,$2,$3,'active',$4) RETURNING id`,
        [auth.workspaceId, p.id, billingCycle, endsAt.toISOString()],
      );
      subId = created.rows[0].id;
    }
    // Manual billing in v1: record the payment (amount may be 0 until SWM sets prices).
    await txQuery(
      client,
      `INSERT INTO platform_payments (workspace_id, subscription_id, amount, method, note)
       VALUES ($1,$2,$3,$4,$5)`,
      [auth.workspaceId, subId, amount, method, `Plan change to ${planName} (${billingCycle})`],
    );
    await audit(auth.workspaceId, auth.user.id, 'plan_change', `Plan changed to ${planName} (${billingCycle})`, client);
    return { planName, status: 'active', billingCycle, endDate: endsAt.toISOString().slice(0, 10), amount };
  });
}

const EXPORT_TABLES = [
  'medicines', 'batches', 'suppliers', 'purchases', 'purchase_items', 'sales', 'sale_items',
  'customers', 'customer_payments', 'expenses', 'cash_closings', 'stock_movements',
  'transfers', 'branches', 'users', 'subscriptions', 'platform_payments', 'app_settings',
  'audit_logs',
] as const;

export async function exportdata(ctx: HandlerCtx, _body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const ws = await query<Record<string, unknown>>('SELECT * FROM workspaces WHERE id=$1', [auth.workspaceId]);
  const tables: Record<string, unknown[]> = {};
  for (const table of EXPORT_TABLES) {
    // purchase_items / sale_items have no workspace_id — export via parent.
    if (table === 'purchase_items') {
      const rows = await query<Record<string, unknown>>(
        `SELECT pi.* FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
          WHERE p.workspace_id = $1 ORDER BY pi.id`,
        [auth.workspaceId],
      );
      tables[table] = rows.rows;
      continue;
    }
    if (table === 'sale_items') {
      const rows = await query<Record<string, unknown>>(
        `SELECT si.* FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE s.workspace_id = $1 ORDER BY si.id`,
        [auth.workspaceId],
      );
      tables[table] = rows.rows;
      continue;
    }
    const rows = await query<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE workspace_id = $1 ORDER BY id`,
      [auth.workspaceId],
    );
    tables[table] = rows.rows;
  }
  // Users: keep password hashes so the restored workspace can log in with
  // the same credentials (the backup file must be kept safe by the owner).
  const backup = JSON.stringify({
    version: 1,
    kind: 'pharmapro-backup',
    workspace: ws.rows[0],
    exportedAt: new Date().toISOString(),
    tables,
  });
  return { backup, exportedAt: new Date().toISOString() };
}

/**
 * Restore (backend-only endpoint).
 *
 * SAFETY RULE: the backup is NEVER restored over live data. The backup is
 * restored into a NEW, separate workspace (a verified copy), the record
 * counts are checked against the backup, and only then is the copy returned.
 * The original workspace is left untouched. The user switches over by
 * logging into the restored workspace with the same credentials as the
 * backup; the old workspace can be suspended by the SWM admin afterwards.
 */
export async function restore(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  requireRoles(auth, ['Admin']);
  const backupRaw = body.backup;
  if (typeof backupRaw !== 'string' || backupRaw.trim() === '') {
    throw new ApiError('backup (JSON text from exportdata) is required', 400);
  }
  let backup: Record<string, unknown>;
  try {
    backup = JSON.parse(backupRaw) as Record<string, unknown>;
  } catch {
    throw new ApiError('backup is not valid JSON', 400);
  }
  if (backup.kind !== 'pharmapro-backup' || typeof backup.tables !== 'object' || backup.tables === null) {
    throw new ApiError('backup is not a PharmaPro backup file', 400);
  }
  const tables = backup.tables as Record<string, unknown[]>;
  const srcWs = backup.workspace as Record<string, unknown> | undefined;
  if (!srcWs || typeof srcWs.name !== 'string') {
    throw new ApiError('backup has no workspace', 400);
  }

  return withTx(async (client) => {
    const name = `${srcWs.name} (restored ${new Date().toISOString().slice(0, 10)})`;
    const ws = await txQuery<{ id: number }>(
      client,
      'INSERT INTO workspaces (name, owner_name, phone, email, address, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [name, srcWs.owner_name ?? '', srcWs.phone ?? null, srcWs.email ?? null, srcWs.address ?? null, 'active'],
    );
    const newWsId = ws.rows[0].id;

    // ID remapping: old id -> new id, per table, so foreign keys stay valid.
    const idMap: Record<string, Map<number, number>> = {};
    const remap = (table: string, oldId: number | null | undefined): number | null => {
      if (oldId === null || oldId === undefined) return null;
      const m = idMap[table];
      if (!m || !m.has(oldId)) throw new ApiError(`Restore failed: missing ${table} #${oldId}`, 500);
      return m.get(oldId)!;
    };
    const insertRows = async (
      table: string,
      rows: unknown[],
      columns: string[],
      mapRow: (r: Record<string, unknown>) => unknown[],
    ): Promise<void> => {
      idMap[table] = new Map();
      for (const raw of rows as Record<string, unknown>[]) {
        const values = mapRow(raw);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
        const res = await txQuery<{ id: number }>(
          client,
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING id`,
          values,
        );
        idMap[table].set(Number(raw.id), res.rows[0].id);
      }
    };

    const t = (name: string): unknown[] => (tables[name] as unknown[]) ?? [];

    await insertRows('branches', t('branches'),
      ['workspace_id', 'name', 'address', 'phone', 'is_main'],
      (r) => [newWsId, r.name, r.address ?? null, r.phone ?? null, r.is_main ?? false]);

    await insertRows('users', t('users'),
      ['workspace_id', 'branch_id', 'name', 'username', 'password_hash', 'role', 'shift', 'language', 'is_active', 'is_swm_admin'],
      (r) => [newWsId, remap('branches', r.branch_id as number | null), r.name, r.username,
        r.password_hash, r.role, r.shift ?? 'Day', r.language ?? 'fa', r.is_active ?? true, false]);

    await insertRows('app_settings', t('app_settings'),
      ['workspace_id', 'currency', 'tax_rate', 'language'],
      (r) => [newWsId, r.currency ?? 'AFN', r.tax_rate ?? 0, r.language ?? 'fa']);

    await insertRows('medicines', t('medicines'),
      ['workspace_id', 'name', 'generic_name', 'brand_name', 'manufacturer', 'country', 'category',
       'barcode', 'product_code', 'reg_number', 'dosage_form', 'strength', 'unit', 'purchase_price',
       'selling_price', 'min_stock', 'prescription_required', 'description', 'storage_info', 'image_url'],
      (r) => [newWsId, r.name, r.generic_name ?? null, r.brand_name ?? null, r.manufacturer ?? null,
        r.country ?? null, r.category ?? 'Tablets', r.barcode ?? null, r.product_code ?? null,
        r.reg_number ?? null, r.dosage_form ?? 'Tablet', r.strength ?? null, r.unit ?? 'pcs',
        r.purchase_price ?? 0, r.selling_price ?? 0, r.min_stock ?? 10,
        r.prescription_required ?? false, r.description ?? null, r.storage_info ?? null, r.image_url ?? null]);

    await insertRows('batches', t('batches'),
      ['workspace_id', 'branch_id', 'medicine_id', 'batch_number', 'mfg_date', 'expiry_date', 'quantity', 'purchase_price', 'status'],
      (r) => [newWsId, remap('branches', r.branch_id as number), remap('medicines', r.medicine_id as number),
        r.batch_number, r.mfg_date ?? null, r.expiry_date, r.quantity ?? 0, r.purchase_price ?? 0, r.status ?? 'active']);

    await insertRows('suppliers', t('suppliers'),
      ['workspace_id', 'name', 'contact_person', 'phone', 'email', 'address', 'balance'],
      (r) => [newWsId, r.name, r.contact_person ?? null, r.phone ?? null, r.email ?? null, r.address ?? null, r.balance ?? 0]);

    await insertRows('purchases', t('purchases'),
      ['workspace_id', 'branch_id', 'supplier_id', 'invoice_number', 'total', 'paid', 'created_by', 'created_at'],
      (r) => [newWsId, remap('branches', r.branch_id as number), remap('suppliers', r.supplier_id as number | null),
        r.invoice_number ?? null, r.total ?? 0, r.paid ?? 0, remap('users', r.created_by as number | null), r.created_at ?? new Date().toISOString()]);

    await insertRows('purchase_items', t('purchase_items'),
      ['purchase_id', 'medicine_id', 'batch_id', 'batch_number', 'expiry_date', 'mfg_date', 'quantity', 'purchase_price'],
      (r) => [remap('purchases', r.purchase_id as number), remap('medicines', r.medicine_id as number),
        remap('batches', r.batch_id as number | null), r.batch_number, r.expiry_date, r.mfg_date ?? null,
        r.quantity, r.purchase_price]);

    await insertRows('customers', t('customers'),
      ['workspace_id', 'name', 'phone', 'email', 'address', 'credit_limit', 'balance'],
      (r) => [newWsId, r.name, r.phone ?? null, r.email ?? null, r.address ?? null, r.credit_limit ?? 0, r.balance ?? 0]);

    await insertRows('sales', t('sales'),
      ['workspace_id', 'branch_id', 'customer_id', 'invoice_number', 'total', 'discount', 'tax', 'paid',
       'payment_method', 'status', 'created_by', 'created_at'],
      (r) => [newWsId, remap('branches', r.branch_id as number), remap('customers', r.customer_id as number | null),
        r.invoice_number ?? null, r.total ?? 0, r.discount ?? 0, r.tax ?? 0, r.paid ?? 0,
        r.payment_method ?? 'Cash', r.status ?? 'completed', remap('users', r.created_by as number | null),
        r.created_at ?? new Date().toISOString()]);

    await insertRows('sale_items', t('sale_items'),
      ['sale_id', 'medicine_id', 'batch_id', 'quantity', 'price', 'cost'],
      (r) => [remap('sales', r.sale_id as number), remap('medicines', r.medicine_id as number),
        remap('batches', r.batch_id as number), r.quantity, r.price, r.cost ?? 0]);

    await insertRows('customer_payments', t('customer_payments'),
      ['workspace_id', 'customer_id', 'amount', 'method', 'note', 'created_at'],
      (r) => [newWsId, remap('customers', r.customer_id as number), r.amount, r.method ?? 'Cash',
        r.note ?? null, r.created_at ?? new Date().toISOString()]);

    await insertRows('expenses', t('expenses'),
      ['workspace_id', 'branch_id', 'title', 'category', 'amount', 'date', 'note', 'created_at'],
      (r) => [newWsId, remap('branches', r.branch_id as number | null), r.title, r.category ?? 'General',
        r.amount, r.date ?? new Date().toISOString().slice(0, 10), r.note ?? null,
        r.created_at ?? new Date().toISOString()]);

    await insertRows('cash_closings', t('cash_closings'),
      ['workspace_id', 'branch_id', 'date', 'opening_cash', 'cash_sales', 'cash_expenses',
       'expected_cash', 'counted_cash', 'difference', 'closed_by_user_id', 'created_at'],
      (r) => [newWsId, remap('branches', r.branch_id as number | null), r.date, r.opening_cash ?? 0,
        r.cash_sales ?? 0, r.cash_expenses ?? 0, r.expected_cash ?? 0, r.counted_cash ?? 0,
        r.difference ?? 0, remap('users', r.closed_by_user_id as number | null),
        r.created_at ?? new Date().toISOString()]);

    await insertRows('stock_movements', t('stock_movements'),
      ['workspace_id', 'branch_id', 'medicine_id', 'batch_id', 'type', 'quantity', 'reason', 'user_id', 'created_at'],
      (r) => [newWsId, remap('branches', r.branch_id as number | null), remap('medicines', r.medicine_id as number | null),
        remap('batches', r.batch_id as number | null), r.type, r.quantity ?? 0, r.reason ?? null,
        remap('users', r.user_id as number | null), r.created_at ?? new Date().toISOString()]);

    await insertRows('transfers', t('transfers'),
      ['workspace_id', 'from_branch_id', 'to_branch_id', 'batch_id', 'quantity', 'user_id', 'created_at'],
      (r) => [newWsId, remap('branches', r.from_branch_id as number), remap('branches', r.to_branch_id as number),
        remap('batches', r.batch_id as number), r.quantity, remap('users', r.user_id as number | null),
        r.created_at ?? new Date().toISOString()]);

    await insertRows('subscriptions', t('subscriptions'),
      ['workspace_id', 'plan_id', 'billing_cycle', 'status', 'started_at', 'ends_at'],
      (r) => [newWsId, r.plan_id, r.billing_cycle ?? 'monthly', r.status ?? 'active',
        r.started_at ?? new Date().toISOString(), r.ends_at ?? null]);

    await insertRows('platform_payments', t('platform_payments'),
      ['workspace_id', 'subscription_id', 'amount', 'method', 'note', 'created_at'],
      (r) => [newWsId, remap('subscriptions', r.subscription_id as number | null), r.amount ?? 0,
        r.method ?? 'Cash', r.note ?? null, r.created_at ?? new Date().toISOString()]);

    await insertRows('audit_logs', t('audit_logs'),
      ['workspace_id', 'user_id', 'action', 'detail', 'created_at'],
      (r) => [newWsId, remap('users', r.user_id as number | null), r.action, r.detail ?? null,
        r.created_at ?? new Date().toISOString()]);

    // Verification: record counts in the copy must match the backup.
    // purchase_items / sale_items have no workspace_id — verified via joins below.
    const counts: Record<string, number> = {};
    let verified = true;
    for (const table of EXPORT_TABLES) {
      if (table === 'purchase_items' || table === 'sale_items') continue;
      const expected = ((tables[table] as unknown[]) ?? []).length;
      const got = await txQuery<{ n: string }>(
        client,
        `SELECT COUNT(*)::text AS n FROM ${table} WHERE workspace_id = $1`,
        [newWsId],
      );
      counts[table] = Number(got.rows[0].n);
      if (counts[table] !== expected) verified = false;
    }
    // purchase_items / sale_items have no workspace_id: verify via their parents.
    const pi = await txQuery<{ n: string }>(
      client,
      'SELECT COUNT(*)::text AS n FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id WHERE p.workspace_id = $1',
      [newWsId],
    );
    const si = await txQuery<{ n: string }>(
      client,
      'SELECT COUNT(*)::text AS n FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.workspace_id = $1',
      [newWsId],
    );
    counts.purchase_items = Number(pi.rows[0].n);
    counts.sale_items = Number(si.rows[0].n);
    if (counts.purchase_items !== ((tables.purchase_items as unknown[]) ?? []).length) verified = false;
    if (counts.sale_items !== ((tables.sale_items as unknown[]) ?? []).length) verified = false;
    if (!verified) {
      throw new ApiError('Restore verification failed: record counts do not match the backup', 500);
    }

    await audit(newWsId, null, 'restore', `Workspace restored from backup exported at ${backup.exportedAt}`, client);
    return {
      status: 'restored-copy',
      workspaceId: newWsId,
      workspaceName: name,
      verified: true,
      counts,
      note: 'Live data was not touched. Log in to the restored workspace with the same credentials as the backup.',
    };
  });
}

export async function listaudit(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const limit = Math.min(Math.max(optInt(body, 'limit', 100), 1), 500);
  const res = await query<Record<string, unknown>>(
    `SELECT a.*, u.name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.workspace_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT $2`,
    [auth.workspaceId, limit],
  );
  return res.rows.map(mapAudit);
}

export async function swmoverview(ctx: HandlerCtx, _body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  requireSwmAdmin(auth);
  const tenants = await query<Record<string, unknown>>(
    `SELECT w.id, w.name, w.owner_name, w.status, w.created_at, p.name AS plan_name
       FROM workspaces w
       LEFT JOIN subscriptions s ON s.workspace_id = w.id
       LEFT JOIN plans p ON p.id = s.plan_id
      ORDER BY w.created_at DESC`,
    [],
  );
  const revenue = await query<{ v: string }>(
    'SELECT COALESCE(SUM(amount),0)::text AS v FROM platform_payments',
  );
  const active = await query<{ v: string }>(
    "SELECT COUNT(*)::text AS v FROM subscriptions WHERE status IN ('active','trial')",
  );
  return {
    tenants: tenants.rows.map((r) => ({
      id: r.id,
      name: r.name,
      ownerName: r.owner_name,
      planName: r.plan_name ?? undefined,
      status: r.status,
      createdAt: fmtTs(r.created_at) ?? undefined,
    })),
    totalRevenue: Number(revenue.rows[0].v),
    activeSubscriptions: Number(active.rows[0].v),
  };
}

export async function swmsetworkspacestatus(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  requireSwmAdmin(auth);
  const workspaceId = reqInt(body, 'workspaceId');
  const status = reqStr(body, 'status');
  if (!['active', 'suspended'].includes(status)) {
    throw new ApiError('status must be active or suspended', 400);
  }
  const res = await query('UPDATE workspaces SET status=$2 WHERE id=$1 RETURNING id', [workspaceId, status]);
  if (res.rows.length === 0) throw new ApiError('Workspace not found', 404);
  return { ok: true, workspaceId, status };
}

export async function registerpushtoken(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const token = reqStr(body, 'expoPushToken');
  if (!token.startsWith('ExponentPushToken[') && !token.startsWith('ExpoPushToken[')) {
    throw new ApiError('expoPushToken must be a valid Expo push token', 400);
  }
  await query(
    `INSERT INTO push_tokens (user_id, expo_push_token) VALUES ($1,$2)
     ON CONFLICT (user_id, expo_push_token) DO NOTHING`,
    [auth.user.id, token],
  );
  return { ok: true };
}
