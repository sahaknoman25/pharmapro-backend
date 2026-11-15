// POS & sales: possearch, createsale, listsales, voidsale, returnsale.
import { query, withTx, txQuery, Tx } from '../db';
import { ApiError } from '../errors';
import { requireAuth } from '../auth';
import { allocateFefo, restoreToBatches } from '../lib/fefo';
import { audit } from '../lib/common';
import { fmtDate, fmtTs, optInt, optIntNull, optStr, reqInt, todayStr } from '../util';
import { HandlerCtx } from './types';

function mapSaleItem(r: Record<string, unknown>): Record<string, unknown> {
  return {
    medicineId: r.medicine_id,
    medicineName: r.medicine_name ?? undefined,
    quantity: r.quantity,
    price: r.price,
    cost: r.cost,
    batchNumber: r.batch_number ?? undefined,
  };
}

async function loadSaleWithItems(client: Tx, saleId: number, workspaceId: number) {
  const sale = await txQuery<Record<string, unknown>>(
    client,
    'SELECT * FROM sales WHERE id = $1 AND workspace_id = $2',
    [saleId, workspaceId],
  );
  if (sale.rows.length === 0) throw new ApiError('Sale not found', 404);
  const items = await txQuery<Record<string, unknown>>(
    client,
    `SELECT si.*, m.name AS medicine_name, b.batch_number
       FROM sale_items si
       JOIN medicines m ON m.id = si.medicine_id
       JOIN batches b ON b.id = si.batch_id
      WHERE si.sale_id = $1 ORDER BY si.id`,
    [saleId],
  );
  return { sale: sale.rows[0], items: items.rows };
}

export async function possearch(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const branchId = reqInt(body, 'branchId');
  const q = optStr(body, 'query', '').trim();
  const like = `%${q}%`;
  const res = await query<Record<string, unknown>>(
    `SELECT m.id, m.name, m.selling_price, m.unit,
            COALESCE(SUM(CASE WHEN b.status = 'active' AND b.expiry_date >= CURRENT_DATE THEN b.quantity ELSE 0 END), 0) AS sellable,
            (SELECT b2.batch_number FROM batches b2
              WHERE b2.medicine_id = m.id AND b2.branch_id = $2 AND b2.workspace_id = $1
                AND b2.status = 'active' AND b2.quantity > 0 AND b2.expiry_date >= CURRENT_DATE
              ORDER BY b2.expiry_date ASC, b2.id ASC LIMIT 1) AS fefo_batch
       FROM medicines m
       LEFT JOIN batches b ON b.medicine_id = m.id AND b.branch_id = $2 AND b.workspace_id = $1
      WHERE m.workspace_id = $1
        AND ($3 = '' OR m.name ILIKE $4 OR COALESCE(m.barcode,'') ILIKE $4 OR COALESCE(m.product_code,'') ILIKE $4)
      GROUP BY m.id
      HAVING COALESCE(SUM(CASE WHEN b.status = 'active' AND b.expiry_date >= CURRENT_DATE THEN b.quantity ELSE 0 END), 0) > 0
      ORDER BY m.name ASC
      LIMIT 50`,
    [auth.workspaceId, branchId, q, like],
  );
  return res.rows.map((r) => ({
    medicine: {
      id: r.id,
      name: r.name,
      sellingPrice: r.selling_price,
      unit: r.unit,
      stock: Number(r.sellable),
    },
    sellableStock: Number(r.sellable),
    fefoBatch: r.fefo_batch ?? undefined,
  }));
}

export async function createsale(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const branchId = reqInt(body, 'branchId');
  const items = body.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError('items must be a non-empty array', 400);
  }
  const discount = optInt(body, 'discount', 0);
  if (discount < 0) throw new ApiError('discount must be >= 0', 400);
  const paidInput = optInt(body, 'paid', 0);
  if (paidInput < 0) throw new ApiError('paid must be >= 0', 400);
  const paymentMethod = optStr(body, 'paymentMethod', 'Cash');
  const customerId = optIntNull(body, 'customerId');

  // Validate payment method against seeded methods.
  const methods = await query<{ name: string }>(
    'SELECT name FROM payment_methods WHERE workspace_id IS NULL OR workspace_id = $1',
    [auth.workspaceId],
  );
  if (!methods.rows.some((m) => m.name === paymentMethod)) {
    throw new ApiError(`Unknown payment method: ${paymentMethod}`, 400);
  }
  const branch = await query('SELECT id FROM branches WHERE id = $1 AND workspace_id = $2', [
    branchId,
    auth.workspaceId,
  ]);
  if (branch.rows.length === 0) throw new ApiError('Branch not found', 404);
  let customer: Record<string, unknown> | null = null;
  if (customerId !== null) {
    const c = await query('SELECT * FROM customers WHERE id = $1 AND workspace_id = $2', [
      customerId,
      auth.workspaceId,
    ]);
    if (c.rows.length === 0) throw new ApiError('Customer not found', 404);
    customer = c.rows[0];
  }

  const settings = await query<{ tax_rate: string }>(
    'SELECT tax_rate FROM app_settings WHERE workspace_id = $1',
    [auth.workspaceId],
  );
  const taxRate = settings.rows.length ? Number(settings.rows[0].tax_rate) : 0;

  return withTx(async (client) => {
    let subtotal = 0;
    let costTotal = 0;
    const allocations: Array<{ medicineId: number; batchNumber: string; quantity: number }> = [];
    const saleLines: Array<{
      medicineId: number;
      batchId: number;
      quantity: number;
      price: number;
      cost: number;
    }> = [];

    for (const raw of items) {
      const medicineId = raw.medicineId as number;
      const quantity = raw.quantity as number;
      if (!Number.isInteger(medicineId) || !Number.isInteger(quantity) || quantity <= 0) {
        throw new ApiError('Each item needs medicineId and quantity > 0', 400);
      }
      const med = await txQuery<{ selling_price: number; name: string }>(
        client,
        'SELECT selling_price, name FROM medicines WHERE id = $1 AND workspace_id = $2',
        [medicineId, auth.workspaceId],
      );
      if (med.rows.length === 0) throw new ApiError(`Medicine not found: ${medicineId}`, 404);
      const price = med.rows[0].selling_price;
      let alloc;
      try {
        alloc = await allocateFefo(client, auth.workspaceId, branchId, medicineId, quantity);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('INSUFFICIENT:')) {
          const sellable = e.message.split(':')[1];
          throw new ApiError(
            `Not enough stock for ${med.rows[0].name}: only ${sellable} sellable`,
            400,
          );
        }
        throw e;
      }
      for (const a of alloc.allocations) {
        allocations.push({ medicineId, batchNumber: a.batchNumber, quantity: a.quantity });
        saleLines.push({ medicineId, batchId: a.batchId, quantity: a.quantity, price, cost: a.cost });
        subtotal += price * a.quantity;
        costTotal += a.cost * a.quantity;
      }
    }

    const tax = Math.round(((subtotal - discount) * taxRate) / 100);
    const total = subtotal - discount + tax;
    if (total < 0) throw new ApiError('Total cannot be negative', 400);

    // paid / change / qarz
    let paid = paidInput;
    let change = 0;
    if (paymentMethod === 'Qarz') {
      if (!customer) throw new ApiError('Qarz sale needs a customer', 400);
      change = 0;
      if (paid > total) paid = total;
    } else {
      if (paid === 0) paid = total; // cash sale with no tendered amount = exact payment
      change = Math.max(0, paid - total);
      if (paid > total) paid = total;
    }
    const unpaid = total - paid;

    const sale = await txQuery<{ id: number }>(
      client,
      `INSERT INTO sales (workspace_id, branch_id, customer_id, total, discount, tax, paid,
                          payment_method, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed',$9) RETURNING id`,
      [auth.workspaceId, branchId, customerId, total, discount, tax, paid, paymentMethod, auth.user.id],
    );
    const saleId = sale.rows[0].id;
    const invoiceNumber = `INV-${String(saleId).padStart(6, '0')}`;
    await txQuery(client, 'UPDATE sales SET invoice_number = $1 WHERE id = $2', [invoiceNumber, saleId]);

    for (const line of saleLines) {
      await txQuery(
        client,
        'INSERT INTO sale_items (sale_id, medicine_id, batch_id, quantity, price, cost) VALUES ($1,$2,$3,$4,$5,$6)',
        [saleId, line.medicineId, line.batchId, line.quantity, line.price, line.cost],
      );
      await txQuery(
        client,
        `INSERT INTO stock_movements (workspace_id, branch_id, medicine_id, batch_id, type, quantity, reason, user_id)
         VALUES ($1,$2,$3,$4,'sale',$5,$6,$7)`,
        [auth.workspaceId, branchId, line.medicineId, line.batchId, -line.quantity, invoiceNumber, auth.user.id],
      );
    }
    if (customer && unpaid > 0) {
      await txQuery(client, 'UPDATE customers SET balance = balance + $1 WHERE id = $2', [
        unpaid,
        customerId,
      ]);
    }
    await audit(
      auth.workspaceId,
      auth.user.id,
      'sale',
      `Sale ${invoiceNumber}: total ${total}, ${paymentMethod}, profit ${subtotal - costTotal - discount}`,
      client,
    );
    return { saleId, invoiceNumber, total, change, allocations };
  });
}

export async function listsales(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const limit = Math.min(Math.max(optInt(body, 'limit', 100), 1), 500);
  const res = await query<Record<string, unknown>>(
    `SELECT s.*, c.name AS customer_name
       FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.workspace_id = $1
      ORDER BY s.created_at DESC, s.id DESC LIMIT $2`,
    [auth.workspaceId, limit],
  );
  const sales = [];
  for (const r of res.rows) {
    const items = await query<Record<string, unknown>>(
      `SELECT si.*, m.name AS medicine_name, b.batch_number
         FROM sale_items si
         JOIN medicines m ON m.id = si.medicine_id
         JOIN batches b ON b.id = si.batch_id
        WHERE si.sale_id = $1 ORDER BY si.id`,
      [r.id],
    );
    sales.push({
      id: r.id,
      invoiceNumber: r.invoice_number,
      branchId: r.branch_id,
      customerId: r.customer_id,
      customerName: r.customer_name ?? undefined,
      total: r.total,
      discount: r.discount,
      tax: r.tax,
      paid: r.paid,
      change: Math.max(0, Number(r.paid) - Number(r.total)),
      paymentMethod: r.payment_method,
      status: r.status,
      createdAt: fmtTs(r.created_at) ?? undefined,
      items: items.rows.map(mapSaleItem),
    });
  }
  return sales;
}

export async function voidsale(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  if (auth.user.role !== 'Admin') {
    throw new ApiError('Only an Admin can void a sale.', 403);
  }
  const saleId = reqInt(body, 'saleId');
  const reason = optStr(body, 'reason', '');
  return withTx(async (client) => {
    const { sale, items } = await loadSaleWithItems(client, saleId, auth.workspaceId);
    if (sale.status === 'voided') throw new ApiError('Sale is already voided', 400);
    if (sale.status === 'returned') throw new ApiError('Sale was already returned', 400);
    await restoreToBatches(
      client,
      items.map((i) => ({ batchId: Number(i.batch_id), quantity: Number(i.quantity) })),
    );
    for (const item of items) {
      await txQuery(
        client,
        `INSERT INTO stock_movements (workspace_id, branch_id, medicine_id, batch_id, type, quantity, reason, user_id)
         VALUES ($1,$2,$3,$4,'void',$5,$6,$7)`,
        [
          auth.workspaceId,
          sale.branch_id,
          item.medicine_id,
          item.batch_id,
          Number(item.quantity),
          reason || `Void ${sale.invoice_number}`,
          auth.user.id,
        ],
      );
    }
    const unpaid = Number(sale.total) - Number(sale.paid);
    if (sale.customer_id && unpaid > 0) {
      await txQuery(client, 'UPDATE customers SET balance = balance - $1 WHERE id = $2', [
        unpaid,
        sale.customer_id,
      ]);
    }
    await txQuery(client, "UPDATE sales SET status = 'voided' WHERE id = $1", [saleId]);
    await audit(
      auth.workspaceId,
      auth.user.id,
      'void_sale',
      `Voided sale ${sale.invoice_number} (total ${sale.total})${reason ? `: ${reason}` : ''}`,
      client,
    );
    return { ok: true, saleId, invoiceNumber: sale.invoice_number };
  });
}

export async function returnsale(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  if (auth.user.role !== 'Admin') {
    throw new ApiError('Only an Admin can return a sale.', 403);
  }
  const saleId = reqInt(body, 'saleId');
  const reason = optStr(body, 'reason', 'Customer return');
  const restock = body.restock === undefined ? true : body.restock === true;
  return withTx(async (client) => {
    const { sale, items } = await loadSaleWithItems(client, saleId, auth.workspaceId);
    if (sale.status === 'voided') throw new ApiError('Sale is already voided', 400);
    if (sale.status === 'returned') throw new ApiError('Sale was already returned', 400);
    const today = todayStr();
    for (const item of items) {
      const batch = await txQuery<{ expiry_date: Date; status: string }>(
        client,
        'SELECT expiry_date, status FROM batches WHERE id = $1',
        [item.batch_id],
      );
      const b = batch.rows[0];
      const expired = fmtDate(b.expiry_date)! < today;
      const damaged = b.status === 'damaged' || b.status === 'returned';
      if (restock && !expired && !damaged) {
        await txQuery(client, 'UPDATE batches SET quantity = quantity + $1 WHERE id = $2', [
          Number(item.quantity),
          item.batch_id,
        ]);
      }
      await txQuery(
        client,
        `INSERT INTO stock_movements (workspace_id, branch_id, medicine_id, batch_id, type, quantity, reason, user_id)
         VALUES ($1,$2,$3,$4,'return',$5,$6,$7)`,
        [
          auth.workspaceId,
          sale.branch_id,
          item.medicine_id,
          item.batch_id,
          Number(item.quantity),
          `${reason} (${sale.invoice_number})${expired || damaged ? ' — not restocked (expired/damaged)' : ''}`,
          auth.user.id,
        ],
      );
    }
    const unpaid = Number(sale.total) - Number(sale.paid);
    if (sale.customer_id && unpaid > 0) {
      await txQuery(client, 'UPDATE customers SET balance = balance - $1 WHERE id = $2', [
        unpaid,
        sale.customer_id,
      ]);
    }
    await txQuery(client, "UPDATE sales SET status = 'returned' WHERE id = $1", [saleId]);
    await audit(
      auth.workspaceId,
      auth.user.id,
      'return_sale',
      `Returned sale ${sale.invoice_number}: ${reason}`,
      client,
    );
    return { ok: true, saleId, invoiceNumber: sale.invoice_number };
  });
}
