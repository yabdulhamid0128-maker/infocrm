import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import dotenv from "dotenv";
import { pool, query, runMigrations } from "./db.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const CRM_HTML = path.join(ROOT_DIR, "pipeline (2).html");
const UPLOADS_DIR = path.join(ROOT_DIR, "uploads");

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: false }));

const SESSION_COOKIE = "crm_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const sessions = new Map();

function nowMs() {
  return Date.now();
}

function hashPassword(password = "") {
  return crypto.createHash("sha256").update(String(password)).digest("hex");
}

function verifyPassword(raw, hash) {
  if (!raw || !hash) return false;
  return hashPassword(raw) === String(hash);
}

function parseCookie(req, key) {
  const src = String(req.headers?.cookie || "");
  if (!src) return "";
  for (const part of src.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === key) return decodeURIComponent(rest.join("=") || "");
  }
  return "";
}

function setSessionCookie(res, token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const secure = process.env.NODE_ENV === "production";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`
  );
}

function createSession(user) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { user, expiresAt: nowMs() + SESSION_TTL_MS });
  return token;
}

function getSession(req) {
  const token = parseCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const hit = sessions.get(token);
  if (!hit) return null;
  if (hit.expiresAt < nowMs()) {
    sessions.delete(token);
    return null;
  }
  hit.expiresAt = nowMs() + SESSION_TTL_MS;
  return { token, ...hit };
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "unauthorized" });
  req.auth = session.user;
  req.authToken = session.token;
  next();
}

function requireAdmin(req, res, next) {
  const roles = Array.isArray(req.auth?.roles) ? req.auth.roles : [];
  if (roles.includes("admin") || roles.includes("owner")) return next();
  return res.status(403).json({ error: "forbidden" });
}

async function ensureAdminUser() {
  const email = String(process.env.ADMIN_EMAIL || "admin@crm.local").trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || "admin12345");
  const name = String(process.env.ADMIN_NAME || "CRM Admin").trim() || "CRM Admin";
  const passwordHash = hashPassword(password);

  const upserted = await query(
    `INSERT INTO users (name, email, password_hash, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (email)
     DO UPDATE SET
       name = EXCLUDED.name,
       password_hash = COALESCE(users.password_hash, EXCLUDED.password_hash),
       status = 'active'
     RETURNING id, name, email, status`,
    [name, email, passwordHash]
  );
  const userId = upserted.rows[0].id;
  await query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, r.id FROM roles r WHERE r.code = 'admin'
     ON CONFLICT (user_id, role_id) DO NOTHING`,
    [userId]
  );
}

function loginHtml(errorText = "") {
  const err = errorText
    ? `<div style="margin-top:10px;padding:10px 12px;border-radius:10px;background:#fff1f0;border:1px solid #ffd2cd;color:#b42318;font-size:12.5px">${errorText}</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>CRM Login</title>
  <style>
    body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;background:linear-gradient(160deg,#f5f8ff,#f9fafc);color:#111827}
    .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{width:100%;max-width:420px;background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 18px 50px rgba(16,24,40,.08);padding:24px}
    h1{margin:0 0 6px;font-size:24px}
    p{margin:0;color:#6b7280;font-size:13px}
    label{display:block;margin-top:14px;margin-bottom:6px;font-size:12px;font-weight:600;color:#374151}
    input{width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:10px;padding:11px 12px;font-size:14px;outline:none}
    input:focus{border-color:#1d4ed8;box-shadow:0 0 0 3px rgba(29,78,216,.15)}
    button{margin-top:16px;width:100%;border:none;border-radius:10px;padding:11px 14px;background:#111827;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
    .hint{margin-top:12px;font-size:12px;color:#6b7280}
  </style>
</head>
<body>
  <div class="wrap">
    <form class="card" method="post" action="/api/auth/login">
      <h1>Sign in</h1>
      <p>Login to access your CRM workspace.</p>
      <label>Email</label>
      <input type="email" name="email" placeholder="you@example.com" required />
      <label>Password</label>
      <input type="password" name="password" placeholder="••••••••" required />
      ${err}
      <button type="submit">Login</button>
      <div class="hint">Use your assigned credentials to continue.</div>
    </form>
  </div>
</body>
</html>`;
}

function safeFileName(name = "") {
  const base = path.basename(String(name || "").trim()) || "file";
  return base.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180) || "file";
}

function extFromName(name = "") {
  const ext = path.extname(String(name || "")).toLowerCase();
  if (!ext || ext.length > 12) return "";
  return ext;
}

async function getDefaultOrgId() {
  const found = await query(
    `SELECT id FROM organizations WHERE slug = 'monetizator-pro' LIMIT 1`
  );
  if (found.rowCount) return found.rows[0].id;
  const created = await query(
    `INSERT INTO organizations (name, slug) VALUES ('Monetizator Pro', 'monetizator-pro') RETURNING id`
  );
  return created.rows[0].id;
}

async function getDefaultProjectAndPipeline(orgId) {
  const found = await query(
    `SELECT id, project_id
     FROM pipelines
     WHERE organization_id = $1
     ORDER BY id ASC
     LIMIT 1`,
    [orgId]
  );
  if (found.rowCount) {
    return { projectId: found.rows[0].project_id, pipelineId: found.rows[0].id };
  }

  const project = await query(
    `INSERT INTO projects (organization_id, name)
     VALUES ($1, 'Default Project')
     ON CONFLICT (organization_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [orgId]
  );

  const pipeline = await query(
    `INSERT INTO pipelines (organization_id, project_id, name, config_json)
     VALUES ($1, $2, 'Main Pipeline', $3::jsonb)
     RETURNING id`,
    [
      orgId,
      project.rows[0].id,
      JSON.stringify({
        stages: ["Pre-payment", "Rejected", "Payment waiting", "New", "Decision", "Strategy Call"],
        stageCfg: {
          "Pre-payment": { color: "#0f7b5f", bg: "#edfaf3" },
          Rejected: { color: "#9a9a92", bg: "#f1f1ef" },
          "Payment waiting": { color: "#a05c00", bg: "#fff7eb" },
          New: { color: "#5a5a54", bg: "#f1f1ef" },
          Decision: { color: "#0066cc", bg: "#eff4ff" },
          "Strategy Call": { color: "#6e40c9", bg: "#f3f0ff" }
        },
        analytics: {
          closedStages: ["Pre-payment"],
          rejectedStages: ["Rejected"]
        }
      })
    ]
  );
  return { projectId: project.rows[0].id, pipelineId: pipeline.rows[0].id };
}

function toDbFormStatus(status) {
  if (status === "Active" || status === "active") return "active";
  if (status === "Archived" || status === "archived") return "archived";
  return "draft";
}

function toUiFormStatus(status) {
  return status === "active" ? "Active" : "Paused";
}

function fieldKeyFromLabel(label = "") {
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "field";
}

function uniqueFieldKey(base, used) {
  let key = base;
  let i = 2;
  while (used.has(key)) {
    key = `${base}_${i}`;
    i += 1;
  }
  used.add(key);
  return key;
}

app.get("/api/health", async (_req, res) => {
  const db = await query("SELECT NOW() AS now");
  res.json({ ok: true, db_time: db.rows[0].now });
});

app.get("/api/auth/me", async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ ok: false });
  res.json({ ok: true, user: session.user });
});

app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || !password) {
    if (String(req.headers.accept || "").includes("text/html")) {
      return res.status(400).send(loginHtml("Email and password are required."));
    }
    return res.status(400).json({ error: "email and password are required" });
  }

  const userRow = await query(
    `SELECT
      u.id, u.name, u.email, u.password_hash, u.status,
      ARRAY_REMOVE(ARRAY_AGG(r.code), NULL) AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE lower(u.email) = $1
     GROUP BY u.id
     LIMIT 1`,
    [email]
  );
  if (!userRow.rowCount) {
    if (String(req.headers.accept || "").includes("text/html")) {
      return res.status(401).send(loginHtml("Invalid credentials."));
    }
    return res.status(401).json({ error: "invalid credentials" });
  }
  const user = userRow.rows[0];
  if (user.status !== "active" || !verifyPassword(password, user.password_hash)) {
    if (String(req.headers.accept || "").includes("text/html")) {
      return res.status(401).send(loginHtml("Invalid credentials."));
    }
    return res.status(401).json({ error: "invalid credentials" });
  }

  const safeUser = {
    id: Number(user.id),
    name: user.name,
    email: user.email,
    roles: Array.isArray(user.roles) ? user.roles : []
  };
  const token = createSession(safeUser);
  setSessionCookie(res, token);

  if (String(req.headers.accept || "").includes("text/html")) {
    return res.redirect("/");
  }
  res.json({ ok: true, user: safeUser });
});

app.post("/api/auth/logout", (req, res) => {
  const token = parseCookie(req, SESSION_COOKIE);
  if (token) sessions.delete(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.use("/api", (req, res, next) => {
  if (req.path === "/health") return next();
  if (req.path.startsWith("/auth/")) return next();
  if (/^\/forms\/\d+\/submit$/.test(req.path)) return next();
  return requireAuth(req, res, next);
});

app.get("/api/operators", async (_req, res) => {
  const r = await query(
    `SELECT u.id, u.name, u.email, u.status, (u.password_hash IS NOT NULL) AS has_password
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE r.code = 'operator'
     ORDER BY u.id`
  );
  res.json(r.rows);
});

app.get("/api/projects", async (_req, res) => {
  const orgId = await getDefaultOrgId();
  await getDefaultProjectAndPipeline(orgId);
  const rows = await query(
    `SELECT id, name, created_at, updated_at
     FROM projects
     WHERE organization_id = $1
     ORDER BY id ASC`,
    [orgId]
  );
  res.json(rows.rows);
});

app.post("/api/projects", async (req, res) => {
  const orgId = await getDefaultOrgId();
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  const created = await query(
    `INSERT INTO projects (organization_id, name)
     VALUES ($1, $2)
     RETURNING id, name, created_at, updated_at`,
    [orgId, name]
  );
  res.status(201).json(created.rows[0]);
});

app.patch("/api/projects/:id", async (req, res) => {
  const orgId = await getDefaultOrgId();
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "invalid id" });
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  const updated = await query(
    `UPDATE projects
     SET name = $1, updated_at = NOW()
     WHERE id = $2 AND organization_id = $3
     RETURNING id, name, created_at, updated_at`,
    [name, id, orgId]
  );
  if (!updated.rowCount) return res.status(404).json({ error: "project not found" });
  res.json(updated.rows[0]);
});

app.get("/api/pipelines", async (req, res) => {
  const orgId = await getDefaultOrgId();
  await getDefaultProjectAndPipeline(orgId);
  const projectId = (req.query.project_id || "").toString().trim();
  const params = [orgId];
  let where = `organization_id = $1`;
  if (projectId) {
    params.push(projectId);
    where += ` AND project_id = $2`;
  }
  const rows = await query(
    `SELECT id, project_id, name, config_json, created_at, updated_at
     FROM pipelines
     WHERE ${where}
     ORDER BY id ASC`,
    params
  );
  res.json(rows.rows);
});

app.post("/api/pipelines", async (req, res) => {
  const orgId = await getDefaultOrgId();
  const name = String(req.body?.name || "").trim();
  const projectId = Number(req.body?.project_id || 0);
  const configJson = req.body?.config_json || {};
  if (!name) return res.status(400).json({ error: "name is required" });
  if (!projectId) return res.status(400).json({ error: "project_id is required" });
  const created = await query(
    `INSERT INTO pipelines (organization_id, project_id, name, config_json)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id, project_id, name, config_json, created_at, updated_at`,
    [orgId, projectId, name, JSON.stringify(configJson)]
  );
  res.status(201).json(created.rows[0]);
});

app.patch("/api/pipelines/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "invalid id" });
  const allowed = ["name", "config_json", "project_id"];
  const keys = Object.keys(req.body || {}).filter((k) => allowed.includes(k));
  if (!keys.length) return res.status(400).json({ error: "no updatable fields" });
  const params = [];
  const sets = keys.map((k) => {
    if (k === "config_json") {
      params.push(JSON.stringify(req.body[k] || {}));
      return `config_json = $${params.length}::jsonb`;
    }
    params.push(req.body[k]);
    return `${k} = $${params.length}`;
  });
  params.push(id);
  const updated = await query(
    `UPDATE pipelines
     SET ${sets.join(", ")}, updated_at = NOW()
     WHERE id = $${params.length}
     RETURNING id, project_id, name, config_json, created_at, updated_at`,
    params
  );
  if (!updated.rowCount) return res.status(404).json({ error: "pipeline not found" });
  res.json(updated.rows[0]);
});

app.delete("/api/pipelines/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "invalid id" });
  const cnt = await query(`SELECT COUNT(*)::int AS n FROM leads WHERE pipeline_id = $1`, [id]);
  if ((cnt.rows[0]?.n || 0) > 0) {
    return res.status(400).json({ error: "pipeline has leads; move leads first" });
  }
  const deleted = await query(`DELETE FROM pipelines WHERE id = $1 RETURNING id`, [id]);
  if (!deleted.rowCount) return res.status(404).json({ error: "pipeline not found" });
  res.json({ ok: true, id });
});

app.get("/api/pipeline/stages", async (_req, res) => {
  const orgId = await getDefaultOrgId();
  const r = await query(
    `SELECT id, code, name, color, background, sort_order
     FROM pipeline_stages
     WHERE organization_id = $1 AND is_active = true
     ORDER BY sort_order ASC, id ASC`,
    [orgId]
  );
  res.json(r.rows);
});

app.put("/api/pipeline/stages", async (req, res) => {
  const stages = Array.isArray(req.body?.stages) ? req.body.stages : [];
  if (!stages.length) return res.status(400).json({ error: "stages is required" });
  const orgId = await getDefaultOrgId();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE pipeline_stages
       SET is_active = false, updated_at = NOW()
       WHERE organization_id = $1`,
      [orgId]
    );
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      const name = String(s.name || "").trim();
      if (!name) continue;
      const code = String(s.code || name.toLowerCase().replace(/[^a-z0-9]+/g, "_")).slice(0, 64);
      const color = s.color || "#5a5a54";
      const bg = s.background || s.bg || "#f1f1ef";
      await client.query(
        `INSERT INTO pipeline_stages (organization_id, code, name, color, background, sort_order, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,true)
         ON CONFLICT (organization_id, code)
         DO UPDATE SET
           name = EXCLUDED.name,
           color = EXCLUDED.color,
           background = EXCLUDED.background,
           sort_order = EXCLUDED.sort_order,
           is_active = true,
           updated_at = NOW()`,
        [orgId, code, name, color, bg, i + 1]
      );
    }
    await client.query("COMMIT");
    const rows = await query(
      `SELECT id, code, name, color, background, sort_order
       FROM pipeline_stages
       WHERE organization_id = $1 AND is_active = true
       ORDER BY sort_order ASC, id ASC`,
      [orgId]
    );
    res.json(rows.rows);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

app.post("/api/operators", requireAdmin, async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required" });
  if (password && String(password).length < 6) {
    return res.status(400).json({ error: "password must be at least 6 characters" });
  }
  const passHash = password ? hashPassword(password) : null;

  const inserted = await query(
    `INSERT INTO users (name, email, password_hash, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (email) DO UPDATE
       SET name = EXCLUDED.name,
           password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash)
     RETURNING id, name, email, status, (password_hash IS NOT NULL) AS has_password`,
    [name.trim(), email || null, passHash]
  );

  await query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, r.id FROM roles r WHERE r.code = 'operator'
     ON CONFLICT (user_id, role_id) DO NOTHING`,
    [inserted.rows[0].id]
  );

  res.status(201).json(inserted.rows[0]);
});

app.post("/api/operators/:id/password", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "invalid id" });
  const password = String(req.body?.password || "");
  if (password.length < 6) return res.status(400).json({ error: "password must be at least 6 characters" });
  const passHash = hashPassword(password);
  const updated = await query(
    `UPDATE users
     SET password_hash = $1, status = 'active', updated_at = NOW()
     WHERE id = $2
     RETURNING id, name, email, status, (password_hash IS NOT NULL) AS has_password`,
    [passHash, id]
  );
  if (!updated.rowCount) return res.status(404).json({ error: "operator not found" });
  res.json(updated.rows[0]);
});

app.delete("/api/operators/:id", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "invalid id" });

  const isOperator = await query(
    `SELECT u.id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.id = $1 AND r.code = 'operator'
     LIMIT 1`,
    [id]
  );
  if (!isOperator.rowCount) return res.status(404).json({ error: "operator not found" });

  await query(`DELETE FROM users WHERE id = $1`, [id]);
  res.json({ ok: true, id });
});

app.get("/api/leads", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);
  const offset = parseInt(req.query.offset || "0", 10);
  const search = (req.query.search || "").toString().trim();
  const stage = (req.query.stage || "").toString().trim();
  const operatorId = (req.query.operator_id || "").toString().trim();
  const projectId = (req.query.project_id || "").toString().trim();
  const pipelineId = (req.query.pipeline_id || "").toString().trim();

  const where = [];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    where.push(`(l.name ILIKE $${params.length} OR l.phone ILIKE $${params.length} OR l.telegram ILIKE $${params.length})`);
  }
  if (stage) {
    params.push(stage);
    where.push(`l.stage = $${params.length}`);
  }
  if (operatorId) {
    params.push(operatorId);
    where.push(`l.operator_id = $${params.length}`);
  }
  if (projectId) {
    params.push(projectId);
    where.push(`l.project_id = $${params.length}`);
  }
  if (pipelineId) {
    params.push(pipelineId);
    where.push(`l.pipeline_id = $${params.length}`);
  }

  params.push(limit);
  params.push(offset);
  const sql = `
    SELECT
      l.id, l.lead_code, l.name, l.phone, l.telegram, l.social, l.source, l.campaign,
      l.utm_medium, l.utm_campaign, l.utm_content,
      l.stage, l.score, l.potential_revenue, l.revenue, l.revenue_status, l.call_booked,
      l.follow_up_at, l.notes, l.operator_id, l.project_id, l.pipeline_id, u.name AS operator_name,
      l.created_at, l.updated_at
    FROM leads l
    LEFT JOIN users u ON u.id = l.operator_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY l.id DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;
  const r = await query(sql, params);
  res.json(r.rows);
});

app.post("/api/leads", async (req, res) => {
  const {
    name,
    phone,
    telegram,
    social,
    source,
    campaign,
    utm_medium = null,
    utm_campaign = null,
    utm_content = null,
    stage = "New",
    score = 3,
    potential_revenue = 2000,
    revenue = 0,
    revenue_status = "none",
    call_booked = false,
    follow_up_at = null,
    notes = "",
    operator_id = null,
    project_id = null,
    pipeline_id = null
  } = req.body || {};

  if (!name) return res.status(400).json({ error: "name is required" });

  const orgId = await getDefaultOrgId();
  const defaults = await getDefaultProjectAndPipeline(orgId);
  const finalProjectId = project_id || defaults.projectId;
  const finalPipelineId = pipeline_id || defaults.pipelineId;

  const inserted = await query(
    `INSERT INTO leads (
      organization_id, project_id, pipeline_id, lead_code, name, phone, telegram, social, source, campaign,
      utm_medium, utm_campaign, utm_content, stage, score,
      potential_revenue, revenue, revenue_status, call_booked, follow_up_at, notes, operator_id
    ) VALUES (
      $1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
      $15, $16, $17, $18, $19, $20, $21
    )
    RETURNING *`,
    [
      orgId,
      finalProjectId,
      finalPipelineId,
      name.trim(),
      phone || null,
      telegram || null,
      social || null,
      source || null,
      campaign || null,
      utm_medium || null,
      utm_campaign || null,
      utm_content || null,
      stage,
      score,
      potential_revenue,
      revenue,
      revenue_status,
      call_booked,
      follow_up_at,
      notes,
      operator_id
    ]
  );

  await query(
    "UPDATE leads SET lead_code = CONCAT('L-', LPAD(id::text, 4, '0')) WHERE id = $1 AND lead_code IS NULL",
    [inserted.rows[0].id]
  );

  const finalLead = await query("SELECT * FROM leads WHERE id = $1", [inserted.rows[0].id]);
  res.status(201).json(finalLead.rows[0]);
});

app.post("/api/leads/import", async (req, res) => {
  const list = Array.isArray(req.body?.leads) ? req.body.leads : [];
  if (!list.length) return res.status(400).json({ error: "leads is required" });

  const orgId = await getDefaultOrgId();
  const defaults = await getDefaultProjectAndPipeline(orgId);
  const imported = [];
  for (const item of list) {
    const name = String(item?.name || "").trim();
    if (!name) continue;
    const existing = await query(
      `SELECT id FROM leads WHERE lower(name) = lower($1) LIMIT 1`,
      [name]
    );
    if (existing.rowCount) continue;
    const inserted = await query(
      `INSERT INTO leads (
        organization_id, project_id, pipeline_id, lead_code, name, phone, telegram, social, source, campaign,
        utm_medium, utm_campaign, utm_content, stage, score,
        potential_revenue, revenue, revenue_status, call_booked, follow_up_at, notes
      ) VALUES (
        $1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
      ) RETURNING *`,
      [
        orgId,
        Number(item.project_id || defaults.projectId),
        Number(item.pipeline_id || defaults.pipelineId),
        name,
        item.phone || null,
        item.telegram || null,
        item.social || null,
        item.source || null,
        item.campaign || null,
        item.utmMedium || item.utm_medium || null,
        item.utmCampaign || item.utm_campaign || null,
        item.utmContent || item.utm_content || null,
        item.stage || "New",
        Number(item.score || 3),
        Number(item.potentialRevenue || item.potential_revenue || 2000),
        Number(item.revenue || 0),
        (item.revenueStatus === "Paid" ? "paid" : item.revenueStatus === "Partial" ? "partial" : "none"),
        !!item.callBooked,
        item.followUp && item.followUp !== "—" ? new Date(item.followUp).toISOString() : null,
        item.notes || ""
      ]
    );
    await query(
      "UPDATE leads SET lead_code = CONCAT('L-', LPAD(id::text, 4, '0')) WHERE id = $1 AND lead_code IS NULL",
      [inserted.rows[0].id]
    );
    imported.push(inserted.rows[0]);
  }
  res.json({ ok: true, imported: imported.length });
});

app.patch("/api/leads/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "invalid id" });

  const allowed = [
    "name", "phone", "telegram", "social", "source", "campaign", "stage", "score",
    "utm_medium", "utm_campaign", "utm_content",
    "potential_revenue", "revenue", "revenue_status", "call_booked", "follow_up_at",
    "notes", "operator_id", "project_id", "pipeline_id", "created_at"
  ];
  const keys = Object.keys(req.body || {}).filter((k) => allowed.includes(k));
  if (!keys.length) return res.status(400).json({ error: "no updatable fields" });

  const params = [];
  const sets = keys.map((k) => {
    params.push(req.body[k]);
    return `${k} = $${params.length}`;
  });
  params.push(id);

  const updated = await query(
    `UPDATE leads SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!updated.rowCount) return res.status(404).json({ error: "lead not found" });
  res.json(updated.rows[0]);
});
app.delete("/api/leads/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "invalid id" });
  const deleted = await query("DELETE FROM leads WHERE id = $1 RETURNING id", [id]);
  if (!deleted.rowCount) return res.status(404).json({ error: "lead not found" });
  res.json({ ok: true, id });
});

app.get("/api/leads/:id/attachments", async (req, res) => {
  const leadId = parseInt(req.params.id, 10);
  if (!leadId) return res.status(400).json({ error: "invalid lead id" });
  const leadExists = await query(
    `SELECT id, organization_id FROM leads WHERE id = $1 LIMIT 1`,
    [leadId]
  );
  if (!leadExists.rowCount) return res.status(404).json({ error: "lead not found" });
  const orgId = leadExists.rows[0].organization_id || (await getDefaultOrgId());
  const rows = await query(
    `SELECT id, lead_id, file_name, mime_type, size_bytes, storage_key, created_at
     FROM attachments
     WHERE organization_id = $1 AND lead_id = $2
     ORDER BY id DESC`,
    [orgId, leadId]
  );
  res.json(rows.rows);
});

app.post("/api/leads/:id/attachments", async (req, res) => {
  const leadId = parseInt(req.params.id, 10);
  if (!leadId) return res.status(400).json({ error: "invalid lead id" });
  const leadExists = await query(
    `SELECT id, organization_id FROM leads WHERE id = $1 LIMIT 1`,
    [leadId]
  );
  if (!leadExists.rowCount) return res.status(404).json({ error: "lead not found" });
  const orgId = leadExists.rows[0].organization_id || (await getDefaultOrgId());

  const fileName = safeFileName(req.body?.file_name || "");
  const mimeType = String(req.body?.mime_type || "application/octet-stream").slice(0, 160);
  const b64 = String(req.body?.content_base64 || "").trim();
  if (!fileName || !b64) return res.status(400).json({ error: "file_name and content_base64 are required" });

  let buffer;
  try {
    buffer = Buffer.from(b64, "base64");
  } catch (_e) {
    return res.status(400).json({ error: "invalid base64 payload" });
  }
  if (!buffer || !buffer.length) return res.status(400).json({ error: "empty file payload" });
  if (buffer.length > 8 * 1024 * 1024) {
    return res.status(400).json({ error: "max file size is 8MB" });
  }

  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const ext = extFromName(fileName);
  const storageKey = path.join("leads", String(leadId), `${token}${ext}`);
  const absPath = path.join(UPLOADS_DIR, storageKey);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, buffer);

  const inserted = await query(
    `INSERT INTO attachments (
      organization_id, lead_id, uploaded_by, file_name, mime_type, size_bytes, storage_key
    ) VALUES ($1,$2,NULL,$3,$4,$5,$6)
    RETURNING id, lead_id, file_name, mime_type, size_bytes, storage_key, created_at`,
    [orgId, leadId, fileName, mimeType, buffer.length, storageKey]
  );
  res.status(201).json(inserted.rows[0]);
});

app.get("/api/attachments/:id/download", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "invalid id" });
  const orgId = await getDefaultOrgId();
  const row = await query(
    `SELECT id, file_name, mime_type, storage_key
     FROM attachments
     WHERE id = $1 AND organization_id = $2
     LIMIT 1`,
    [id, orgId]
  );
  if (!row.rowCount) return res.status(404).json({ error: "attachment not found" });
  const it = row.rows[0];
  const absPath = path.join(UPLOADS_DIR, it.storage_key);
  try {
    await fs.access(absPath);
  } catch (_e) {
    return res.status(404).json({ error: "file not found on disk" });
  }
  if (it.mime_type) res.setHeader("Content-Type", it.mime_type);
  res.download(absPath, it.file_name);
});

app.delete("/api/attachments/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "invalid id" });
  const orgId = await getDefaultOrgId();
  const row = await query(
    `DELETE FROM attachments
     WHERE id = $1 AND organization_id = $2
     RETURNING id, storage_key`,
    [id, orgId]
  );
  if (!row.rowCount) return res.status(404).json({ error: "attachment not found" });
  const absPath = path.join(UPLOADS_DIR, row.rows[0].storage_key);
  try {
    await fs.unlink(absPath);
  } catch (_e) {
    // ignore missing file
  }
  res.json({ ok: true, id });
});

app.get("/api/tasks", async (req, res) => {
  const status = (req.query.status || "").toString().trim();
  const where = [];
  const params = [];
  if (status) {
    params.push(status);
    where.push(`t.status = $${params.length}`);
  }
  const r = await query(
    `SELECT
      t.id, t.lead_id, l.name AS lead_name, t.title, t.notes, t.due_at, t.priority,
      t.status, t.assignee_id, u.name AS assignee_name, t.created_at, t.updated_at
     FROM tasks t
     LEFT JOIN leads l ON l.id = t.lead_id
     LEFT JOIN users u ON u.id = t.assignee_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY t.id DESC`,
    params
  );
  res.json(r.rows);
});

app.post("/api/tasks", async (req, res) => {
  const {
    lead_id = null,
    title,
    notes = "",
    due_at = null,
    priority = "medium",
    status = "open",
    assignee_id = null,
    created_by = null
  } = req.body || {};
  if (!title) return res.status(400).json({ error: "title is required" });

  const inserted = await query(
    `INSERT INTO tasks (lead_id, title, notes, due_at, priority, status, assignee_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [lead_id, title, notes, due_at, priority, status, assignee_id, created_by]
  );
  res.status(201).json(inserted.rows[0]);
});

app.patch("/api/tasks/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "invalid id" });
  const allowed = ["lead_id", "title", "notes", "due_at", "priority", "status", "assignee_id", "completed_at"];
  const keys = Object.keys(req.body || {}).filter((k) => allowed.includes(k));
  if (!keys.length) return res.status(400).json({ error: "no updatable fields" });
  const params = [];
  const sets = keys.map((k) => {
    params.push(req.body[k]);
    return `${k} = $${params.length}`;
  });
  params.push(id);
  const updated = await query(
    `UPDATE tasks SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!updated.rowCount) return res.status(404).json({ error: "task not found" });
  res.json(updated.rows[0]);
});
app.delete("/api/tasks/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "invalid id" });
  const deleted = await query("DELETE FROM tasks WHERE id = $1 RETURNING id", [id]);
  if (!deleted.rowCount) return res.status(404).json({ error: "task not found" });
  res.json({ ok: true, id });
});

app.get("/api/forms", async (_req, res) => {
  const orgId = await getDefaultOrgId();
  const formsRows = await query(
    `SELECT
      f.id,
      f.name,
      f.description,
      f.source,
      f.status,
      ps.name AS stage_name,
      u.name AS operator_name,
      COALESCE(fs.submissions, 0) AS submissions,
      fs.last_submission
     FROM lead_forms f
     LEFT JOIN pipeline_stages ps ON ps.id = f.default_stage_id
     LEFT JOIN users u ON u.id = f.default_operator_id
     LEFT JOIN (
       SELECT form_id, COUNT(*)::int AS submissions, MAX(created_at) AS last_submission
       FROM form_submissions
       GROUP BY form_id
     ) fs ON fs.form_id = f.id
     WHERE f.organization_id = $1
     ORDER BY f.id DESC`,
    [orgId]
  );

  const ids = formsRows.rows.map((r) => r.id);
  let fieldsByForm = new Map();
  if (ids.length) {
    const fieldsRows = await query(
      `SELECT form_id, field_key, label, field_type, required, sort_order
       FROM form_fields
       WHERE form_id = ANY($1::bigint[])
       ORDER BY form_id ASC, sort_order ASC, id ASC`,
      [ids]
    );
    fieldsByForm = fieldsRows.rows.reduce((acc, row) => {
      const list = acc.get(row.form_id) || [];
      list.push(row);
      acc.set(row.form_id, list);
      return acc;
    }, new Map());
  }

  const forms = formsRows.rows.map((row) => {
    const fields = fieldsByForm.get(row.id) || [];
    return {
      id: Number(row.id),
      name: row.name,
      description: row.description || "",
      source: row.source || "Other",
      stage: row.stage_name || "New",
      operator: row.operator_name || "",
      status: toUiFormStatus(row.status),
      fields: {
        phone: fields.some((f) => f.field_key === "phone"),
        telegram: fields.some((f) => f.field_key === "telegram"),
        notes: fields.some((f) => f.field_key === "notes")
      },
      customFields: fields
        .filter((f) => !["phone", "telegram", "notes"].includes(f.field_key))
        .map((f) => ({
          name: f.label,
          type: ["text", "number", "date"].includes(f.field_type) ? f.field_type : "text",
          required: !!f.required
        })),
      submissions: Number(row.submissions || 0),
      lastSubmission: row.last_submission || null
    };
  });
  res.json(forms);
});

app.post("/api/forms", async (req, res) => {
  const orgId = await getDefaultOrgId();
  const {
    name,
    description = "",
    source = "Other",
    stage = "New",
    operator = null,
    status = "Active",
    fields = {},
    customFields = []
  } = req.body || {};

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "name is required" });
  }

  const stageRow = await query(
    `SELECT id FROM pipeline_stages
     WHERE organization_id = $1 AND name = $2 AND is_active = true
     LIMIT 1`,
    [orgId, stage]
  );
  const operatorRow = operator
    ? await query(`SELECT id FROM users WHERE name = $1 LIMIT 1`, [operator])
    : { rowCount: 0, rows: [] };

  const formInserted = await query(
    `INSERT INTO lead_forms (
      organization_id, name, description, source, default_stage_id, default_operator_id, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING id`,
    [
      orgId,
      String(name).trim(),
      description || null,
      source || null,
      stageRow.rowCount ? stageRow.rows[0].id : null,
      operatorRow.rowCount ? operatorRow.rows[0].id : null,
      toDbFormStatus(status)
    ]
  );
  const formId = formInserted.rows[0].id;

  const used = new Set();
  const staticFields = [
    { enabled: !!fields.phone, key: "phone", label: "Phone", type: "phone" },
    { enabled: !!fields.telegram, key: "telegram", label: "Telegram", type: "telegram" },
    { enabled: !!fields.notes, key: "notes", label: "Notes", type: "textarea" }
  ].filter((f) => f.enabled);

  for (let i = 0; i < staticFields.length; i += 1) {
    const f = staticFields[i];
    used.add(f.key);
    await query(
      `INSERT INTO form_fields (form_id, field_key, label, field_type, required, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [formId, f.key, f.label, f.type, false, i + 1]
    );
  }

  const cleanedCustom = Array.isArray(customFields) ? customFields : [];
  for (let i = 0; i < cleanedCustom.length; i += 1) {
    const cf = cleanedCustom[i] || {};
    const label = String(cf.name || "").trim();
    if (!label) continue;
    const type = ["text", "number", "date"].includes(cf.type) ? cf.type : "text";
    const baseKey = fieldKeyFromLabel(label);
    const key = uniqueFieldKey(baseKey, used);
    await query(
      `INSERT INTO form_fields (form_id, field_key, label, field_type, required, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [formId, key, label, type, !!cf.required, staticFields.length + i + 1]
    );
  }

  const out = await query(
    `SELECT
      f.id, f.name, f.description, f.source, f.status,
      ps.name AS stage_name, u.name AS operator_name
     FROM lead_forms f
     LEFT JOIN pipeline_stages ps ON ps.id = f.default_stage_id
     LEFT JOIN users u ON u.id = f.default_operator_id
     WHERE f.id = $1`,
    [formId]
  );
  res.status(201).json({
    id: Number(out.rows[0].id),
    name: out.rows[0].name,
    description: out.rows[0].description || "",
    source: out.rows[0].source || "Other",
    stage: out.rows[0].stage_name || "New",
    operator: out.rows[0].operator_name || "",
    status: toUiFormStatus(out.rows[0].status),
    fields: {
      phone: !!fields.phone,
      telegram: !!fields.telegram,
      notes: !!fields.notes
    },
    customFields: cleanedCustom
      .filter((cf) => String(cf?.name || "").trim())
      .map((cf) => ({
        name: String(cf.name).trim(),
        type: ["text", "number", "date"].includes(cf.type) ? cf.type : "text",
        required: !!cf.required
      })),
    submissions: 0,
    lastSubmission: null
  });
});

app.patch("/api/forms/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "invalid id" });
  const status = req.body?.status;
  if (!status) return res.status(400).json({ error: "status is required" });
  const updated = await query(
    `UPDATE lead_forms
     SET status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, status`,
    [toDbFormStatus(status), id]
  );
  if (!updated.rowCount) return res.status(404).json({ error: "form not found" });
  res.json({ id, status: toUiFormStatus(updated.rows[0].status) });
});

app.delete("/api/forms/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "invalid id" });
  const deleted = await query("DELETE FROM lead_forms WHERE id = $1 RETURNING id", [id]);
  if (!deleted.rowCount) return res.status(404).json({ error: "form not found" });
  res.json({ ok: true, id });
});

app.post("/api/forms/:id/submit", async (req, res) => {
  const formId = parseInt(req.params.id, 10);
  if (!formId) return res.status(400).json({ error: "invalid form id" });
  const { name, phone = "", telegram = "", notes = "", customData = {} } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name is required" });

  const formRows = await query(
    `SELECT
      f.id, f.name, f.source, f.status, f.default_operator_id,
      ps.name AS stage_name
     FROM lead_forms f
     LEFT JOIN pipeline_stages ps ON ps.id = f.default_stage_id
     WHERE f.id = $1
     LIMIT 1`,
    [formId]
  );
  if (!formRows.rowCount) return res.status(404).json({ error: "form not found" });
  const form = formRows.rows[0];
  if (form.status !== "active") return res.status(400).json({ error: "form is not active" });

  const fieldsRows = await query(
    `SELECT field_key, label, required
     FROM form_fields
     WHERE form_id = $1
     ORDER BY sort_order ASC, id ASC`,
    [formId]
  );
  const fields = fieldsRows.rows;

  if (fields.some((f) => f.field_key === "phone" && f.required) && !String(phone).trim()) {
    return res.status(400).json({ error: "phone is required" });
  }
  if (fields.some((f) => f.field_key === "telegram" && f.required) && !String(telegram).trim()) {
    return res.status(400).json({ error: "telegram is required" });
  }

  const customByLabel = {};
  for (const [k, v] of Object.entries(customData || {})) {
    if (v === null || v === undefined || v === "") continue;
    customByLabel[String(k)] = String(v);
  }
  for (const field of fields.filter((f) => !["phone", "telegram", "notes"].includes(f.field_key) && f.required)) {
    if (!customByLabel[field.label]) {
      return res.status(400).json({ error: `${field.label} is required` });
    }
  }

  const customNotes = Object.entries(customByLabel)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" | ");
  const finalNotes =
    (notes || "") +
    (customNotes ? (notes ? "\n" : "") + customNotes : "") ||
    `Captured from form: ${form.name}`;

  const leadInserted = await query(
    `INSERT INTO leads (
      organization_id, lead_code, name, phone, telegram, social, source, campaign,
      stage, score, potential_revenue, revenue, revenue_status, call_booked,
      follow_up_at, notes, operator_id
    ) VALUES (
      $1, NULL, $2, $3, $4, NULL, $5, NULL,
      $6, 3, 2000, 0, 'none', false,
      NULL, $7, $8
    )
    RETURNING id`,
    [
      await getDefaultOrgId(),
      String(name).trim(),
      String(phone || "").trim() || null,
      String(telegram || "").trim() || null,
      form.source || null,
      form.stage_name || "New",
      finalNotes,
      form.default_operator_id || null
    ]
  );
  const leadId = leadInserted.rows[0].id;
  await query(
    "UPDATE leads SET lead_code = CONCAT('L-', LPAD(id::text, 4, '0')) WHERE id = $1 AND lead_code IS NULL",
    [leadId]
  );

  await query(
    `INSERT INTO form_submissions (form_id, lead_id, payload, ip_address, user_agent)
     VALUES ($1, $2, $3::jsonb, NULLIF($4, '')::inet, $5)`,
    [
      formId,
      leadId,
      JSON.stringify({
        name: String(name).trim(),
        phone: String(phone || "").trim(),
        telegram: String(telegram || "").trim(),
        notes: String(notes || "").trim(),
        customData: customByLabel
      }),
      req.ip || "",
      req.get("user-agent") || null
    ]
  );

  const out = await query(
    `SELECT
      l.id, l.lead_code, l.name, l.phone, l.telegram, l.social, l.source, l.campaign,
      l.stage, l.score, l.potential_revenue, l.revenue, l.revenue_status, l.call_booked,
      l.follow_up_at, l.notes, l.operator_id, u.name AS operator_name,
      l.created_at, l.updated_at
     FROM leads l
     LEFT JOIN users u ON u.id = l.operator_id
     WHERE l.id = $1`,
    [leadId]
  );
  res.status(201).json(out.rows[0]);
});

app.get("/login", (req, res) => {
  const session = getSession(req);
  if (session) return res.redirect("/");
  res.send(loginHtml());
});

app.get("/", (req, res) => {
  res.sendFile(CRM_HTML);
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not Found" });
});

const port = parseInt(process.env.PORT || "3000", 10);

async function start() {
  await runMigrations();
  await ensureAdminUser();
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`CRM server running on http://localhost:${port}`);
  });
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start server:", err);
  process.exit(1);
});
