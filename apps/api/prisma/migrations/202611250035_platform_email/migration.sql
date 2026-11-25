ALTER TABLE public.tenant_budgets DROP CONSTRAINT tenant_budgets_kind_check;
ALTER TABLE public.tenant_budgets ADD CONSTRAINT tenant_budgets_kind_check
  CHECK (kind IN ('requests','uploads','inbound','exports','outbound'));

-- Delivery metadata only. No recipient, subject, body, SMTP reply or credentials.
CREATE TABLE public.tenant_mail_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);
CREATE INDEX tenant_mail_delivery_health ON public.tenant_mail_deliveries(tenant_id, created_at);
ALTER TABLE public.tenant_mail_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_mail_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_mail_delivery_scope ON public.tenant_mail_deliveries TO astrama_app
  USING (tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT, INSERT ON public.tenant_mail_deliveries TO astrama_app;
