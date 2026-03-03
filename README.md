## Node.js CRM Backend

### 1) Install
```bash
cd backend
npm install
```

### 2) Configure env
```bash
cp .env.example .env
# edit DATABASE_URL
```

### 3) Run
```bash
npm run dev
```

Server starts at `http://localhost:3000` and will:
- run SQL migrations from `../db/migrations`
- serve CRM UI at `/`
- expose API at `/api/*`

## API docs
- Human docs: `backend/API.md`
- OpenAPI spec: `backend/openapi.yaml`

### Key API endpoints
- `GET /api/health`
- `GET /api/operators`
- `POST /api/operators`
- `GET /api/leads`
- `POST /api/leads`
- `PATCH /api/leads/:id`
- `GET /api/tasks`
- `POST /api/tasks`
- `PATCH /api/tasks/:id`
