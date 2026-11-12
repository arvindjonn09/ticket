CREATE TABLE automation_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  enabled boolean NOT NULL DEFAULT false,
  working_weekdays integer[] NOT NULL DEFAULT ARRAY[1,2,3,4,5],
  holidays text[] NOT NULL DEFAULT ARRAY[]::text[],
  reminder_days integer NOT NULL DEFAULT 2 CHECK(reminder_days BETWEEN 1 AND 365),
  escalation_days integer NOT NULL DEFAULT 5 CHECK(escalation_days BETWEEN reminder_days AND 365),
  auto_close_days integer NOT NULL DEFAULT 5 CHECK(auto_close_days BETWEEN 1 AND 365),
  responsible_admin_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  FOREIGN KEY(tenant_id,responsible_admin_id) REFERENCES users(tenant_id,id),
  CHECK(cardinality(working_weekdays) BETWEEN 1 AND 7 AND working_weekdays <@ ARRAY[0,1,2,3,4,5,6]),
  CHECK(cardinality(holidays)<=366)
);
CREATE TABLE automation_actions (
  tenant_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  approval_version integer NOT NULL,
  stage text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('approval_reminder','approval_escalation','auto_completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,ticket_id,approval_version,stage,kind),
  FOREIGN KEY(tenant_id,ticket_id) REFERENCES tickets(tenant_id,id)
);
ALTER TABLE automation_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_settings USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY tenant_isolation ON automation_actions USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT,INSERT,UPDATE ON automation_settings TO astrama_app;
GRANT SELECT,INSERT ON automation_actions TO astrama_app;
GRANT SELECT ON automation_settings TO astrama_auth_reader;
CREATE POLICY automation_dispatch_lookup ON automation_settings FOR SELECT TO astrama_auth_reader USING(true);
-- This function exposes only enabled, active tenant identifiers. The worker
-- establishes tenant context and rechecks live configuration before any action.
CREATE FUNCTION pending_automation_tenants() RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT s.tenant_id FROM public.automation_settings s JOIN public.tenants t ON t.id=s.tenant_id WHERE s.enabled AND t.active
$$;
ALTER FUNCTION pending_automation_tenants() OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION pending_automation_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pending_automation_tenants() TO astrama_app;
