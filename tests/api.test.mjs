// PharmaPro backend API tests (node:test).
// Spins up the real server against a real PostgreSQL test database
// (pharmapro_test, recreated by tests/setup-test-db.mjs via `npm test`).
// Covers: setup + login + logout, purchase creating 3 batches, FEFO sale
// of 7 (3 from B-101 + 4 from B-102, expired untouched), oversell
// rejection, Qarz sale + void restoring stock and balance, tenant
// isolation, export/restore round-trip, cash closing, branch reports.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.join(__dirname, '..');
const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/pharmapro_test';

let server = null;

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - start > timeoutMs) throw new Error('Server did not become healthy in time');
    await new Promise((r) => setTimeout(r, 250));
  }
}

before(async () => {
  server = spawn(
    'node',
    [path.join(BACKEND_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
    {
      cwd: BACKEND_DIR,
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        PORT: String(PORT),
        SESSION_SECRET: 'test-secret',
        DISABLE_AUTO_MIGRATE: '1',
      },
      stdio: 'pipe',
    },
  );
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth();
});

after(async () => {
  if (server) server.kill('SIGTERM');
});

async function call(action, body = {}, token = null) {
  const res = await fetch(`${BASE}/api/v1/actions/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, ...(token ? { token } : {}) }),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function ok(action, body = {}, token = null) {
  const { status, json } = await call(action, body, token);
  assert.equal(json.ok, true, `${action} failed (HTTP ${status}): ${JSON.stringify(json)}`);
  return json.data;
}

async function fails(action, body = {}, token = null) {
  const { json } = await call(action, body, token);
  assert.equal(json.ok, false, `${action} unexpectedly succeeded: ${JSON.stringify(json)}`);
  return json.error;
}

let token;
let branchId;
let medicineId;
let customerId;
let supplierId;
let cashSaleId;
let qarzSaleId;

test('bootstrap reports no workspace and 4 plans', async () => {
  const data = await ok('getbootstrap');
  assert.equal(data.hasWorkspace, false);
  assert.equal(data.plans.length, 4);
  assert.deepEqual(
    data.plans.map((p) => p.name),
    ['Free Trial', 'Basic', 'Professional', 'Enterprise'],
  );
});

test('setupworkspace creates workspace, branch, admin; login works', async () => {
  const data = await ok('setupworkspace', {
    workspaceName: 'Test Pharmacy',
    ownerName: 'Test Owner',
    adminName: 'Test Admin',
    username: 'admin',
    password: 'admin123',
    currency: 'AFN',
    language: 'fa',
  });
  assert.ok(data.token);
  assert.equal(data.user.username, 'admin');
  assert.equal(data.user.role, 'Admin');
  token = data.token;

  const login = await ok('login', { username: 'admin', password: 'admin123' });
  assert.ok(login.token);
  assert.equal(login.user.workspaceName, 'Test Pharmacy');

  const err = await fails('login', { username: 'admin', password: 'wrong' });
  assert.match(err, /Login failed/);

  const branches = await ok('listbranches', {}, token);
  assert.equal(branches.length, 1);
  branchId = branches[0].id;

  const sub = await ok('getsubscription', {}, token);
  assert.equal(sub.planName, 'Free Trial');
});

test('create medicine, customer, supplier', async () => {
  const med = await ok('savemedicine', {
    name: 'Paracetamol 500mg',
    genericName: 'Paracetamol',
    category: 'Tablets',
    dosageForm: 'Tablet',
    strength: '500mg',
    unit: 'pcs',
    purchasePrice: 10,
    sellingPrice: 20,
    minStock: 2,
  }, token);
  medicineId = med.id;
  assert.equal(med.name, 'Paracetamol 500mg');

  const customer = await ok('savecustomer', { name: 'Ahmad', phone: '0790000000', creditLimit: 100000 }, token);
  customerId = customer.id;
  assert.equal(customer.balance, 0);

  const supplier = await ok('savesupplier', { name: 'Kabul Pharma', phone: '0790000001' }, token);
  supplierId = supplier.id;
});

test('purchase creates 3 separate batches (one expired)', async () => {
  const purchase = await ok('createpurchase', {
    branchId,
    supplierId,
    invoiceNumber: 'PUR-TEST-1',
    paid: 0,
    items: [
      { medicineId, batchNumber: 'B-101', expiryDate: '2027-06-30', quantity: 3, purchasePrice: 10 },
      { medicineId, batchNumber: 'B-102', expiryDate: '2027-12-31', quantity: 5, purchasePrice: 10 },
      { medicineId, batchNumber: 'B-090', expiryDate: '2025-01-01', quantity: 5, purchasePrice: 10 },
    ],
  }, token);
  assert.equal(purchase.total, 130);
  assert.equal(purchase.invoiceNumber, 'PUR-TEST-1');

  const batches = await ok('listbatches', {}, token);
  assert.equal(batches.length, 3);
  const b090 = batches.find((b) => b.batchNumber === 'B-090');
  assert.equal(b090.status, 'expired');
  assert.equal(b090.expiryStatus, 'expired');

  const suppliers = await ok('listsuppliers', {}, token);
  assert.equal(suppliers.find((s) => s.id === supplierId).balance, 130);
});

test('possearch excludes expired batches and previews FEFO batch', async () => {
  const results = await ok('possearch', { branchId, query: 'Para' }, token);
  assert.equal(results.length, 1);
  assert.equal(results[0].sellableStock, 8); // 3 + 5, expired 5 excluded
  assert.equal(results[0].fefoBatch, 'B-101');
});

test('sale of 7 allocates 3 from B-101 + 4 from B-102, correct change', async () => {
  const sale = await ok('createsale', {
    branchId,
    items: [{ medicineId, quantity: 7 }],
    paid: 150,
    paymentMethod: 'Cash',
  }, token);
  assert.equal(sale.total, 140);
  assert.equal(sale.change, 10);
  assert.deepEqual(sale.allocations, [
    { medicineId, batchNumber: 'B-101', quantity: 3 },
    { medicineId, batchNumber: 'B-102', quantity: 4 },
  ]);
  cashSaleId = sale.saleId;

  const batches = await ok('listbatches', {}, token);
  const byNumber = Object.fromEntries(batches.map((b) => [b.batchNumber, b.quantity]));
  assert.equal(byNumber['B-101'], 0);
  assert.equal(byNumber['B-102'], 1);
  assert.equal(byNumber['B-090'], 5); // expired batch untouched

  const dash = await ok('getdashboard', {}, token);
  assert.equal(dash.todayRevenue, 140);
  assert.equal(dash.grossProfit, 70); // 7 x (20 - 10)
});

test('oversell is rejected', async () => {
  const err = await fails('createsale', {
    branchId,
    items: [{ medicineId, quantity: 5 }],
    paid: 100,
    paymentMethod: 'Cash',
  }, token);
  assert.match(err, /only 1 sellable/);
});

test('Qarz sale increases customer balance', async () => {
  const sale = await ok('createsale', {
    branchId,
    items: [{ medicineId, quantity: 1 }],
    paymentMethod: 'Qarz',
    customerId,
  }, token);
  assert.equal(sale.total, 20);
  assert.equal(sale.change, 0);
  qarzSaleId = sale.saleId;

  const customers = await ok('listcustomers', {}, token);
  assert.equal(customers.find((c) => c.id === customerId).balance, 20);
});

test('void restores stock and zeroes the qarz balance', async () => {
  await ok('voidsale', { saleId: qarzSaleId, reason: 'test void' }, token);

  const batches = await ok('listbatches', {}, token);
  assert.equal(batches.find((b) => b.batchNumber === 'B-102').quantity, 1);
  const customers = await ok('listcustomers', {}, token);
  assert.equal(customers.find((c) => c.id === customerId).balance, 0);

  const sales = await ok('listsales', {}, token);
  assert.equal(sales.find((s) => s.id === qarzSaleId).status, 'voided');
  assert.equal(sales.find((s) => s.id === cashSaleId).status, 'completed');
});

test('cash closing and branch report agree with the cash sale', async () => {
  const closing = await ok('closecash', { date: new Date().toISOString().slice(0, 10), openingCash: 1000, countedCash: 1140, branchId }, token);
  assert.equal(closing.cashSales, 140);
  assert.equal(closing.expectedCash, 1140);
  assert.equal(closing.difference, 0);

  const reports = await ok('getreports', { branchId }, token);
  assert.equal(reports.totalSales, 140);
  assert.equal(reports.totalProfit, 70);
});

test('tenant isolation: second workspace sees nothing of the first', async () => {
  const second = await ok('registerworkspace', {
    workspaceName: 'Other Pharmacy',
    ownerName: 'Other Owner',
    username: 'otheradmin',
    password: 'other123',
  });
  const token2 = second.token;

  const meds = await ok('listmedicines', {}, token2);
  assert.equal(meds.length, 0);
  const dash = await ok('getdashboard', {}, token2);
  assert.equal(dash.totalMedicines, 0);

  // Cannot void the first workspace's sale from the second workspace.
  const err = await fails('voidsale', { saleId: cashSaleId }, token2);
  assert.match(err, /not found/i);
});

test('exportdata / restore round-trip creates a verified copy, original untouched', async () => {
  const exported = await ok('exportdata', {}, token);
  assert.ok(typeof exported.backup === 'string');
  const parsed = JSON.parse(exported.backup);
  assert.equal(parsed.tables.medicines.length, 1);
  assert.equal(parsed.tables.sales.length, 2);

  const restored = await ok('restore', { backup: exported.backup }, token);
  assert.equal(restored.status, 'restored-copy');
  assert.equal(restored.verified, true);
  assert.equal(restored.counts.medicines, 1);
  assert.equal(restored.counts.sales, 2);
  assert.equal(restored.counts.batches, 3);

  // Original workspace still has its data.
  const meds = await ok('listmedicines', {}, token);
  assert.equal(meds.length, 1);

  // The restored copy is a usable workspace: log in with the same credentials.
  const login = await ok('login', { username: 'admin', password: 'admin123' });
  assert.ok(login.token);
});

test('logout invalidates the token', async () => {
  await ok('logout', {}, token);
  const err = await fails('getdashboard', {}, token);
  assert.match(err, /Not signed in|log in/i);
});
