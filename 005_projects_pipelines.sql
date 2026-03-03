BEGIN;

CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS pipelines (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, name)
);

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pipeline_id BIGINT REFERENCES pipelines(id) ON DELETE SET NULL;

DO $$
DECLARE
  org_id BIGINT;
  proj_id BIGINT;
BEGIN
  SELECT id INTO org_id FROM organizations WHERE slug = 'monetizator-pro' LIMIT 1;
  IF org_id IS NULL THEN
    INSERT INTO organizations (name, slug)
    VALUES ('Monetizator Pro', 'monetizator-pro')
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO org_id;
  END IF;

  INSERT INTO projects (organization_id, name)
  VALUES (org_id, 'Default Project')
  ON CONFLICT (organization_id, name) DO NOTHING;

  SELECT id INTO proj_id
  FROM projects
  WHERE organization_id = org_id AND name = 'Default Project'
  LIMIT 1;

  INSERT INTO pipelines (organization_id, project_id, name, config_json)
  VALUES (
    org_id,
    proj_id,
    'Main Pipeline',
    jsonb_build_object(
      'stages', jsonb_build_array('Pre-payment','Rejected','Payment waiting','New','Decision','Strategy Call'),
      'stageCfg', jsonb_build_object(
        'Pre-payment', jsonb_build_object('color','#0f7b5f','bg','#edfaf3'),
        'Rejected', jsonb_build_object('color','#9a9a92','bg','#f1f1ef'),
        'Payment waiting', jsonb_build_object('color','#a05c00','bg','#fff7eb'),
        'New', jsonb_build_object('color','#5a5a54','bg','#f1f1ef'),
        'Decision', jsonb_build_object('color','#0066cc','bg','#eff4ff'),
        'Strategy Call', jsonb_build_object('color','#6e40c9','bg','#f3f0ff')
      )
    )
  )
  ON CONFLICT (project_id, name) DO NOTHING;

  UPDATE leads l
  SET
    project_id = proj_id,
    pipeline_id = p.id
  FROM pipelines p
  WHERE p.project_id = proj_id
    AND p.name = 'Main Pipeline'
    AND (l.project_id IS NULL OR l.pipeline_id IS NULL);
END $$;

CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(organization_id);
CREATE INDEX IF NOT EXISTS idx_pipelines_project ON pipelines(project_id);
CREATE INDEX IF NOT EXISTS idx_leads_project_pipeline ON leads(project_id, pipeline_id);

COMMIT;
