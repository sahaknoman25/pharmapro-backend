-- PharmaPro backend — migration 001: full schema.
-- Multi-tenant: every business row carries workspace_id.
-- Amounts are integer minor units in the workspace currency (e.g. AFN).
-- Dates: expiry_date / mfg_date / date are DATE; created_at is timestamptz.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tenancy & admin
CREATE TABLE IF NOT EXISTS workspaces (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | suspended
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS branches (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  is_main BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id),
  branch_id INT REFERENCES branches(id),
  name TEXT NOT NULL,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Cashier', -- Admin | Pharmacist | Cashier | Inventory Manager
  shift TEXT NOT NULL DEFAULT 'Day',    -- Day | Night
  language TEXT NOT NULL DEFAULT 'fa',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_swm_admin BOOLEAN NOT NULL DEFAULT FALSE, -- SWM platform admin (set by SWM only)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, username)
);

CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  price_monthly INT NOT NULL DEFAULT 0,
  price_yearly INT NOT NULL DEFAULT 0,
  features JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id),
  plan_id INT NOT NULL REFERENCES plans(id),
  billing_cycle TEXT NOT NULL DEFAULT 'monthly', -- monthly | yearly
  status TEXT NOT NULL DEFAULT 'active',        -- trial | active | expired | cancelled
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS platform_payments (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id),
  subscription_id INT REFERENCES subscriptions(id),
  amount INT NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'Cash',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_settings (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL UNIQUE REFERENCES workspaces(id),
  currency TEXT NOT NULL DEFAULT 'AFN',
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  language TEXT NOT NULL DEFAULT 'fa'
);

-- Payment methods: workspace_id NULL = global defaults seeded in 002.
CREATE TABLE IF NOT EXISTS payment_methods (
  id SERIAL PRIMARY KEY,
  workspace_id INT REFERENCES workspaces(id),
  name TEXT NOT NULL,
  is_manual BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pharmacy
CREATE TABLE IF NOT EXISTS medicines (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  generic_name TEXT,
  brand_name TEXT,
  manufacturer TEXT,
  country TEXT,
  category TEXT NOT NULL DEFAULT 'Tablets',
  barcode TEXT,
  product_code TEXT,
  reg_number TEXT,
  dosage_form TEXT NOT NULL DEFAULT 'Tablet',
  strength TEXT,
  unit TEXT NOT NULL DEFAULT 'pcs',
  purchase_price INT NOT NULL DEFAULT 0,
  selling_price INT NOT NULL DEFAULT 0,
  min_stock INT NOT NULL DEFAULT 10,
  prescription_required BOOLEAN NOT NULL DEFAULT FALSE,
  description TEXT,
  storage_info TEXT,
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS batches (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id),
  branch_id INT NOT NULL REFERENCES branches(id),
  medicine_id INT NOT NULL REFERENCES medicines(id),
  batch_number TEXT NOT NULL,
  mfg_date DATE,
  expiry_date DATE NOT NULL,
  quantity INT NOT NULL DEFAULT 0,
  purchase_price INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', -- active | damaged | expired | returned
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  balance INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id),
  branch_id INT NOT NULL REFERENCES branches(id),
  supplier_id INT REFERENCES suppliers(id),
  invoice_number TEXT,
  total INT NOT NULL DEFAULT 0,
  paid INT NOT NULL DEFAULT 0,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id SERIAL PRIMARY KEY,
  purchase_id INT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  medicine_id INT NOT NULL REFERENCES medicines(id),
  batch_id INT REFERENCES batches(id),
  batch_number TEXT NOT NULL,
  expiry_date DATE NOT NULL,
  mfg_date DATE,
  quantity INT NOT NULL,
  purchase_price INT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  credit_limit INT NOT NULL DEFAULT 0,
  balance INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_payments (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id),
  customer_id INT NOT NULL REFERENCES customers(id),
  amount INT NOT NULL,
  method TEXT NOT NULL DEFAULT 'Cash',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id),
  branch_id INT NOT NULL REFERENCES branches(id),
  customer_id INT REFERENCES customers(id),
  invoice_number TEXT,
  total INT NOT NULL DEFAULT 0,
  discount INT NOT NULL DEFAULT 0,
  tax INT NOT NULL DEFAULT 0,
  paid INT NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'Cash',
  status TEXT NOT NULL DEFAULT 'completed', -- completed | voided | returned
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sale_items (
  id SERIAL PRIMARY KEY,
  sale_id INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  medicine_id INT NOT NULL REFERENCES medicines(id),
  batch_id INT NOT NULL REFERENCES batches(id),
  quantity INT NOT NULL,
  price INT NOT NULL,
  cost INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id),
  branch_id INT REFERENCES branches(id),
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  amount INT NOT NULL,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cash_closings (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id),
  branch_id INT REFERENCES branches(id),
  date DATE NOT NULL,
  opening_cash INT NOT NULL DEFAULT 0,
  cash_sales INT NOT NULL DEFAULT 0,
  cash_expenses INT NOT NULL DEFAULT 0,
  expected_cash INT NOT NULL DEFAULT 0,
  counted_cash INT NOT NULL DEFAULT 0,
  difference INT NOT NULL DEFAULT 0,
  closed_by_user_id INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS push_tokens (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expo_push_token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, expo_push_token)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id),
  branch_id INT REFERENCES branches(id),
  medicine_id INT REFERENCES medicines(id),
  batch_id INT REFERENCES batches(id),
  type TEXT NOT NULL, -- purchase | sale | adjustment | transfer | void | return | status
  quantity INT NOT NULL,
  reason TEXT,
  user_id INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transfers (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id),
  from_branch_id INT NOT NULL REFERENCES branches(id),
  to_branch_id INT NOT NULL REFERENCES branches(id),
  batch_id INT NOT NULL REFERENCES batches(id),
  quantity INT NOT NULL,
  user_id INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id),
  user_id INT REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_branches_ws ON branches (workspace_id);
CREATE INDEX IF NOT EXISTS idx_users_ws ON users (workspace_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_ws ON subscriptions (workspace_id);
CREATE INDEX IF NOT EXISTS idx_medicines_ws ON medicines (workspace_id);
CREATE INDEX IF NOT EXISTS idx_medicines_barcode ON medicines (workspace_id, barcode);
CREATE INDEX IF NOT EXISTS idx_batches_ws ON batches (workspace_id);
CREATE INDEX IF NOT EXISTS idx_batches_med_expiry ON batches (medicine_id, expiry_date);
CREATE INDEX IF NOT EXISTS idx_batches_branch ON batches (workspace_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_ws ON suppliers (workspace_id);
CREATE INDEX IF NOT EXISTS idx_purchases_ws ON purchases (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sales_ws ON sales (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sales_branch ON sales (workspace_id, branch_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items (sale_id);
CREATE INDEX IF NOT EXISTS idx_customers_ws ON customers (workspace_id);
CREATE INDEX IF NOT EXISTS idx_expenses_ws ON expenses (workspace_id, date);
CREATE INDEX IF NOT EXISTS idx_movements_ws ON stock_movements (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_ws ON audit_logs (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_closings_ws ON cash_closings (workspace_id, date);
