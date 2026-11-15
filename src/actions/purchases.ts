// Purchases & suppliers.
import { query, withTx, txQuery } from '../db';
import { ApiError } from '../errors';
import { requireAuth, requireRoles } from '../auth';
import { audit, mapSupplier } from '../lib/common';
import { fmtDate, optInt, optIntNull, optStr, optStrNull, reqInt, reqStr } from '../util';
import { HandlerCtx } from './types';

export async function listpurchases(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const limit = Math.min(Math.max(optInt(body, 'limit', 100), 1), 500);
  const res = await query<Record<string, unknown>>(
    `SELECT p.*, s.name AS supplier_name
       FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.workspace_id = $1
      ORDER BY p.created_at DESC, p.id DESC LIMIT $2`,
    [auth.workspaceId, limit],
  );
  const out = [];
  for (const r of res.rows) {
    const items = await query<Record<string, unknown>>(
      `SELECT pi.*, m.name AS medicine_name
         FROM purchase_items pi JOIN medicines m ON m.id = pi.medicine_id
        WHERE pi.purchase_id = $1 ORDER BY pi.id`,
      [r.id],
    );
    out.push({
      id: r.id,
      invoiceNumber: r.invoice_number,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name ?? undefined,
      total: r.total,
      paid: r.paid,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      items: items.rows.map((i) => ({
        medicineId: i.medicine_id,
        medicineName: i.medicine_name,
        batchNumber: i.batch_number,
        expiryDate: fmtDate(i.expiry_date),
        mfgDate: fmtDate(i.mfg_date) ?? undefined,
        quantity: i.quantity,
        purchasePrice: i.purchase_price,
      })),
    });
  }
  return out;
}

export async function createpurchase(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  requireRoles(auth, ['Admin', 'Pharmacist', 'Inventory Manager']);
  const branchId = reqInt(body, 'branchId');
  const items = body.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError('items must be a non-empty array', 400);
  }
  const supplierId = optIntNull(body, 'supplierId');
  const invoiceNumber = optStr(body, 'invoiceNumber', '');
  const paid = optInt(body, 'paid', 0);
  if (paid < 0) throw new ApiError('paid must be >= 0', 400);

  return withTx(async (client) => {
    const branch = await txQuery(client, 'SELECT id FROM branches WHERE id = $1 AND workspace_id = $2', [
      branchId,
      auth.workspaceId,
    ]);
    if (branch.rows.length === 0) throw new ApiError('Branch not found', 404);
    if (supplierId !== null) {
      const s = await txQuery(client, 'SELECT id FROM suppliers WHERE id = $1 AND workspace_id = $2', [
        supplierId,
        auth.workspaceId,
      ]);
      if (s.rows.length === 0) throw new ApiError('Supplier not found', 404);
    }

    let total = 0;
    const lines: Array<{
      medicineId: number;
      batchNumber: string;
      expiryDate: string;
      mfgDate: string | null;
      quantity: number;
      purchasePrice: number;
    }> = [];
    for (const raw of items) {
      const medicineId = raw.medicineId as number;
      const batchNumber = String(raw.batchNumber ?? '').trim();
      const expiryDate = String(raw.expiryDate ?? '');
      const quantity = raw.quantity as number;
      const purchasePrice = raw.purchasePrice as number;
      if (!Number.isInteger(medicineId) || !batchNumber) {
        throw new ApiError('Each purchase item needs medicineId and batchNumber', 400);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate) || Number.isNaN(Date.parse(expiryDate))) {
        throw new ApiError('Each purchase item needs a valid expiryDate (YYYY-MM-DD)', 400);
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new ApiError('Each purchase item needs quantity > 0', 400);
      }
      if (typeof purchasePrice !== 'number' || purchasePrice < 0) {
        throw new ApiError('Each purchase item needs purchasePrice >= 0', 400);
      }
      const med = await txQuery(client, 'SELECT id FROM medicines WHERE id = $1 AND workspace_id = $2', [
        medicineId,
        auth.workspaceId,
      ]);
      if (med.rows.length === 0) throw new ApiError(`Medicine not found: ${medicineId}`, 404);
      const mfgDate =
        typeof raw.mfgDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.mfgDate) ? raw.mfgDate : null;
      lines.push({ medicineId, batchNumber, expiryDate, mfgDate, quantity, purchasePrice });
      total += quantity * purchasePrice;
    }

    const purchase = await txQuery<{ id: number }>(
      client,
      `INSERT INTO purchases (workspace_id, branch_id, supplier_id, invoice_number, total, paid, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        auth.workspaceId,
        branchId,
        supplierId,
        invoiceNumber || null,
        total,
        paid,
        auth.user.id,
      ],
    );
    const purchaseId = purchase.rows[0].id;
    const inv = invoiceNumber || `PUR-${String(purchaseId).padStart(6, '0')}`;
    await txQuery(client, 'UPDATE purchases SET invoice_number = $1 WHERE id = $2', [inv, purchaseId]);

    const today = new Date().toISOString().slice(0, 10);
    for (const line of lines) {
      // Batches are NEVER merged: one batch row per purchase line, even if
      // the same batch number already exists.
      const status = line.expiryDate < today ? 'expired' : 'active';
      const batch = await txQuery<{ id: number }>(
        client,
        `INSERT INTO batches (workspace_id, branch_id, medicine_id, batch_number, mfg_date, expiry_date, quantity, purchase_price, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          auth.workspaceId,
          branchId,
          line.medicineId,
          line.batchNumber,
          line.mfgDate,
          line.expiryDate,
          line.quantity,
          line.purchasePrice,
          status,
        ],
      );
      await txQuery(
        client,
        `INSERT INTO purchase_items (purchase_id, medicine_id, batch_id, batch_number, expiry_date, mfg_date, quantity, purchase_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          purchaseId,
          line.medicineId,
          batch.rows[0].id,
          line.batchNumber,
          line.expiryDate,
          line.mfgDate,
          line.quantity,
          line.purchasePrice,
        ],
      );
      await txQuery(
        client,
        `INSERT INTO stock_movements (workspace_id, branch_id, medicine_id, batch_id, type, quantity, reason, user_id)
         VALUES ($1,$2,$3,$4,'purchase',$5,$6,$7)`,
        [auth.workspaceId, branchId, line.medicineId, batch.rows[0].id, line.quantity, inv, auth.user.id],
      );
    }
    if (supplierId !== null && total - paid > 0) {
      await txQuery(client, 'UPDATE suppliers SET balance = balance + $1 WHERE id = $2', [
        total - paid,
        supplierId,
      ]);
    }
    await audit(
      auth.workspaceId,
      auth.user.id,
      'purchase',
      `Purchase ${inv}: total ${total}, paid ${paid}`,
      client,
    );
    return {
      id: purchaseId,
      invoiceNumber: inv,
      supplierId,
      total,
      paid,
      items: lines.map((l) => ({
        medicineId: l.medicineId,
        batchNumber: l.batchNumber,
        expiryDate: l.expiryDate,
        mfgDate: l.mfgDate ?? undefined,
        quantity: l.quantity,
        purchasePrice: l.purchasePrice,
      })),
    };
  });
}

export async function listsuppliers(ctx: HandlerCtx, _body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const res = await query<Record<string, unknown>>(
    'SELECT * FROM suppliers WHERE workspace_id = $1 ORDER BY name ASC',
    [auth.workspaceId],
  );
  return res.rows.map(mapSupplier);
}

export async function savesupplier(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  requireRoles(auth, ['Admin', 'Pharmacist', 'Inventory Manager']);
  const name = reqStr(body, 'name');
  const id = body.id === undefined || body.id === null ? null : (body.id as number);
  if (id !== null && !Number.isInteger(id)) throw new ApiError('id must be an integer', 400);
  const contactPerson = optStrNull(body, 'contactPerson');
  const phone = optStrNull(body, 'phone');
  const email = optStrNull(body, 'email');
  const address = optStrNull(body, 'address');
  if (id === null) {
    const res = await query<Record<string, unknown>>(
      `INSERT INTO suppliers (workspace_id, name, contact_person, phone, email, address)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [auth.workspaceId, name, contactPerson, phone, email, address],
    );
    return mapSupplier(res.rows[0]);
  }
  const res = await query<Record<string, unknown>>(
    `UPDATE suppliers SET name=$3, contact_person=$4, phone=$5, email=$6, address=$7
      WHERE id=$1 AND workspace_id=$2 RETURNING *`,
    [id, auth.workspaceId, name, contactPerson, phone, email, address],
  );
  if (res.rows.length === 0) throw new ApiError('Supplier not found', 404);
  return mapSupplier(res.rows[0]);
}

export async function supplierpayment(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  requireRoles(auth, ['Admin', 'Pharmacist']);
  const supplierId = reqInt(body, 'supplierId');
  const amount = reqInt(body, 'amount');
  if (amount <= 0) throw new ApiError('amount must be > 0', 400);
  const method = optStr(body, 'method', 'Cash');
  const note = optStr(body, 'note', '');
  return withTx(async (client) => {
    const s = await txQuery<Record<string, unknown>>(
      client,
      'SELECT * FROM suppliers WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
      [supplierId, auth.workspaceId],
    );
    if (s.rows.length === 0) throw new ApiError('Supplier not found', 404);
    await txQuery(client, 'UPDATE suppliers SET balance = balance - $1 WHERE id = $2', [amount, supplierId]);
    await audit(
      auth.workspaceId,
      auth.user.id,
      'supplier_payment',
      `Paid ${amount} (${method}) to supplier ${s.rows[0].name}${note ? `: ${note}` : ''}`,
      client,
    );
    return { ok: true, supplierId, balance: Number(s.rows[0].balance) - amount };
  });
}
