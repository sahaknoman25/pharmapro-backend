// FEFO allocation (server-side, mandatory).
// A sale consumes batches in earliest-expiry order, spilling over to the
// next batch when one is exhausted. Expired batches are never sellable.
import { Tx, txQuery } from '../db';

export interface BatchRow {
  id: number;
  batch_number: string;
  expiry_date: Date | string;
  quantity: number;
  purchase_price: number;
}

export interface Allocation {
  batchId: number;
  batchNumber: string;
  quantity: number;
  cost: number; // purchase price of that batch (per unit)
}

/** Sellable batches for a medicine in a branch: status active, expiry >= today. */
export async function sellableBatches(
  client: Tx,
  workspaceId: number,
  branchId: number,
  medicineId: number,
): Promise<BatchRow[]> {
  const res = await txQuery<BatchRow>(
    client,
    `SELECT id, batch_number, expiry_date, quantity, purchase_price
       FROM batches
      WHERE workspace_id = $1 AND branch_id = $2 AND medicine_id = $3
        AND status = 'active' AND quantity > 0 AND expiry_date >= CURRENT_DATE
      ORDER BY expiry_date ASC, id ASC
      FOR UPDATE`,
    [workspaceId, branchId, medicineId],
  );
  return res.rows;
}

/**
 * Allocates `quantity` units of a medicine across its sellable batches in
 * FEFO order. Returns the allocations and decrements the batches.
 * Throws if the sellable stock is not enough (caller rolls back).
 */
export async function allocateFefo(
  client: Tx,
  workspaceId: number,
  branchId: number,
  medicineId: number,
  quantity: number,
): Promise<{ allocations: Allocation[]; sellable: number }> {
  const batches = await sellableBatches(client, workspaceId, branchId, medicineId);
  const sellable = batches.reduce((sum, b) => sum + b.quantity, 0);
  if (sellable < quantity) {
    throw new Error(`INSUFFICIENT:${sellable}`);
  }
  let remaining = quantity;
  const allocations: Allocation[] = [];
  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(b.quantity, remaining);
    await txQuery(client, 'UPDATE batches SET quantity = quantity - $1 WHERE id = $2', [take, b.id]);
    allocations.push({ batchId: b.id, batchNumber: b.batch_number, quantity: take, cost: b.purchase_price });
    remaining -= take;
  }
  return { allocations, sellable };
}

/** Restores quantities to the exact original batches (void / return). */
export async function restoreToBatches(
  client: Tx,
  items: Array<{ batchId: number; quantity: number }>,
): Promise<void> {
  for (const item of items) {
    await txQuery(client, 'UPDATE batches SET quantity = quantity + $1 WHERE id = $2', [
      item.quantity,
      item.batchId,
    ]);
  }
}
