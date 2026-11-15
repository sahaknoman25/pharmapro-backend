// Customers & qarz.
import { query, withTx, txQuery } from '../db';
import { ApiError } from '../errors';
import { requireAuth } from '../auth';
import { audit, mapCustomer } from '../lib/common';
import { fmtTs, optInt, optStr, optStrNull, reqInt, reqStr } from '../util';
import { HandlerCtx } from './types';

export async function listcustomers(ctx: HandlerCtx, _body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const res = await query<Record<string, unknown>>(
    'SELECT * FROM customers WHERE workspace_id = $1 ORDER BY name ASC',
    [auth.workspaceId],
  );
  return res.rows.map(mapCustomer);
}

export async function savecustomer(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const name = reqStr(body, 'name');
  const id = body.id === undefined || body.id === null ? null : (body.id as number);
  if (id !== null && !Number.isInteger(id)) throw new ApiError('id must be an integer', 400);
  const phone = optStrNull(body, 'phone');
  const email = optStrNull(body, 'email');
  const address = optStrNull(body, 'address');
  const creditLimit = optInt(body, 'creditLimit', 0);
  if (creditLimit < 0) throw new ApiError('creditLimit must be >= 0', 400);
  if (id === null) {
    const res = await query<Record<string, unknown>>(
      `INSERT INTO customers (workspace_id, name, phone, email, address, credit_limit)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [auth.workspaceId, name, phone, email, address, creditLimit],
    );
    return mapCustomer(res.rows[0]);
  }
  const res = await query<Record<string, unknown>>(
    `UPDATE customers SET name=$3, phone=$4, email=$5, address=$6, credit_limit=$7
      WHERE id=$1 AND workspace_id=$2 RETURNING *`,
    [id, auth.workspaceId, name, phone, email, address, creditLimit],
  );
  if (res.rows.length === 0) throw new ApiError('Customer not found', 404);
  return mapCustomer(res.rows[0]);
}

export async function customerpayment(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const customerId = reqInt(body, 'customerId');
  const amount = reqInt(body, 'amount');
  if (amount <= 0) throw new ApiError('amount must be > 0', 400);
  const method = optStr(body, 'method', 'Cash');
  const note = optStr(body, 'note', '');
  return withTx(async (client) => {
    const c = await txQuery<Record<string, unknown>>(
      client,
      'SELECT * FROM customers WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
      [customerId, auth.workspaceId],
    );
    if (c.rows.length === 0) throw new ApiError('Customer not found', 404);
    await txQuery(
      client,
      `INSERT INTO customer_payments (workspace_id, customer_id, amount, method, note)
       VALUES ($1,$2,$3,$4,$5)`,
      [auth.workspaceId, customerId, amount, method, note],
    );
    await txQuery(client, 'UPDATE customers SET balance = balance - $1 WHERE id = $2', [
      amount,
      customerId,
    ]);
    await audit(
      auth.workspaceId,
      auth.user.id,
      'customer_payment',
      `Customer ${c.rows[0].name} paid ${amount} (${method})${note ? `: ${note}` : ''}`,
      client,
    );
    return { ok: true, customerId, balance: Number(c.rows[0].balance) - amount };
  });
}

export async function customerstatement(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const customerId = reqInt(body, 'customerId');
  const c = await query<Record<string, unknown>>(
    'SELECT * FROM customers WHERE id = $1 AND workspace_id = $2',
    [customerId, auth.workspaceId],
  );
  if (c.rows.length === 0) throw new ApiError('Customer not found', 404);
  const sales = await query<Record<string, unknown>>(
    `SELECT s.*, u.name AS cashier_name
       FROM sales s LEFT JOIN users u ON u.id = s.created_by
      WHERE s.workspace_id = $1 AND s.customer_id = $2
      ORDER BY s.created_at DESC, s.id DESC`,
    [auth.workspaceId, customerId],
  );
  const payments = await query<Record<string, unknown>>(
    `SELECT id, amount, method, created_at FROM customer_payments
      WHERE workspace_id = $1 AND customer_id = $2 ORDER BY created_at DESC, id DESC`,
    [auth.workspaceId, customerId],
  );
  const salesOut = [];
  for (const r of sales.rows) {
    const items = await query<Record<string, unknown>>(
      `SELECT si.*, m.name AS medicine_name, b.batch_number
         FROM sale_items si
         JOIN medicines m ON m.id = si.medicine_id
         JOIN batches b ON b.id = si.batch_id
        WHERE si.sale_id = $1 ORDER BY si.id`,
      [r.id],
    );
    salesOut.push({
      id: r.id,
      invoiceNumber: r.invoice_number,
      branchId: r.branch_id,
      customerId: r.customer_id,
      total: r.total,
      discount: r.discount,
      tax: r.tax,
      paid: r.paid,
      paymentMethod: r.payment_method,
      status: r.status,
      createdAt: fmtTs(r.created_at) ?? undefined,
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
    customer: mapCustomer(c.rows[0]),
    sales: salesOut,
    payments: payments.rows.map((p) => ({
      id: p.id,
      amount: p.amount,
      method: p.method,
      createdAt: fmtTs(p.created_at) ?? undefined,
    })),
  };
}
