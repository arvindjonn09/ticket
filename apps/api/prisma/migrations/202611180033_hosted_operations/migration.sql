CREATE TABLE tenant_budgets (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('requests','uploads','inbound','exports')),
  window_start timestamptz NOT NULL,
  used bigint NOT NULL CHECK (used >= 0),
  PRIMARY KEY(tenant_id,kind,window_start)
);
CREATE INDEX tenant_budgets_expiry ON tenant_budgets(window_start);
ALTER TABLE tenant_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_budget_scope ON tenant_budgets TO astrama_app
  USING (tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT, INSERT, UPDATE ON tenant_budgets TO astrama_app;
ALTER TABLE data_operation_audits DROP CONSTRAINT data_operation_audits_operation_check;
ALTER TABLE data_operation_audits ADD CONSTRAINT data_operation_audits_operation_check
  CHECK (operation IN ('export','delete','retention','restore'));

-- Metadata only: no customer bodies, recipient addresses or arbitrary error strings.
CREATE FUNCTION tenant_operational_alerts() RETURNS TABLE(tenant_slug text, component text, failures bigint)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT t.slug,'inbound',count(*) FROM public.inbound_messages x JOIN public.tenants t ON t.id=x.tenant_id
    WHERE t.active AND x.status='failed' GROUP BY t.slug
  UNION ALL SELECT t.slug,'notifications',count(*) FROM public.notification_deliveries x JOIN public.tenants t ON t.id=x.tenant_id
    WHERE t.active AND x.status='pending' AND x.attempts>0 GROUP BY t.slug
  UNION ALL SELECT t.slug,'operator_jobs',count(*) FROM public.operator_jobs x JOIN public.tenants t ON t.id=x.tenant_id
    WHERE x.status='failed' OR (x.status='queued' AND x.created_at<now()-interval '30 minutes') GROUP BY t.slug
$$;
GRANT SELECT ON public.operator_jobs TO astrama_auth_reader;
CREATE POLICY operator_jobs_monitor ON public.operator_jobs FOR SELECT TO astrama_auth_reader USING(true);
ALTER FUNCTION tenant_operational_alerts() OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION tenant_operational_alerts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_operational_alerts() TO astrama_app;
