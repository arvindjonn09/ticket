ALTER TABLE public.billing_plans ADD COLUMN revision integer NOT NULL DEFAULT 0 CHECK(revision>=0);

CREATE TABLE public.operator_jobs (
  id uuid PRIMARY KEY,
  operator_id uuid NOT NULL REFERENCES public.operators(id),
  tenant_id uuid NOT NULL,
  tenant_slug text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('export','mfa-recovery','set-plan')),
  reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','complete','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  output_directory text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX operator_jobs_pending ON public.operator_jobs(next_attempt_at) WHERE status IN ('queued','processing');
ALTER TABLE public.operator_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_jobs_scope ON public.operator_jobs
  USING (tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
REVOKE ALL ON public.operator_jobs FROM PUBLIC;
GRANT SELECT,INSERT ON public.operator_jobs TO astrama_app;

GRANT SELECT(role) ON public.operators TO astrama_auth_reader;
GRANT SELECT,INSERT,UPDATE ON public.billing_plans TO astrama_auth_reader;
CREATE POLICY operator_plan_configuration ON public.billing_plans TO astrama_auth_reader USING (true) WITH CHECK (true);
GRANT INSERT ON public.operator_audits TO astrama_auth_reader;
CREATE POLICY operator_plan_audit ON public.operator_audits FOR INSERT TO astrama_auth_reader WITH CHECK (true);

CREATE FUNCTION public.operator_billing_plans(p_operator uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.operators WHERE id=p_operator AND active) THEN
    RAISE EXCEPTION 'active operator required' USING ERRCODE='42501';
  END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id',id,'name',name,'stripePriceId',stripe_price_id,'seatLimit',seat_limit,
    'billingInterval',billing_interval,'active',active,'revision',revision) ORDER BY name,id) FROM public.billing_plans),'[]'::jsonb);
END $$;
ALTER FUNCTION public.operator_billing_plans(uuid) OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.operator_billing_plans(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_billing_plans(uuid) TO astrama_app;

CREATE FUNCTION public.operator_save_billing_plan(p_operator uuid,p_reason text,p_plan jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE old public.billing_plans%ROWTYPE; requested_id text := p_plan->>'id';
BEGIN
  PERFORM 1 FROM public.operators WHERE id=p_operator AND active AND role='owner';
  IF NOT FOUND THEN RAISE EXCEPTION 'owner operator required' USING ERRCODE='42501'; END IF;
  IF length(trim(p_reason)) NOT BETWEEN 10 AND 1000 OR p_reason IS NULL
     OR length(requested_id) NOT BETWEEN 1 AND 80 OR requested_id IS NULL
     OR length(p_plan->>'name') NOT BETWEEN 1 AND 120
     OR p_plan->>'stripePriceId' NOT LIKE 'price\_%' ESCAPE '\'
     OR p_plan->>'billingInterval' NOT IN ('month','year')
     OR (p_plan->>'seatLimit')::integer<1 OR jsonb_typeof(p_plan->'active')<>'boolean'
  THEN RAISE EXCEPTION 'invalid billing plan'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('billing-plan-config',0));
  SELECT * INTO old FROM public.billing_plans WHERE id=requested_id FOR UPDATE;
  IF (old.id IS NULL AND (p_plan->>'revision')::integer IS DISTINCT FROM 0)
    OR (old.id IS NOT NULL AND old.revision IS DISTINCT FROM (p_plan->>'revision')::integer) THEN
    RAISE EXCEPTION 'billing plan changed; refresh before editing' USING ERRCODE='23514';
  END IF;
  IF FOUND AND EXISTS(SELECT 1 FROM public.tenants WHERE plan_id=requested_id)
     AND (old.stripe_price_id,old.seat_limit,old.billing_interval) IS DISTINCT FROM
       (p_plan->>'stripePriceId',(p_plan->>'seatLimit')::integer,p_plan->>'billingInterval') THEN
    RAISE EXCEPTION 'create a new plan to change commercial terms of an assigned plan' USING ERRCODE='23514';
  END IF;
  INSERT INTO public.billing_plans(id,name,stripe_price_id,seat_limit,billing_interval,active)
  VALUES(requested_id,p_plan->>'name',p_plan->>'stripePriceId',(p_plan->>'seatLimit')::integer,
    p_plan->>'billingInterval',(p_plan->>'active')::boolean)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,stripe_price_id=excluded.stripe_price_id,
    seat_limit=excluded.seat_limit,billing_interval=excluded.billing_interval,active=excluded.active,
    updated_at=now(),revision=billing_plans.revision+1;
  INSERT INTO public.operator_audits(id,operator_id,action,reason,detail)
  VALUES(gen_random_uuid(),p_operator,'billing.plan_saved',p_reason,
    jsonb_build_object('planId',requested_id,'active',(p_plan->>'active')::boolean));
END $$;
ALTER FUNCTION public.operator_save_billing_plan(uuid,text,jsonb) OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.operator_save_billing_plan(uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_save_billing_plan(uuid,text,jsonb) TO astrama_app;
