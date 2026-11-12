-- Policies are opt-in: missing rows mean scanned broad formats and no retention.
CREATE TABLE tenant_data_policies (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  policy jsonb NOT NULL
);
ALTER TABLE tenant_data_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_data_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_data_policies USING (tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT,INSERT,UPDATE ON tenant_data_policies TO astrama_app;
-- Trusted owner only. No FK to tenant: outcome evidence survives tenant deletion.
CREATE TABLE data_operation_audits (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  tenant_slug text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('export','delete','retention')),
  operator_name text NOT NULL,
  reason text NOT NULL,
  evidence text NOT NULL,
  outcome text NOT NULL,
  record_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON data_operation_audits FROM PUBLIC,astrama_app;
-- Retry references are separate from the permanent content-free audit ledger.
CREATE TABLE tenant_deletion_jobs (
  tenant_id uuid PRIMARY KEY,
  tenant_slug text NOT NULL,
  object_keys jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON tenant_deletion_jobs FROM PUBLIC,astrama_app;
