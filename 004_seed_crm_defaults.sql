-- Seed default organization + pipeline stages
-- Safe to rerun.

BEGIN;

INSERT INTO organizations (name, slug)
VALUES ('Monetizator Pro', 'monetizator-pro')
ON CONFLICT (slug) DO NOTHING;

-- Link existing users to the default org
INSERT INTO organization_users (organization_id, user_id)
SELECT o.id, u.id
FROM organizations o
CROSS JOIN users u
WHERE o.slug = 'monetizator-pro'
ON CONFLICT (organization_id, user_id) DO NOTHING;

-- Default pipeline stages based on current CRM
INSERT INTO pipeline_stages (organization_id, code, name, color, background, sort_order)
SELECT o.id, s.code, s.name, s.color, s.bg, s.ord
FROM organizations o
CROSS JOIN (
  VALUES
    ('new', 'New', '#5a5a54', '#f1f1ef', 1),
    ('strategy_call', 'Strategy Call', '#6e40c9', '#f3f0ff', 2),
    ('decision', 'Decision', '#0066cc', '#eff4ff', 3),
    ('payment_waiting', 'Payment waiting', '#a05c00', '#fff7eb', 4),
    ('pre_payment', 'Pre-payment', '#0f7b5f', '#edfaf3', 5),
    ('rejected', 'Rejected', '#9a9a92', '#f1f1ef', 6)
) AS s(code, name, color, bg, ord)
WHERE o.slug = 'monetizator-pro'
ON CONFLICT (organization_id, code) DO NOTHING;

-- Attach existing leads to the default org where empty
UPDATE leads
SET organization_id = o.id
FROM organizations o
WHERE o.slug = 'monetizator-pro'
  AND leads.organization_id IS NULL;

COMMIT;
