ALTER TABLE public.tickets
  ADD COLUMN sla_first_response_target_minutes integer,
  ADD COLUMN sla_resolution_target_minutes integer,
  ADD COLUMN sla_calendar_type text,
  ADD COLUMN sla_first_response_calendar_type text,
  ADD COLUMN sla_calendar jsonb,
  ADD COLUMN sla_first_response_due_at timestamptz,
  ADD COLUMN sla_resolution_due_at timestamptz,
  ADD COLUMN sla_first_responded_at timestamptz,
  ADD COLUMN sla_resolution_started_at timestamptz,
  ADD COLUMN sla_resolved_at timestamptz,
  ADD CONSTRAINT tickets_sla_calendar_type_check CHECK (sla_calendar_type IS NULL OR sla_calendar_type IN ('business','24x7')),
  ADD CONSTRAINT tickets_sla_first_calendar_type_check CHECK (sla_first_response_calendar_type IS NULL OR sla_first_response_calendar_type IN ('business','24x7')),
  ADD CONSTRAINT tickets_sla_targets_positive_check CHECK (
    (sla_first_response_target_minutes IS NULL OR sla_first_response_target_minutes > 0) AND
    (sla_resolution_target_minutes IS NULL OR sla_resolution_target_minutes > 0)
  );

CREATE TABLE public.sla_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings)='object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sla_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sla_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.sla_settings
  USING (tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT,INSERT,UPDATE ON public.sla_settings TO astrama_app;

CREATE TABLE public.sla_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  target text NOT NULL CHECK (target IN ('first_response','resolution')),
  stage text NOT NULL CHECK (stage IN ('warning','breach')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,ticket_id) REFERENCES public.tickets(tenant_id,id) ON DELETE CASCADE,
  UNIQUE(tenant_id,ticket_id,target,stage)
);
ALTER TABLE public.sla_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sla_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.sla_alerts
  USING (tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT,INSERT ON public.sla_alerts TO astrama_app;

CREATE INDEX tickets_sla_first_response_due_idx ON public.tickets(tenant_id,sla_first_response_due_at)
  WHERE sla_first_responded_at IS NULL AND sla_first_response_due_at IS NOT NULL;
CREATE INDEX tickets_sla_resolution_due_idx ON public.tickets(tenant_id,sla_resolution_due_at)
  WHERE state NOT IN ('Resolved','Complete','Cancelled','Rejected') AND sla_resolution_due_at IS NOT NULL;

CREATE FUNCTION public.pending_sla_tenants() RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT tenant.id FROM public.tenants tenant WHERE tenant.active
$$;
ALTER FUNCTION public.pending_sla_tenants() OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.pending_sla_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pending_sla_tenants() TO astrama_app;
