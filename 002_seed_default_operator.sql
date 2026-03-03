-- Seed a default operator/admin set aligned with current CRM usage.
-- Safe to rerun.

BEGIN;

INSERT INTO users (name, email, status)
VALUES
  ('Oybek', 'oybek@example.local', 'active')
ON CONFLICT (email) DO NOTHING;

INSERT INTO users (name, email, status)
VALUES
  ('Madina', 'madina@example.local', 'active')
ON CONFLICT (email) DO NOTHING;

INSERT INTO users (name, email, status)
VALUES
  ('Jasur', 'jasur@example.local', 'active')
ON CONFLICT (email) DO NOTHING;

-- Map all seeded users as operators
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u
JOIN roles r ON r.code = 'operator'
WHERE u.email IN ('oybek@example.local','madina@example.local','jasur@example.local')
ON CONFLICT (user_id, role_id) DO NOTHING;

COMMIT;
