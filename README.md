Run in order:

1. `001_operators_roles_assignments.sql`
2. `002_seed_default_operator.sql`
3. `003_full_crm_schema.sql`
4. `004_seed_crm_defaults.sql`

Example (Postgres):

```bash
psql "$DATABASE_URL" -f db/migrations/001_operators_roles_assignments.sql
psql "$DATABASE_URL" -f db/migrations/002_seed_default_operator.sql
psql "$DATABASE_URL" -f db/migrations/003_full_crm_schema.sql
psql "$DATABASE_URL" -f db/migrations/004_seed_crm_defaults.sql
```
