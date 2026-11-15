// Audit log helper + shared row mappers (DB snake_case -> API camelCase).
import { query, Tx, txQuery } from '../db';
import { fmtDate, fmtTs } from '../util';

export async function audit(
  workspaceId: number,
  userId: number | null,
  action: string,
  detail: string,
  client?: Tx,
): Promise<void> {
  if (client) {
    await txQuery(client, 'INSERT INTO audit_logs (workspace_id, user_id, action, detail) VALUES ($1,$2,$3,$4)', [
      workspaceId, userId, action, detail,
    ]);
  } else {
    await query('INSERT INTO audit_logs (workspace_id, user_id, action, detail) VALUES ($1,$2,$3,$4)', [
      workspaceId, userId, action, detail,
    ]);
  }
}

export function expiryStatus(expiryDate: string | null, status: string): string {
  if (!expiryDate) return 'ok';
  if (status === 'expired') return 'expired';
  const today = new Date().toISOString().slice(0, 10);
  if (expiryDate < today) return 'expired';
  const near = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (expiryDate <= near) return 'near';
  return 'ok';
}

export function mapMedicine(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    genericName: r.generic_name ?? undefined,
    brandName: r.brand_name ?? undefined,
    manufacturer: r.manufacturer ?? undefined,
    country: r.country ?? undefined,
    category: r.category,
    barcode: r.barcode ?? undefined,
    productCode: r.product_code ?? undefined,
    regNumber: r.reg_number ?? undefined,
    dosageForm: r.dosage_form,
    strength: r.strength ?? undefined,
    unit: r.unit,
    purchasePrice: r.purchase_price,
    sellingPrice: r.selling_price,
    minStock: r.min_stock,
    prescriptionRequired: r.prescription_required,
    description: r.description ?? undefined,
    storageInfo: r.storage_info ?? undefined,
    imageUrl: r.image_url ?? undefined,
    stock: r.stock !== undefined ? Number(r.stock) : undefined,
    nextExpiry: r.next_expiry ? fmtDate(r.next_expiry) : null,
    batchCount: r.batch_count !== undefined ? Number(r.batch_count) : undefined,
  };
}

export function mapBatch(r: Record<string, unknown>): Record<string, unknown> {
  const exp = fmtDate(r.expiry_date);
  return {
    id: r.id,
    medicineId: r.medicine_id,
    medicineName: r.medicine_name ?? undefined,
    batchNumber: r.batch_number,
    mfgDate: fmtDate(r.mfg_date) ?? undefined,
    expiryDate: exp,
    quantity: r.quantity,
    purchasePrice: r.purchase_price,
    status: r.status,
    branchId: r.branch_id,
    expiryStatus: expiryStatus(exp, String(r.status ?? 'active')),
  };
}

export function mapCustomer(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone ?? undefined,
    email: r.email ?? undefined,
    address: r.address ?? undefined,
    creditLimit: r.credit_limit,
    balance: r.balance,
  };
}

export function mapSupplier(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    contactPerson: r.contact_person ?? undefined,
    phone: r.phone ?? undefined,
    email: r.email ?? undefined,
    address: r.address ?? undefined,
    balance: r.balance,
  };
}

export function mapExpense(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    amount: r.amount,
    date: fmtDate(r.date) ?? undefined,
    note: r.note ?? undefined,
    branchId: r.branch_id ?? null,
  };
}

export function mapBranch(r: Record<string, unknown>): Record<string, unknown> {
  return { id: r.id, name: r.name, address: r.address ?? undefined, phone: r.phone ?? undefined };
}

export function mapEmployee(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    username: r.username,
    role: r.role,
    shift: r.shift,
    branchId: r.branch_id ?? null,
    isActive: r.is_active,
    language: r.language,
  };
}

export function mapMovement(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id,
    medicineId: r.medicine_id ?? undefined,
    medicineName: r.medicine_name ?? undefined,
    batchNumber: r.batch_number ?? undefined,
    type: r.type,
    quantity: r.quantity,
    reason: r.reason ?? undefined,
    userName: r.user_name ?? undefined,
    createdAt: fmtTs(r.created_at) ?? undefined,
  };
}

export function mapTransfer(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id,
    batchId: r.batch_id,
    batchNumber: r.batch_number ?? undefined,
    medicineName: r.medicine_name ?? undefined,
    fromBranchId: r.from_branch_id,
    toBranchId: r.to_branch_id,
    quantity: r.quantity,
    createdAt: fmtTs(r.created_at) ?? undefined,
  };
}

export function mapAudit(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id,
    userName: r.user_name ?? undefined,
    action: r.action,
    detail: r.detail ?? undefined,
    createdAt: fmtTs(r.created_at) ?? undefined,
  };
}

export function mapPlan(r: Record<string, unknown>): Record<string, unknown> {
  return {
    name: r.name,
    priceMonthly: r.price_monthly,
    priceYearly: r.price_yearly,
    features: Array.isArray(r.features) ? r.features : [],
  };
}
