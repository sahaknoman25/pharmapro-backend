// Dashboard, reports, AI assistant (analytics computed server-side).
import { query } from '../db';
import { requireAuth } from '../auth';
import { mapBatch, mapMedicine } from '../lib/common';
import { fmtDate, optIntNull, optStr } from '../util';
import { HandlerCtx } from './types';

const ACTIVE_SALE = "status = 'completed'";

export async function getdashboard(ctx: HandlerCtx, _body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const ws = auth.workspaceId;
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const num = async (sql: string, params: unknown[]): Promise<number> => {
    const r = await query<{ v: string }>(sql, params);
    return Number(r.rows[0]?.v ?? 0);
  };
  const sumSales = (from: string, to: string) =>
    num(
      `SELECT COALESCE(SUM(total),0)::text AS v FROM sales
        WHERE workspace_id=$1 AND ${ACTIVE_SALE} AND created_at::date BETWEEN $2 AND $3`,
      [ws, from, to],
    );
  const countSales = (from: string, to: string) =>
    num(
      `SELECT COUNT(*)::text AS v FROM sales
        WHERE workspace_id=$1 AND ${ACTIVE_SALE} AND created_at::date BETWEEN $2 AND $3`,
      [ws, from, to],
    );
  const profit = (from: string, to: string) =>
    num(
      `SELECT COALESCE(SUM((si.price - si.cost) * si.quantity),0)::text AS v
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE s.workspace_id=$1 AND s.${ACTIVE_SALE} AND s.created_at::date BETWEEN $2 AND $3`,
      [ws, from, to],
    );
  const expenses = (from: string, to: string) =>
    num(
      `SELECT COALESCE(SUM(amount),0)::text AS v FROM expenses
        WHERE workspace_id=$1 AND date BETWEEN $2 AND $3`,
      [ws, from, to],
    );

  const [todaySales, todayRevenue, weekSales, weekRevenue, monthSales, monthRevenue] = await Promise.all([
    countSales(today, today),
    sumSales(today, today),
    countSales(weekAgo, today),
    sumSales(weekAgo, today),
    countSales(monthAgo, today),
    sumSales(monthAgo, today),
  ]);
  const [totalRevenue, grossProfit, totalExpenses] = await Promise.all([
    sumSales('2000-01-01', today),
    profit('2000-01-01', today),
    expenses('2000-01-01', today),
  ]);
  const totalStock = await num(
    `SELECT COALESCE(SUM(quantity),0)::text AS v FROM batches
      WHERE workspace_id=$1 AND status='active' AND expiry_date >= CURRENT_DATE`,
    [ws],
  );
  const totalMedicines = await num('SELECT COUNT(*)::text AS v FROM medicines WHERE workspace_id=$1', [ws]);
  const customerDebt = await num(
    'SELECT COALESCE(SUM(balance),0)::text AS v FROM customers WHERE workspace_id=$1',
    [ws],
  );
  const supplierDebt = await num(
    'SELECT COALESCE(SUM(balance),0)::text AS v FROM suppliers WHERE workspace_id=$1',
    [ws],
  );

  const lowStock = await query<Record<string, unknown>>(
    `SELECT m.*,
            COALESCE(SUM(CASE WHEN b.status='active' AND b.expiry_date >= CURRENT_DATE THEN b.quantity ELSE 0 END),0) AS stock,
            NULL::date AS next_expiry, 0::bigint AS batch_count
       FROM medicines m LEFT JOIN batches b ON b.medicine_id = m.id
      WHERE m.workspace_id = $1
      GROUP BY m.id
      HAVING COALESCE(SUM(CASE WHEN b.status='active' AND b.expiry_date >= CURRENT_DATE THEN b.quantity ELSE 0 END),0) < m.min_stock
      ORDER BY stock ASC LIMIT 20`,
    [ws],
  );
  const nearExpiry = await query<Record<string, unknown>>(
    `SELECT b.*, m.name AS medicine_name FROM batches b JOIN medicines m ON m.id = b.medicine_id
      WHERE b.workspace_id=$1 AND b.status='active' AND b.quantity > 0
        AND b.expiry_date >= CURRENT_DATE AND b.expiry_date <= CURRENT_DATE + INTERVAL '30 days'
      ORDER BY b.expiry_date ASC LIMIT 20`,
    [ws],
  );
  const expired = await query<Record<string, unknown>>(
    `SELECT b.*, m.name AS medicine_name FROM batches b JOIN medicines m ON m.id = b.medicine_id
      WHERE b.workspace_id=$1 AND b.quantity > 0
        AND (b.status='expired' OR b.expiry_date < CURRENT_DATE)
      ORDER BY b.expiry_date ASC LIMIT 20`,
    [ws],
  );
  const topSellers = await query<Record<string, unknown>>(
    `SELECT si.medicine_id, m.name AS medicine_name,
            SUM(si.quantity)::bigint AS quantity, SUM(si.price * si.quantity)::bigint AS revenue
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN medicines m ON m.id = si.medicine_id
      WHERE s.workspace_id=$1 AND s.${ACTIVE_SALE}
      GROUP BY si.medicine_id, m.name
      ORDER BY quantity DESC LIMIT 10`,
    [ws],
  );
  const recentSales = await query<Record<string, unknown>>(
    `SELECT s.*, c.name AS customer_name FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.workspace_id=$1 ORDER BY s.created_at DESC, s.id DESC LIMIT 10`,
    [ws],
  );
  const recentPurchases = await query<Record<string, unknown>>(
    `SELECT p.*, s.name AS supplier_name FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.workspace_id=$1 ORDER BY p.created_at DESC, p.id DESC LIMIT 10`,
    [ws],
  );
  const recentActivities = await query<Record<string, unknown>>(
    `SELECT id, detail AS text, created_at FROM audit_logs
      WHERE workspace_id=$1 ORDER BY created_at DESC, id DESC LIMIT 10`,
    [ws],
  );
  const chart = await query<Record<string, unknown>>(
    `SELECT d AS label,
            COALESCE(SUM(s.total),0)::bigint AS sales,
            COALESCE(SUM((si.price - si.cost) * si.quantity),0)::bigint AS profit
       FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') AS d
       LEFT JOIN sales s ON s.workspace_id=$1 AND s.${ACTIVE_SALE} AND s.created_at::date = d
       LEFT JOIN sale_items si ON si.sale_id = s.id
      GROUP BY d ORDER BY d ASC`,
    [ws],
  );

  const recentSalesOut = [];
  for (const r of recentSales.rows) {
    const items = await query<Record<string, unknown>>(
      `SELECT si.*, m.name AS medicine_name, b.batch_number
         FROM sale_items si JOIN medicines m ON m.id = si.medicine_id JOIN batches b ON b.id = si.batch_id
        WHERE si.sale_id = $1 ORDER BY si.id`,
      [r.id],
    );
    recentSalesOut.push({
      id: r.id,
      invoiceNumber: r.invoice_number,
      branchId: r.branch_id,
      customerId: r.customer_id,
      customerName: r.customer_name ?? undefined,
      total: r.total,
      discount: r.discount,
      tax: r.tax,
      paid: r.paid,
      paymentMethod: r.payment_method,
      status: r.status,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      items: items.rows.map((i) => ({
        medicineId: i.medicine_id,
        medicineName: i.medicine_name,
        quantity: i.quantity,
        price: i.price,
        cost: i.cost,
        batchNumber: i.batch_number,
      })),
    });
  }

  return {
    todaySales,
    todayRevenue,
    weekSales,
    weekRevenue,
    monthSales,
    monthRevenue,
    totalRevenue,
    grossProfit,
    netProfit: grossProfit - totalExpenses,
    totalExpenses,
    totalStock,
    totalMedicines,
    lowStock: lowStock.rows.map(mapMedicine),
    nearExpiry: nearExpiry.rows.map(mapBatch),
    expired: expired.rows.map(mapBatch),
    topSellers: topSellers.rows.map((r) => ({
      medicineId: r.medicine_id,
      medicineName: r.medicine_name,
      quantity: Number(r.quantity),
      revenue: Number(r.revenue),
    })),
    recentSales: recentSalesOut,
    recentPurchases: recentPurchases.rows.map((r) => ({
      id: r.id,
      invoiceNumber: r.invoice_number,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name ?? undefined,
      total: r.total,
      paid: r.paid,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    })),
    recentActivities: recentActivities.rows.map((r) => ({
      id: r.id,
      text: r.text,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    })),
    salesChart: chart.rows.map((r) => ({
      label: fmtDate(r.label),
      sales: Number(r.sales),
      profit: Number(r.profit),
    })),
    customerDebt,
    supplierDebt,
  };
}

export async function getreports(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const ws = auth.workspaceId;
  const from = optStr(body, 'from', '') || '2000-01-01';
  const to = optStr(body, 'to', '') || new Date().toISOString().slice(0, 10);
  const branchId = optIntNull(body, 'branchId');
  const branchSql = branchId === null ? '' : ' AND branch_id = $4';
  const params = (extra: unknown[] = []) => [ws, from, to, ...(branchId === null ? [] : [branchId]), ...extra];

  const num = async (sql: string, p: unknown[]): Promise<number> => {
    const r = await query<{ v: string }>(sql, p);
    return Number(r.rows[0]?.v ?? 0);
  };
  const totalSales = await num(
    `SELECT COALESCE(SUM(total),0)::text AS v FROM sales
      WHERE workspace_id=$1 AND ${ACTIVE_SALE} AND created_at::date BETWEEN $2 AND $3${branchId === null ? '' : ' AND branch_id=$4'}`,
    params(),
  );
  const totalProfit = await num(
    `SELECT COALESCE(SUM((si.price - si.cost) * si.quantity),0)::text AS v
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.workspace_id=$1 AND s.${ACTIVE_SALE} AND s.created_at::date BETWEEN $2 AND $3${branchId === null ? '' : ' AND s.branch_id=$4'}`,
    params(),
  );
  const totalPurchases = await num(
    `SELECT COALESCE(SUM(total),0)::text AS v FROM purchases
      WHERE workspace_id=$1 AND created_at::date BETWEEN $2 AND $3${branchId === null ? '' : ' AND branch_id=$4'}`,
    params(),
  );
  const totalExpenses = await num(
    `SELECT COALESCE(SUM(amount),0)::text AS v FROM expenses
      WHERE workspace_id=$1 AND date BETWEEN $2 AND $3${branchId === null ? '' : ' AND branch_id=$4'}`,
    params(),
  );

  const byPeriod = await query<Record<string, unknown>>(
    `SELECT s.created_at::date AS label,
            COALESCE(SUM(s.total),0)::bigint AS total,
            COALESCE(SUM((si.price - si.cost) * si.quantity),0)::bigint AS profit,
            COUNT(DISTINCT s.id)::bigint AS count
       FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id
      WHERE s.workspace_id=$1 AND s.${ACTIVE_SALE} AND s.created_at::date BETWEEN $2 AND $3${branchId === null ? '' : ' AND s.branch_id=$4'}
      GROUP BY s.created_at::date ORDER BY s.created_at::date ASC`,
    params(),
  );
  const bestSellers = await query<Record<string, unknown>>(
    `SELECT si.medicine_id, m.name AS medicine_name,
            SUM(si.quantity)::bigint AS quantity, SUM(si.price * si.quantity)::bigint AS revenue
       FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN medicines m ON m.id = si.medicine_id
      WHERE s.workspace_id=$1 AND s.${ACTIVE_SALE} AND s.created_at::date BETWEEN $2 AND $3${branchId === null ? '' : ' AND s.branch_id=$4'}
      GROUP BY si.medicine_id, m.name ORDER BY quantity DESC LIMIT 10`,
    params(),
  );
  const slowMovers = await query<Record<string, unknown>>(
    `SELECT m.id AS medicine_id, m.name AS medicine_name,
            COALESCE(SUM(CASE WHEN b.status='active' AND b.expiry_date >= CURRENT_DATE THEN b.quantity ELSE 0 END),0)::bigint AS stock
       FROM medicines m LEFT JOIN batches b ON b.medicine_id = m.id
      WHERE m.workspace_id=$1
        AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id
                         WHERE si.medicine_id = m.id AND s.workspace_id=$1 AND s.${ACTIVE_SALE}
                           AND s.created_at::date BETWEEN $2 AND $3)
      GROUP BY m.id, m.name
      HAVING COALESCE(SUM(CASE WHEN b.status='active' AND b.expiry_date >= CURRENT_DATE THEN b.quantity ELSE 0 END),0) > 0
      ORDER BY stock DESC LIMIT 10`,
    [ws, from, to],
  );
  const customerDebts = await query<Record<string, unknown>>(
    'SELECT id AS customer_id, name, balance FROM customers WHERE workspace_id=$1 AND balance > 0 ORDER BY balance DESC',
    [ws],
  );
  const supplierDebts = await query<Record<string, unknown>>(
    'SELECT id AS supplier_id, name, balance FROM suppliers WHERE workspace_id=$1 AND balance > 0 ORDER BY balance DESC',
    [ws],
  );
  const employeePerformance = await query<Record<string, unknown>>(
    `SELECT u.id AS user_id, u.name, COUNT(s.id)::bigint AS sales,
            COALESCE(SUM(s.total),0)::bigint AS revenue
       FROM users u LEFT JOIN sales s ON s.created_by = u.id AND s.${ACTIVE_SALE}
         AND s.created_at::date BETWEEN $2 AND $3
      WHERE u.workspace_id=$1 GROUP BY u.id, u.name ORDER BY revenue DESC`,
    [ws, from, to],
  );
  const expiring = await query<Record<string, unknown>>(
    `SELECT b.*, m.name AS medicine_name FROM batches b JOIN medicines m ON m.id = b.medicine_id
      WHERE b.workspace_id=$1 AND b.status='active' AND b.quantity > 0
        AND b.expiry_date >= CURRENT_DATE AND b.expiry_date <= CURRENT_DATE + INTERVAL '30 days'
        ${branchId === null ? '' : ' AND b.branch_id = $2'}
      ORDER BY b.expiry_date ASC LIMIT 50`,
    branchId === null ? [ws] : [ws, branchId],
  );
  const expired = await query<Record<string, unknown>>(
    `SELECT b.*, m.name AS medicine_name FROM batches b JOIN medicines m ON m.id = b.medicine_id
      WHERE b.workspace_id=$1 AND b.quantity > 0
        AND (b.status='expired' OR b.expiry_date < CURRENT_DATE)
        ${branchId === null ? '' : ' AND b.branch_id = $2'}
      ORDER BY b.expiry_date ASC LIMIT 50`,
    branchId === null ? [ws] : [ws, branchId],
  );
  const lowStock = await query<Record<string, unknown>>(
    `SELECT m.*,
            COALESCE(SUM(CASE WHEN b.status='active' AND b.expiry_date >= CURRENT_DATE THEN b.quantity ELSE 0 END),0) AS stock,
            NULL::date AS next_expiry, 0::bigint AS batch_count
       FROM medicines m LEFT JOIN batches b ON b.medicine_id = m.id
      WHERE m.workspace_id = $1
      GROUP BY m.id
      HAVING COALESCE(SUM(CASE WHEN b.status='active' AND b.expiry_date >= CURRENT_DATE THEN b.quantity ELSE 0 END),0) < m.min_stock
      ORDER BY stock ASC LIMIT 20`,
    [ws],
  );

  return {
    salesByPeriod: byPeriod.rows.map((r) => ({
      label: fmtDate(r.label),
      total: Number(r.total),
      profit: Number(r.profit),
      count: Number(r.count),
    })),
    totalSales,
    totalProfit,
    totalPurchases,
    totalExpenses,
    bestSellers: bestSellers.rows.map((r) => ({
      medicineId: r.medicine_id,
      medicineName: r.medicine_name,
      quantity: Number(r.quantity),
      revenue: Number(r.revenue),
    })),
    slowMovers: slowMovers.rows.map((r) => ({
      medicineId: r.medicine_id,
      medicineName: r.medicine_name,
      stock: Number(r.stock),
      monthsCover: 0,
    })),
    customerDebts: customerDebts.rows.map((r) => ({
      customerId: r.customer_id,
      name: r.name,
      balance: r.balance,
    })),
    supplierDebts: supplierDebts.rows.map((r) => ({
      supplierId: r.supplier_id,
      name: r.name,
      balance: r.balance,
    })),
    employeePerformance: employeePerformance.rows.map((r) => ({
      userId: r.user_id,
      name: r.name,
      sales: Number(r.sales),
      revenue: Number(r.revenue),
    })),
    expiring: expiring.rows.map(mapBatch),
    expired: expired.rows.map(mapBatch),
    lowStock: lowStock.rows.map(mapMedicine),
  };
}

export async function aiassistant(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const ws = auth.workspaceId;
  const question = optStr(body, 'question', '');
  const today = new Date().toISOString().slice(0, 10);
  const ago90 = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const best = await query<Record<string, unknown>>(
    `SELECT m.name AS medicine_name, SUM(si.quantity)::bigint AS quantity
       FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN medicines m ON m.id = si.medicine_id
      WHERE s.workspace_id=$1 AND s.${ACTIVE_SALE} AND s.created_at::date BETWEEN $2 AND $3
      GROUP BY m.name ORDER BY quantity DESC LIMIT 5`,
    [ws, ago90, today],
  );
  const slow = await query<Record<string, unknown>>(
    `SELECT m.name AS medicine_name,
            COALESCE(SUM(CASE WHEN b.status='active' AND b.expiry_date >= CURRENT_DATE THEN b.quantity ELSE 0 END),0)::bigint AS stock
       FROM medicines m LEFT JOIN batches b ON b.medicine_id = m.id
      WHERE m.workspace_id=$1
        AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id
                         WHERE si.medicine_id = m.id AND s.workspace_id=$1 AND s.${ACTIVE_SALE}
                           AND s.created_at::date BETWEEN $2 AND $3)
      GROUP BY m.id, m.name
      HAVING COALESCE(SUM(CASE WHEN b.status='active' AND b.expiry_date >= CURRENT_DATE THEN b.quantity ELSE 0 END),0) > 0
      ORDER BY stock DESC LIMIT 5`,
    [ws, ago90, today],
  );
  // 90-day forecast: average daily sales over the last 90 days per medicine.
  const forecastRows = await query<Record<string, unknown>>(
    `SELECT m.name AS medicine_name,
            COALESCE(SUM(CASE WHEN b.status='active' AND b.expiry_date >= CURRENT_DATE THEN b.quantity ELSE 0 END),0)::bigint AS stock,
            COALESCE(SUM(si.quantity),0)::bigint AS sold90
       FROM medicines m
       LEFT JOIN batches b ON b.medicine_id = m.id
       LEFT JOIN sale_items si ON si.medicine_id = m.id
       LEFT JOIN sales s ON s.id = si.sale_id AND s.workspace_id=$1 AND s.${ACTIVE_SALE}
         AND s.created_at::date BETWEEN $2 AND $3
      WHERE m.workspace_id=$1
      GROUP BY m.id, m.name
      HAVING COALESCE(SUM(si.quantity),0) > 0
      ORDER BY m.name`,
    [ws, ago90, today],
  );
  const forecast = forecastRows.rows
    .map((r) => {
      const daily = Number(r.sold90) / 90;
      const stock = Number(r.stock);
      const daysLeft = daily > 0 ? Math.floor(stock / daily) : 999;
      const suggestedQty = Math.max(0, Math.ceil(daily * 30) - stock);
      return { medicineName: r.medicine_name as string, daysLeft, suggestedQty };
    })
    .filter((f) => f.daysLeft < 90)
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .slice(0, 10);

  const expiredValue = await query<{ v: string }>(
    `SELECT COALESCE(SUM(quantity * purchase_price),0)::text AS v FROM batches
      WHERE workspace_id=$1 AND quantity > 0 AND (status='expired' OR expiry_date < CURRENT_DATE)`,
    [ws],
  );
  const lowCount = await query<{ v: string }>(
    `SELECT COUNT(*)::text AS v FROM (
        SELECT m.id, COALESCE(SUM(CASE WHEN b.status='active' AND b.expiry_date >= CURRENT_DATE THEN b.quantity ELSE 0 END),0) AS stock
          FROM medicines m LEFT JOIN batches b ON b.medicine_id = m.id
         WHERE m.workspace_id=$1 GROUP BY m.id, m.min_stock
        HAVING COALESCE(SUM(CASE WHEN b.status='active' AND b.expiry_date >= CURRENT_DATE THEN b.quantity ELSE 0 END),0) < m.min_stock
     ) t`,
    [ws],
  );
  const qarz = await query<{ v: string }>(
    'SELECT COALESCE(SUM(balance),0)::text AS v FROM customers WHERE workspace_id=$1',
    [ws],
  );

  const problems: string[] = [];
  if (Number(expiredValue.rows[0].v) > 0) {
    problems.push(`Expired stock worth ${expiredValue.rows[0].v} is sitting in the store — quarantine or return it.`);
  }
  if (Number(lowCount.rows[0].v) > 0) {
    problems.push(`${lowCount.rows[0].v} medicine(s) are below their minimum stock level.`);
  }
  if (Number(qarz.rows[0].v) > 0) {
    problems.push(`Customers owe ${qarz.rows[0].v} in qarz — follow up on the oldest balances.`);
  }
  const suggestions: string[] = [];
  if (forecast.some((f) => f.daysLeft < 14)) {
    suggestions.push('Some fast sellers will run out within 2 weeks — order them now.');
  }
  if (slow.rows.length > 0) {
    suggestions.push('Slow movers tie up cash — consider a promotion or a smaller next order.');
  }
  if (suggestions.length === 0) suggestions.push('Stock levels look healthy. Keep the FEFO order when receiving new batches.');

  const bestNames = best.rows.map((r) => r.medicine_name as string).join(', ') || 'none yet';
  const summary =
    `Best sellers (90 days): ${bestNames}. ` +
    `${slow.rows.length} slow-moving medicine(s). ` +
    `${forecast.length} medicine(s) forecast to need ordering within 90 days. ` +
    (problems.length ? `Attention: ${problems.join(' ')}` : 'No urgent problems found.');

  let answer = summary;
  if (question) {
    const q = question.toLowerCase();
    if (q.includes('expir') || q.includes('انقضا')) {
      answer = problems.find((p) => p.includes('Expired')) ?? 'No expired stock found.';
    } else if (q.includes('qarz') || q.includes('قرض') || q.includes('debt') || q.includes('owe')) {
      answer = `Customers owe ${qarz.rows[0].v} in total (qarz).`;
    } else if (q.includes('profit') || q.includes('سود')) {
      const p = await query<{ v: string }>(
        `SELECT COALESCE(SUM((si.price - si.cost) * si.quantity),0)::text AS v
           FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE s.workspace_id=$1 AND s.${ACTIVE_SALE}`,
        [ws],
      );
      answer = `Total gross profit from all completed sales is ${p.rows[0].v} (from real batch costs).`;
    }
  }

  return {
    summary,
    answer,
    bestSellers: best.rows.map((r) => ({ medicineName: r.medicine_name, quantity: Number(r.quantity) })),
    slowMovers: slow.rows.map((r) => ({ medicineName: r.medicine_name, stock: Number(r.stock) })),
    forecast,
    suggestions,
    problems,
  };
}
