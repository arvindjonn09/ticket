ALTER TABLE public.billing_plans ADD COLUMN hide_branding boolean NOT NULL DEFAULT false;

-- An assigned plan keeps its branding choice when it is retired from sale.
CREATE POLICY tenant_assigned_billing_plan ON public.billing_plans FOR SELECT TO astrama_app
USING (EXISTS (
  SELECT 1 FROM public.tenants t
  WHERE t.id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND t.plan_id = billing_plans.id
));
