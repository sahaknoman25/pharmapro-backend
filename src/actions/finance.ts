// Finance: expenses + daily cash closing.
import { query, withTx, txQuery } from '../db';
import { ApiError } from '../errors';
import { requireAuth, requireRoles } from '../auth';
import { audit, mapExpense } from '../lib/common';
import { fmtDate, optInt, optIntNull, optStr, reqInt, reqStr, todayStr } from '../util';
import { HandlerCtx } from './types';

export async function listexpenses(ctx: HandlerCtx, _body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const res = await query<Record<string, unknown>>(
    'SELECT * FROM expenses WHERE workspace_id = $1 ORDER BY date DESC, id DESC',
    [auth.workspaceId],
  );
  return res.rows.map(mapExpense);
}

export async function saveexpense(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  requireRoles(auth, ['Admin', 'Pharmacist']);
  const title = reqStr(body, 'title');
  const amount = reqInt(body, 'amount');
  if (amount <= 0) throw new ApiError('amount must be > 0', 400);
  const category = optStr(body, 'category', 'General');
  const date =
    typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : todayStr();
  const note = optStr(body, 'note', '');
  const branchId = optIntNull(body, 'branchId');
  const res = await query<Record<string, unknown>>(
    `INSERT INTO expenses (workspace_id, branch_id, title, category, amount, date, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [auth.workspaceId, branchId, title, category, amount, date, note],
  );
  await audit(auth.workspaceId, auth.user.id, 'expense', `Expense ${title}: ${amount} (${category})`);
  return mapExpense(res.rows[0]);
}

/**
 * Daily cash closing (new endpoint — see API_CONTRACT.md).
 * Cash sales for the day are computed server-side from completed sales paid
 * in Cash; expenses that day count as cash expenses. expected = opening +
 * cash sales − cash expenses; difference = counted − expected.
 */
export async function closecash(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const date =
    typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : todayStr();
  const openingCash = optInt(body, 'openingCash', 0);
  const countedCash = reqInt(body, 'countedCash');
  const branchId = optIntNull(body, 'branchId');
  if (openingCash < 0 || countedCash < 0) throw new ApiError('Cash amounts must be >= 0', 400);
  if (branchId !== null) {
    const b = await query('SELECT id FROM branches WHERE id = $1 AND workspace_id = $2', [
      branchId,
      auth.workspaceId,
    ]);
    if (b.rows.length === 0) throw new ApiError('Branch not found', 404);
  }
  return withTx(async (client) => {
    const branchFilter = branchId === null ? '' : ' AND branch_id = $3';
    const sales = await txQuery<{ total: string }>(
      client,
      `SELECT COALESCE(SUM(paid), 0)::text AS total FROM sales
        WHERE workspace_id = $1 AND payment_method = 'Cash' AND status = 'completed'
          AND created_at::date = $2${branchFilter}`,
      branchId === null ? [auth.workspaceId, date] : [auth.workspaceId, date, branchId],
    );
    const expenses = await txQuery<{ total: string }>(
      client,
      `SELECT COALESCE(SUM(amount), 0)::text AS total FROM expenses
        WHERE workspace_id = $1 AND date = $2${branchId === null ? '' : ' AND branch_id = $3'}`,
      branchId === null ? [auth.workspaceId, date] : [auth.workspaceId, date, branchId],
    );
    const cashSales = Number(sales.rows[0].total);
    const cashExpenses = Number(expenses.rows[0].total);
    const expected = openingCash + cashSales - cashExpenses;
    const difference = countedCash - expected;
    const res = await txQuery<Record<string, unknown>>(
      client,
      `INSERT INTO cash_closings (workspace_id, branch_id, date, opening_cash, cash_sales,
                                  cash_expenses, expected_cash, counted_cash, difference, closed_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        auth.workspaceId, branchId, date, openingCash, cashSales, cashExpenses,
        expected, countedCash, difference, auth.user.id,
      ],
    );
    await audit(
      auth.workspaceId,
      auth.user.id,
      'cash_close',
      `Cash closing ${date}: expected ${expected}, counted ${countedCash}, difference ${difference}`,
      client,
    );
    const r = res.rows[0];
    return {
      id: r.id,
      branchId: r.branch_id ?? null,
      date: fmtDate(r.date),
      openingCash: r.opening_cash,
      cashSales: r.cash_sales,
      cashExpenses: r.cash_expenses,
      expectedCash: r.expected_cash,
      countedCash: r.counted_cash,
      difference: r.difference,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    };
  });
}

export async function listclosings(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const limit = Math.min(Math.max(optInt(body, 'limit', 100), 1), 500);
  const res = await query<Record<string, unknown>>(
    `SELECT * FROM cash_closings WHERE workspace_id = $1 ORDER BY date DESC, id DESC LIMIT $2`,
    [auth.workspaceId, limit],
  );
  return res.rows.map((r) => ({
    id: r.id,
    branchId: r.branch_id ?? null,
    date: fmtDate(r.date),
    openingCash: r.opening_cash,
    cashSales: r.cash_sales,
    cashExpenses: r.cash_expenses,
    expectedCash: r.expected_cash,
    countedCash: r.counted_cash,
    difference: r.difference,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  }));
}
