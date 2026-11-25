-- New organisations only: the first administrator staffs the starter triage
-- group immediately. Activation still decides whether that administrator may
-- sign in. No other group, tenant or existing permission is changed.

GRANT INSERT(tenant_id,user_id,department_id) ON public.memberships TO astrama_auth_reader;
GRANT UPDATE(queue_owner_id) ON public.departments TO astrama_auth_reader;
CREATE POLICY signup_membership_insert ON public.memberships
  FOR INSERT TO astrama_auth_reader WITH CHECK (true);
CREATE POLICY signup_department_queue_owner_update ON public.departments
  FOR UPDATE TO astrama_auth_reader USING (is_triage) WITH CHECK (is_triage);

CREATE OR REPLACE FUNCTION public.provision_verified_signup(
  p_signup_id uuid, p_tenant_id uuid, p_admin_id uuid, p_password_hash text, p_invitation_hash text,
  p_encrypted_invitation text, p_invitation_expires timestamptz,
  p_trial_days integer, p_default_seat_limit integer, p_starter jsonb
) RETURNS TABLE(tenant_id uuid, tenant_slug text, admin_email text, trial_ends_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE request public.signup_requests%ROWTYPE; tenant uuid; admin uuid; dept jsonb; category jsonb;
  triage_dept uuid;
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
  SELECT d.id INTO triage_dept FROM public.departments d
  WHERE d.tenant_id=tenant AND d.is_triage LIMIT 1;
  IF triage_dept IS NULL THEN RAISE EXCEPTION 'starter template must define a triage department'; END IF;
  INSERT INTO public.memberships(tenant_id,user_id,department_id) VALUES(tenant,admin,triage_dept);
  UPDATE public.departments AS d SET queue_owner_id=admin
  WHERE d.tenant_id=tenant AND d.id=triage_dept;
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
  VALUES(gen_random_uuid(),tenant,admin,tenant,'organisation.provisioned',jsonb_build_object(
    'slug',request.slug,'administratorEmail',request.admin_email,
    'triageDepartmentId',triage_dept,'triageQueueOwnerId',admin));
  UPDATE public.signup_requests SET provisioned_tenant_id=tenant WHERE id=request.id;
  RETURN QUERY SELECT tenant,request.slug,request.admin_email,now()+make_interval(days=>p_trial_days);
END $$;
ALTER FUNCTION public.provision_verified_signup(uuid,uuid,uuid,text,text,text,timestamptz,integer,integer,jsonb) OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.provision_verified_signup(uuid,uuid,uuid,text,text,text,timestamptz,integer,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.provision_verified_signup(uuid,uuid,uuid,text,text,text,timestamptz,integer,integer,jsonb) TO astrama_app;
