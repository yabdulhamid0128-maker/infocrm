# CRM Backend API Docs

Base URL: `http://localhost:3000`

All responses are JSON.

## Health

### `GET /api/health`
Checks server + DB connection.

Response:
```json
{
  "ok": true,
  "db_time": "2026-03-02T14:00:00.000Z"
}
```

---

## Operators

### `GET /api/operators`
Returns users with role `operator`.

Response:
```json
[
  { "id": 1, "name": "Oybek", "email": "oybek@example.local", "status": "active" }
]
```

### `POST /api/operators`
Creates (or upserts by email) an operator and assigns operator role.

Body:
```json
{
  "name": "Abdulhamid",
  "email": "abdulhamid@example.com"
}
```

Response `201`:
```json
{
  "id": 5,
  "name": "Abdulhamid",
  "email": "abdulhamid@example.com",
  "status": "active"
}
```

---

## Leads

### `GET /api/leads`
List leads with optional filters.

Query params:
- `limit` (default `100`, max `500`)
- `offset` (default `0`)
- `search` (name/phone/telegram)
- `stage`
- `operator_id`

Example:
`GET /api/leads?search=abdul&stage=New&limit=50`

### `POST /api/leads`
Create lead.

Body (minimum):
```json
{
  "name": "New Lead"
}
```

Full body:
```json
{
  "name": "New Lead",
  "phone": "+998901112233",
  "telegram": "@leaduser",
  "social": "@insta",
  "source": "Telegram",
  "campaign": "Bot",
  "stage": "New",
  "score": 3,
  "potential_revenue": 2000,
  "revenue": 0,
  "revenue_status": "none",
  "call_booked": false,
  "follow_up_at": null,
  "notes": "first contact",
  "operator_id": 1
}
```

### `PATCH /api/leads/:id`
Partial update lead.

Allowed fields:
- `name`, `phone`, `telegram`, `social`, `source`, `campaign`
- `stage`, `score`
- `potential_revenue`, `revenue`, `revenue_status`
- `call_booked`, `follow_up_at`, `notes`, `operator_id`

Example body:
```json
{
  "stage": "Decision",
  "score": 4,
  "operator_id": 2
}
```

### `DELETE /api/leads/:id`
Delete lead.

### `POST /api/leads/import`
Bulk-import legacy leads array (skips existing by same name, case-insensitive).

Body:
```json
{
  "leads": [
    { "name": "Lead 1", "stage": "New", "score": 3 }
  ]
}
```

---

## Tasks

### `GET /api/tasks`
List tasks.

Query params:
- `status` (`open`, `done`, `archived`)

### `POST /api/tasks`
Create task.

Body:
```json
{
  "lead_id": 10,
  "title": "Follow up tomorrow",
  "notes": "ask payment timeline",
  "due_at": "2026-03-03T10:00:00Z",
  "priority": "high",
  "status": "open",
  "assignee_id": 1,
  "created_by": 1
}
```

### `PATCH /api/tasks/:id`
Partial update task.

Allowed fields:
- `lead_id`, `title`, `notes`, `due_at`
- `priority`, `status`
- `assignee_id`, `completed_at`

### `DELETE /api/tasks/:id`
Delete task.

---

## Pipeline Stages (Kanban customization)

### `GET /api/pipeline/stages`
Returns saved stage order + colors.

### `PUT /api/pipeline/stages`
Replaces stage config (order/colors/names) and saves it.

Body:
```json
{
  "stages": [
    { "code": "new", "name": "New", "color": "#5a5a54", "background": "#f1f1ef", "sort_order": 1 },
    { "code": "decision", "name": "Decision", "color": "#0066cc", "background": "#eff4ff", "sort_order": 2 }
  ]
}
```

---

## Error format

Example:
```json
{
  "error": "name is required"
}
```

---

## cURL quick tests

```bash
curl http://localhost:3000/api/health

curl http://localhost:3000/api/operators

curl -X POST http://localhost:3000/api/operators \
  -H "Content-Type: application/json" \
  -d '{"name":"Abdulhamid","email":"abdulhamid@example.com"}'

curl http://localhost:3000/api/leads?limit=10

curl -X POST http://localhost:3000/api/leads \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Lead","source":"Telegram","stage":"New"}'

curl -X PATCH http://localhost:3000/api/leads/1 \
  -H "Content-Type: application/json" \
  -d '{"stage":"Decision","score":4}'

curl http://localhost:3000/api/tasks

curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Call lead","lead_id":1,"priority":"medium","status":"open"}'
```
