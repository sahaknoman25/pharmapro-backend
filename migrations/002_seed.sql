-- PharmaPro backend — migration 002: seed plans and default payment methods.
-- Prices are 0 (not set) on purpose: SWM sets real subscription prices in
-- the plans table before selling. Do not treat 0 as a real price.
INSERT INTO plans (name, price_monthly, price_yearly, features) VALUES
  ('Free Trial', 0, 0, '["1 branch", "POS", "Inventory", "30-day trial"]'::jsonb),
  ('Basic', 0, 0, '["1 branch", "POS", "Inventory", "Purchases", "Customers & qarz", "Reports"]'::jsonb),
  ('Professional', 0, 0, '["Up to 3 branches", "Everything in Basic", "Employees & roles", "Branch transfers", "AI assistant", "Excel export"]'::jsonb),
  ('Enterprise', 0, 0, '["Unlimited branches", "Everything in Professional", "SWM priority support", "Custom onboarding"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- Global default payment methods (workspace_id NULL), as in the web app.
INSERT INTO payment_methods (workspace_id, name, is_manual) VALUES
  (NULL, 'Cash', FALSE),
  (NULL, 'Qarz', FALSE),
  (NULL, 'HesabPay manual', TRUE),
  (NULL, 'M-Paisa manual', TRUE),
  (NULL, 'Card', FALSE)
ON CONFLICT DO NOTHING;
