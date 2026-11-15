// Medicines, batches, stock movements, transfers.
import { query, withTx, txQuery } from '../db';
import { ApiError } from '../errors';
import { requireAuth, requireRoles } from '../auth';
import { audit, mapBatch, mapMedicine, mapMovement, mapTransfer } from '../lib/common';
import { fmtDate, optBool, optInt, optStr, optStrNull, reqDate, reqInt, reqStr, todayStr } from '../util';
import { HandlerCtx } from './types';

export async function listmedicines(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const search = optStr(body, 'search', '').trim();
  const like = `%${search}%`;
  const res = await query<Record<string, unknown>>(
    `SELECT m.*,
            COALESCE(SUM(CASE WHEN b.status = 'active' AND b.expiry_date >= CURRENT_DATE THEN b.quantity ELSE 0 END), 0) AS stock,
            (SELECT MIN(b2.expiry_date) FROM batches b2
              WHERE b2.medicine_id = m.id AND b2.status = 'active' AND b2.expiry_date >= CURRENT_DATE) AS next_expiry,
            (SELECT COUNT(*) FROM batches b3 WHERE b3.medicine_id = m.id) AS batch_count
       FROM medicines m
       LEFT JOIN batches b ON b.medicine_id = m.id
      WHERE m.workspace_id = $1
        AND ($2 = '' OR m.name ILIKE $3 OR COALESCE(m.barcode,'') ILIKE $3 OR COALESCE(m.generic_name,'') ILIKE $3)
      GROUP BY m.id
      ORDER BY m.name ASC`,
    [auth.workspaceId, search, like],
  );
  return res.rows.map(mapMedicine);
}

export async function savemedicine(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  requireRoles(auth, ['Admin', 'Pharmacist', 'Inventory Manager']);
  const name = reqStr(body, 'name');
  const id = body.id === undefined || body.id === null ? null : (body.id as number);
  if (id !== null && !Number.isInteger(id)) throw new ApiError('id must be an integer', 400);
  const fields = {
    genericName: optStrNull(body, 'genericName'),
    brandName: optStrNull(body, 'brandName'),
    manufacturer: optStrNull(body, 'manufacturer'),
    country: optStrNull(body, 'country'),
    category: optStr(body, 'category', 'Tablets'),
    barcode: optStrNull(body, 'barcode'),
    productCode: optStrNull(body, 'productCode'),
    regNumber: optStrNull(body, 'regNumber'),
    dosageForm: optStr(body, 'dosageForm', 'Tablet'),
    strength: optStrNull(body, 'strength'),
    unit: optStr(body, 'unit', 'pcs'),
    purchasePrice: optInt(body, 'purchasePrice', 0),
    sellingPrice: optInt(body, 'sellingPrice', 0),
    minStock: optInt(body, 'minStock', 10),
    prescriptionRequired: optBool(body, 'prescriptionRequired', false),
    description: optStrNull(body, 'description'),
    storageInfo: optStrNull(body, 'storageInfo'),
    imageUrl: optStrNull(body, 'imageUrl'),
  };
  if (fields.purchasePrice < 0 || fields.sellingPrice < 0 || fields.minStock < 0) {
    throw new ApiError('Prices and minStock must be >= 0', 400);
  }
  if (id === null) {
    const res = await query<Record<string, unknown>>(
      `INSERT INTO medicines (workspace_id, name, generic_name, brand_name, manufacturer, country,
                              category, barcode, product_code, reg_number, dosage_form, strength, unit,
                              purchase_price, selling_price, min_stock, prescription_required,
                              description, storage_info, image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [
        auth.workspaceId, name, fields.genericName, fields.brandName, fields.manufacturer,
        fields.country, fields.category, fields.barcode, fields.productCode, fields.regNumber,
        fields.dosageForm, fields.strength, fields.unit, fields.purchasePrice, fields.sellingPrice,
        fields.minStock, fields.prescriptionRequired, fields.description, fields.storageInfo,
        fields.imageUrl,
      ],
    );
    await audit(auth.workspaceId, auth.user.id, 'medicine_create', `Created medicine ${name}`);
    return mapMedicine({ ...res.rows[0], stock: 0, next_expiry: null, batch_count: 0 });
  }
  const existing = await query('SELECT id FROM medicines WHERE id = $1 AND workspace_id = $2', [
    id,
    auth.workspaceId,
  ]);
  if (existing.rows.length === 0) throw new ApiError('Medicine not found', 404);
  const res = await query<Record<string, unknown>>(
    `UPDATE medicines SET name=$3, generic_name=$4, brand_name=$5, manufacturer=$6, country=$7,
                          category=$8, barcode=$9, product_code=$10, reg_number=$11, dosage_form=$12,
                          strength=$13, unit=$14, purchase_price=$15, selling_price=$16, min_stock=$17,
                          prescription_required=$18, description=$19, storage_info=$20, image_url=$21,
                          updated_at=now()
       WHERE id=$1 AND workspace_id=$2 RETURNING *`,
    [
      id, auth.workspaceId, name, fields.genericName, fields.brandName, fields.manufacturer,
      fields.country, fields.category, fields.barcode, fields.productCode, fields.regNumber,
      fields.dosageForm, fields.strength, fields.unit, fields.purchasePrice, fields.sellingPrice,
      fields.minStock, fields.prescriptionRequired, fields.description, fields.storageInfo,
      fields.imageUrl,
    ],
  );
  await audit(auth.workspaceId, auth.user.id, 'medicine_update', `Updated medicine ${name}`);
  return mapMedicine(res.rows[0]);
}

export async function listbatches(ctx: HandlerCtx, _body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const res = await query<Record<string, unknown>>(
    `SELECT b.*, m.name AS medicine_name
       FROM batches b JOIN medicines m ON m.id = b.medicine_id
      WHERE b.workspace_id = $1
      ORDER BY b.expiry_date ASC, b.id ASC`,
    [auth.workspaceId],
  );
  return res.rows.map(mapBatch);
}

export async function adjuststock(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  requireRoles(auth, ['Admin', 'Inventory Manager']);
  const batchId = reqInt(body, 'batchId');
  const newQty = reqInt(body, 'newQty');
  const reason = reqStr(body, 'reason');
  if (newQty < 0) throw new ApiError('newQty must be >= 0', 400);
  return withTx(async (client) => {
    const batch = await txQuery<Record<string, unknown>>(
      client,
      'SELECT * FROM batches WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
      [batchId, auth.workspaceId],
    );
    if (batch.rows.length === 0) throw new ApiError('Batch not found', 404);
    const oldQty = Number(batch.rows[0].quantity);
    await txQuery(client, 'UPDATE batches SET quantity = $1 WHERE id = $2', [newQty, batchId]);
    await txQuery(
      client,
      `INSERT INTO stock_movements (workspace_id, branch_id, medicine_id, batch_id, type, quantity, reason, user_id)
       VALUES ($1,$2,$3,$4,'adjustment',$5,$6,$7)`,
      [
        auth.workspaceId,
        batch.rows[0].branch_id,
        batch.rows[0].medicine_id,
        batchId,
        newQty - oldQty,
        reason,
        auth.user.id,
      ],
    );
    await audit(
      auth.workspaceId,
      auth.user.id,
      'adjust_stock',
      `Batch ${batch.rows[0].batch_number}: ${oldQty} -> ${newQty} (${reason})`,
      client,
    );
    return { ok: true, batchId, oldQty, newQty };
  });
}

export async function setbatchstatus(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  requireRoles(auth, ['Admin', 'Inventory Manager']);
  const batchId = reqInt(body, 'batchId');
  const status = reqStr(body, 'status');
  if (!['active', 'damaged', 'returned', 'expired'].includes(status)) {
    throw new ApiError('status must be active, damaged, returned or expired', 400);
  }
  const reason = optStr(body, 'reason', '');
  const batch = await query<Record<string, unknown>>(
    'SELECT * FROM batches WHERE id = $1 AND workspace_id = $2',
    [batchId, auth.workspaceId],
  );
  if (batch.rows.length === 0) throw new ApiError('Batch not found', 404);
  await query('UPDATE batches SET status = $1 WHERE id = $2', [status, batchId]);
  await query(
    `INSERT INTO stock_movements (workspace_id, branch_id, medicine_id, batch_id, type, quantity, reason, user_id)
     VALUES ($1,$2,$3,$4,'status',0,$5,$6)`,
    [
      auth.workspaceId,
      batch.rows[0].branch_id,
      batch.rows[0].medicine_id,
      batchId,
      `Status -> ${status}${reason ? `: ${reason}` : ''}`,
      auth.user.id,
    ],
  );
  await audit(
    auth.workspaceId,
    auth.user.id,
    'batch_status',
    `Batch ${batch.rows[0].batch_number} -> ${status}${reason ? `: ${reason}` : ''}`,
  );
  return { ok: true, batchId, status };
}

export async function listmovements(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const limit = Math.min(Math.max(optInt(body, 'limit', 100), 1), 500);
  const res = await query<Record<string, unknown>>(
    `SELECT sm.*, m.name AS medicine_name, b.batch_number, u.name AS user_name
       FROM stock_movements sm
       LEFT JOIN medicines m ON m.id = sm.medicine_id
       LEFT JOIN batches b ON b.id = sm.batch_id
       LEFT JOIN users u ON u.id = sm.user_id
      WHERE sm.workspace_id = $1
      ORDER BY sm.created_at DESC, sm.id DESC LIMIT $2`,
    [auth.workspaceId, limit],
  );
  return res.rows.map(mapMovement);
}

export async function createtransfer(ctx: HandlerCtx, body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  requireRoles(auth, ['Admin', 'Inventory Manager']);
  const fromBranchId = reqInt(body, 'fromBranchId');
  const toBranchId = reqInt(body, 'toBranchId');
  const batchId = reqInt(body, 'batchId');
  const quantity = reqInt(body, 'quantity');
  if (quantity <= 0) throw new ApiError('quantity must be > 0', 400);
  if (fromBranchId === toBranchId) throw new ApiError('Source and destination branches must differ', 400);
  return withTx(async (client) => {
    const branches = await txQuery<{ id: number }>(
      client,
      'SELECT id FROM branches WHERE workspace_id = $1 AND id IN ($2, $3)',
      [auth.workspaceId, fromBranchId, toBranchId],
    );
    if (branches.rows.length !== 2) throw new ApiError('Branch not found', 404);
    const batch = await txQuery<Record<string, unknown>>(
      client,
      'SELECT * FROM batches WHERE id = $1 AND workspace_id = $2 AND branch_id = $3 FOR UPDATE',
      [batchId, auth.workspaceId, fromBranchId],
    );
    if (batch.rows.length === 0) throw new ApiError('Batch not found in source branch', 404);
    const b = batch.rows[0];
    if (Number(b.quantity) < quantity) {
      throw new ApiError(`Not enough stock in batch ${b.batch_number}: only ${b.quantity}`, 400);
    }
    await txQuery(client, 'UPDATE batches SET quantity = quantity - $1 WHERE id = $2', [quantity, batchId]);
    const dest = await txQuery<{ id: number }>(
      client,
      `SELECT id FROM batches
        WHERE workspace_id = $1 AND branch_id = $2 AND medicine_id = $3
          AND batch_number = $4 AND expiry_date = $5 AND status = 'active'`,
      [auth.workspaceId, toBranchId, b.medicine_id, b.batch_number, fmtDate(b.expiry_date)],
    );
    let destBatchId: number;
    if (dest.rows.length > 0) {
      destBatchId = dest.rows[0].id;
      await txQuery(client, 'UPDATE batches SET quantity = quantity + $1 WHERE id = $2', [
        quantity,
        destBatchId,
      ]);
    } else {
      const created = await txQuery<{ id: number }>(
        client,
        `INSERT INTO batches (workspace_id, branch_id, medicine_id, batch_number, mfg_date, expiry_date, quantity, purchase_price, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active') RETURNING id`,
        [
          auth.workspaceId,
          toBranchId,
          b.medicine_id,
          b.batch_number,
          fmtDate(b.mfg_date),
          fmtDate(b.expiry_date),
          quantity,
          b.purchase_price,
        ],
      );
      destBatchId = created.rows[0].id;
    }
    const transfer = await txQuery<{ id: number }>(
      client,
      `INSERT INTO transfers (workspace_id, from_branch_id, to_branch_id, batch_id, quantity, user_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [auth.workspaceId, fromBranchId, toBranchId, batchId, quantity, auth.user.id],
    );
    await txQuery(
      client,
      `INSERT INTO stock_movements (workspace_id, branch_id, medicine_id, batch_id, type, quantity, reason, user_id)
       VALUES ($1,$2,$3,$4,'transfer',$5,$6,$7), ($1,$8,$3,$9,'transfer',$5,$6,$7)`,
      [
        auth.workspaceId,
        fromBranchId,
        b.medicine_id,
        batchId,
        -quantity,
        `Transfer #${transfer.rows[0].id}`,
        auth.user.id,
        toBranchId,
        destBatchId,
      ],
    );
    await audit(
      auth.workspaceId,
      auth.user.id,
      'transfer',
      `Transferred ${quantity} of batch ${b.batch_number} to branch ${toBranchId}`,
      client,
    );
    return { ok: true, transferId: transfer.rows[0].id };
  });
}

export async function listtransfers(ctx: HandlerCtx, _body: Record<string, unknown>): Promise<unknown> {
  const auth = requireAuth(ctx.auth);
  const res = await query<Record<string, unknown>>(
    `SELECT t.*, m.name AS medicine_name, b.batch_number
       FROM transfers t
       JOIN batches b ON b.id = t.batch_id
       JOIN medicines m ON m.id = b.medicine_id
      WHERE t.workspace_id = $1
      ORDER BY t.created_at DESC, t.id DESC`,
    [auth.workspaceId],
  );
  return res.rows.map(mapTransfer);
}
