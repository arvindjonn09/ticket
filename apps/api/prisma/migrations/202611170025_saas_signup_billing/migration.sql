ALTER TABLE public.tenants
  ADD COLUMN stripe_customer_id text,
  ADD COLUMN stripe_subscription_id text;

CREATE TABLE public.billing_plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  stripe_price_id text NOT NULL UNIQUE,
  seat_limit integer NOT NULL CHECK (seat_limit > 0),
  billing_interval text NOT NULL CHECK (billing_interval IN ('month','year')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.billing_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY public_active_billing_plans ON public.billing_plans FOR SELECT USING (active);
REVOKE ALL ON public.billing_plans FROM PUBLIC;
GRANT SELECT ON public.billing_plans TO astrama_app;

CREATE TABLE public.signup_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  company_name text NOT NULL,
  admin_name text NOT NULL,
  admin_email text NOT NULL,
  timezone text NOT NULL,
  plan_id text REFERENCES public.billing_plans(id),
  verification_hash text NOT NULL UNIQUE,
  verification_expires timestamptz NOT NULL,
  verified_at timestamptz,
  provisioned_tenant_id uuid UNIQUE REFERENCES public.tenants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.public_mail_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient text NOT NULL,
  subject text NOT NULL,
  encrypted_url text,
  identity text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.signup_provision_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signup_id uuid NOT NULL UNIQUE REFERENCES public.signup_requests(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','enqueued','processing','complete')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt timestamptz NOT NULL DEFAULT now(),
  last_error text,
  completed_at timestamptz
);
CREATE INDEX signup_provision_jobs_pending ON public.signup_provision_jobs(next_attempt) WHERE status<>'complete';
CREATE INDEX public_mail_outbox_pending ON public.public_mail_outbox(next_attempt_at) WHERE sent_at IS NULL;
CREATE TABLE public.signup_rate_limits (
  key_hash text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.billing_provider_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY(provider,event_id)
);

REVOKE ALL ON public.signup_requests, public.signup_provision_jobs, public.public_mail_outbox, public.signup_rate_limits,
  public.billing_provider_events FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.signup_requests TO astrama_app;
GRANT SELECT,INSERT,UPDATE ON public.signup_provision_jobs TO astrama_app;
GRANT SELECT,INSERT,UPDATE ON public.public_mail_outbox TO astrama_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.signup_rate_limits TO astrama_app;
REVOKE ALL ON public.billing_provider_events FROM astrama_app;

-- Provisioning and billing run through non-login definer functions. The executor
-- receives only the table operations and RLS policies required by those functions.
GRANT SELECT ON public.billing_plans TO astrama_auth_reader;
GRANT SELECT,DELETE ON public.signup_requests TO astrama_auth_reader;
GRANT INSERT(slug,company_name,admin_name,admin_email,timezone,plan_id,verification_hash,verification_expires),
  UPDATE(verified_at,provisioned_tenant_id,verification_hash,verification_expires)
  ON public.signup_requests TO astrama_auth_reader;
GRANT SELECT(provider,event_id),INSERT(provider,event_id,event_type,processed_at),UPDATE(processed_at)
  ON public.billing_provider_events TO astrama_auth_reader;
GRANT INSERT(id,slug,name,brand_name,timezone,status,trial_ends_at,seat_limit,plan_id,starter_template_version),
  UPDATE(status,read_only_reason,read_only_since,delete_after,stripe_customer_id,stripe_subscription_id,plan_id,seat_limit)
  ON public.tenants TO astrama_auth_reader;
GRANT INSERT(id,tenant_id,name,email,password_hash,role,active,invitation_hash,invitation_expires_at,invited_at,revision)
  ON public.users TO astrama_auth_reader;
GRANT INSERT(id,tenant_id,name,is_triage) ON public.departments TO astrama_auth_reader;
GRANT INSERT(id,tenant_id,name,department_id,sensitive) ON public.categories TO astrama_auth_reader;
GRANT INSERT(tenant_id,revision,settings) ON public.sla_settings TO astrama_auth_reader;
GRANT INSERT(id,tenant_id,user_id,invitation_hash,encrypted_url) ON public.invitation_mails TO astrama_auth_reader;
GRANT INSERT(id,tenant_id,actor_id,entity_id,action,detail) ON public.config_audits TO astrama_auth_reader;
CREATE POLICY signup_tenant_insert ON public.tenants FOR INSERT TO astrama_auth_reader WITH CHECK (true);
CREATE POLICY signup_tenant_billing_update ON public.tenants FOR UPDATE TO astrama_auth_reader USING (true) WITH CHECK (true);
CREATE POLICY signup_user_insert ON public.users FOR INSERT TO astrama_auth_reader WITH CHECK (true);
CREATE POLICY signup_department_insert ON public.departments FOR INSERT TO astrama_auth_reader WITH CHECK (true);
CREATE POLICY signup_category_insert ON public.categories FOR INSERT TO astrama_auth_reader WITH CHECK (true);
CREATE POLICY signup_sla_insert ON public.sla_settings FOR INSERT TO astrama_auth_reader WITH CHECK (true);
CREATE POLICY signup_invitation_insert ON public.invitation_mails FOR INSERT TO astrama_auth_reader WITH CHECK (true);
CREATE POLICY signup_audit_insert ON public.config_audits FOR INSERT TO astrama_auth_reader WITH CHECK (true);

CREATE FUNCTION public.begin_public_signup(
  p_slug text, p_company text, p_admin_name text, p_admin_email text,
  p_timezone text, p_plan_id text, p_verification_hash text, p_expires timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE request_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('signup:'||p_slug,0));
  IF p_plan_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.billing_plans WHERE id=p_plan_id AND active
  ) THEN
    RAISE EXCEPTION 'plan unavailable' USING ERRCODE='23503';
  END IF;
  DELETE FROM public.signup_requests WHERE verification_expires <= now() AND verified_at IS NULL;
  IF EXISTS (SELECT 1 FROM public.tenants WHERE slug=p_slug)
     OR EXISTS (SELECT 1 FROM public.signup_requests WHERE slug=p_slug) THEN
    RAISE EXCEPTION 'slug unavailable' USING ERRCODE='23505';
  END IF;
  INSERT INTO public.signup_requests(slug,company_name,admin_name,admin_email,timezone,plan_id,
    verification_hash,verification_expires)
  VALUES(p_slug,p_company,p_admin_name,p_admin_email,p_timezone,p_plan_id,p_verification_hash,p_expires)
  RETURNING id INTO request_id;
  RETURN request_id;
END $$;
ALTER FUNCTION public.begin_public_signup(text,text,text,text,text,text,text,timestamptz) OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.begin_public_signup(text,text,text,text,text,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.begin_public_signup(text,text,text,text,text,text,text,timestamptz) TO astrama_app;

CREATE FUNCTION public.public_signup_slug_available(p_slug text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT NOT EXISTS(SELECT 1 FROM public.tenants WHERE slug=p_slug)
    AND NOT EXISTS(SELECT 1 FROM public.signup_requests WHERE slug=p_slug AND verification_expires>now())
$$;
ALTER FUNCTION public.public_signup_slug_available(text) OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.public_signup_slug_available(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_signup_slug_available(text) TO astrama_app;

CREATE FUNCTION public.provision_verified_signup(
  p_signup_id uuid, p_tenant_id uuid, p_admin_id uuid, p_password_hash text, p_invitation_hash text,
  p_encrypted_invitation text, p_invitation_expires timestamptz,
  p_trial_days integer, p_default_seat_limit integer, p_starter jsonb
) RETURNS TABLE(tenant_id uuid, tenant_slug text, admin_email text, trial_ends_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE request public.signup_requests%ROWTYPE; tenant uuid; admin uuid; dept jsonb; category jsonb;
BEGIN
  SELECT * INTO request FROM public.signup_requests WHERE id=p_signup_id FOR UPDATE;
  IF NOT FOUND OR request.verified_at IS NULL THEN RAISE EXCEPTION 'signup is not verified'; END IF;
  IF request.provisioned_tenant_id IS NOT NULL THEN
    RETURN QUERY SELECT t.id,t.slug,request.admin_email,t.trial_ends_at FROM public.tenants t WHERE t.id=request.provisioned_tenant_id;
    RETURN;
  END IF;
  tenant := p_tenant_id;
  admin := p_admin_id;
  INSERT INTO public.tenants(id,slug,name,brand_name,timezone,status,trial_ends_at,seat_limit,plan_id,starter_template_version)
  VALUES(tenant,request.slug,request.company_name,request.company_name,request.timezone,'trial',
    now()+make_interval(days=>p_trial_days),COALESCE((SELECT seat_limit FROM public.billing_plans WHERE id=request.plan_id AND active),p_default_seat_limit),
    request.plan_id,p_starter->>'version');
  INSERT INTO public.users(id,tenant_id,name,email,password_hash,role,active,invitation_hash,invitation_expires_at,invited_at,revision)
  VALUES(admin,tenant,request.admin_name,request.admin_email,p_password_hash,'admin',false,
    p_invitation_hash,p_invitation_expires,now(),1);
  FOR dept IN SELECT value FROM jsonb_array_elements(p_starter->'departments') LOOP
    INSERT INTO public.departments(id,tenant_id,name,is_triage)
    VALUES(gen_random_uuid(),tenant,dept->>'name',COALESCE((dept->>'isTriage')::boolean,false));
  END LOOP;
  FOR category IN SELECT value FROM jsonb_array_elements(p_starter->'categories') LOOP
    INSERT INTO public.categories(id,tenant_id,name,department_id,sensitive)
    SELECT gen_random_uuid(),tenant,category->>'name',d.id,COALESCE((category->>'sensitive')::boolean,false)
    FROM public.departments d WHERE d.tenant_id=tenant AND d.name=category->>'department';
    IF NOT FOUND THEN RAISE EXCEPTION 'starter category references unknown department'; END IF;
  END LOOP;
  INSERT INTO public.sla_settings(tenant_id,revision,settings) VALUES(tenant,1,p_starter->'sla');
  INSERT INTO public.invitation_mails(id,tenant_id,user_id,invitation_hash,encrypted_url)
  VALUES(gen_random_uuid(),tenant,admin,p_invitation_hash,p_encrypted_invitation);
  INSERT INTO public.config_audits(id,tenant_id,actor_id,entity_id,action,detail)
  VALUES(gen_random_uuid(),tenant,admin,tenant,'organisation.provisioned',jsonb_build_object('slug',request.slug,'administratorEmail',request.admin_email));
  UPDATE public.signup_requests SET provisioned_tenant_id=tenant WHERE id=request.id;
  RETURN QUERY SELECT tenant,request.slug,request.admin_email,now()+make_interval(days=>p_trial_days);
END $$;
ALTER FUNCTION public.provision_verified_signup(uuid,uuid,uuid,text,text,text,timestamptz,integer,integer,jsonb) OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.provision_verified_signup(uuid,uuid,uuid,text,text,text,timestamptz,integer,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.provision_verified_signup(uuid,uuid,uuid,text,text,text,timestamptz,integer,integer,jsonb) TO astrama_app;

CREATE FUNCTION public.apply_billing_event(
  p_event_id text, p_event_type text, p_tenant_id uuid, p_plan_id text, p_customer_id text,
  p_subscription_id text, p_transition text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE inserted integer;
BEGIN
  INSERT INTO public.billing_provider_events(provider,event_id,event_type,processed_at)
  VALUES('stripe',p_event_id,p_event_type,now()) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted=0 THEN RETURN false; END IF;
  IF p_plan_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.billing_plans WHERE id=p_plan_id AND active
  ) THEN
    RAISE EXCEPTION 'billing plan is unavailable';
  END IF;
  IF p_transition='noop' THEN RETURN true; END IF;
  IF p_transition='activate' THEN
    UPDATE public.tenants SET status='active',read_only_reason=NULL,read_only_since=NULL,delete_after=NULL,
      plan_id=COALESCE(p_plan_id,plan_id),
      seat_limit=COALESCE((SELECT seat_limit FROM public.billing_plans WHERE id=p_plan_id AND active),seat_limit),
      stripe_customer_id=COALESCE(p_customer_id,stripe_customer_id),
      stripe_subscription_id=COALESCE(p_subscription_id,stripe_subscription_id)
    WHERE id=p_tenant_id AND status IN ('trial','active','read_only')
      AND (status<>'read_only' OR read_only_reason IN ('trial_ended','payment_failed','cancelled'));
  ELSIF p_transition IN ('payment_failed','cancelled') THEN
    UPDATE public.tenants SET status='read_only',read_only_reason=p_transition,
      read_only_since=COALESCE(read_only_since,now()),
      delete_after=COALESCE(delete_after,now()+interval '45 days'),
      stripe_customer_id=COALESCE(p_customer_id,stripe_customer_id),
      stripe_subscription_id=COALESCE(p_subscription_id,stripe_subscription_id)
    WHERE id=p_tenant_id AND status IN ('trial','active','read_only')
      AND (status<>'read_only' OR read_only_reason IN ('trial_ended','payment_failed','cancelled'));
  ELSE
    RAISE EXCEPTION 'invalid billing transition';
  END IF;
  UPDATE public.billing_provider_events SET processed_at=now()
  WHERE provider='stripe' AND event_id=p_event_id;
  RETURN true;
END $$;
ALTER FUNCTION public.apply_billing_event(text,text,uuid,text,text,text,text) OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.apply_billing_event(text,text,uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_billing_event(text,text,uuid,text,text,text,text) TO astrama_app;
