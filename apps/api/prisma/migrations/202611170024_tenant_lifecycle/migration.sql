ALTER TABLE public.tenants
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD COLUMN read_only_reason text,
  ADD COLUMN trial_ends_at timestamptz,
  ADD COLUMN read_only_since timestamptz,
  ADD COLUMN delete_after timestamptz,
  ADD COLUMN seat_limit integer NOT NULL DEFAULT 100000,
  ADD COLUMN plan_id text,
  ADD COLUMN starter_template_version text;

UPDATE public.tenants tenant
SET seat_limit=GREATEST(25,(
  SELECT count(*)::integer FROM public.users account
  WHERE account.tenant_id=tenant.id AND account.active AND account.role<>'system'
));

ALTER TABLE public.tenants
  ADD CONSTRAINT tenant_status_check CHECK (status IN ('trial','active','read_only','deleted')),
  ADD CONSTRAINT tenant_read_only_reason_check CHECK (
    read_only_reason IS NULL OR read_only_reason IN ('trial_ended','payment_failed','cancelled','operator')
  ),
  ADD CONSTRAINT tenant_seat_limit_check CHECK (seat_limit > 0),
  ADD CONSTRAINT tenant_lifecycle_dates_check CHECK (
    (status='trial' AND trial_ends_at IS NOT NULL AND read_only_since IS NULL AND delete_after IS NULL)
    OR (status='active' AND read_only_since IS NULL AND delete_after IS NULL)
    OR (status='read_only' AND read_only_since IS NOT NULL AND delete_after IS NOT NULL)
    OR status='deleted'
  );

CREATE TABLE public.tenant_status_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  tenant_slug text NOT NULL,
  old_status text NOT NULL,
  new_status text NOT NULL,
  reason text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.tenant_status_audits FROM PUBLIC, astrama_app, astrama_auth_reader;
GRANT INSERT ON public.tenant_status_audits TO astrama_auth_reader;

CREATE FUNCTION public.audit_tenant_status_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO public.tenant_status_audits(tenant_id,tenant_slug,old_status,new_status,reason)
    VALUES(NEW.id,NEW.slug,'none',NEW.status,NEW.read_only_reason);
  ELSIF (OLD.status,OLD.read_only_reason,OLD.trial_ends_at,OLD.read_only_since,OLD.delete_after)
        IS DISTINCT FROM
        (NEW.status,NEW.read_only_reason,NEW.trial_ends_at,NEW.read_only_since,NEW.delete_after) THEN
    INSERT INTO public.tenant_status_audits(tenant_id,tenant_slug,old_status,new_status,reason)
    VALUES(NEW.id,NEW.slug,OLD.status,NEW.status,NEW.read_only_reason);
  END IF;
  RETURN NEW;
END
$$;
ALTER FUNCTION public.audit_tenant_status_change() OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.audit_tenant_status_change() FROM PUBLIC;
CREATE TRIGGER tenant_status_audit AFTER INSERT OR UPDATE ON public.tenants
FOR EACH ROW EXECUTE FUNCTION public.audit_tenant_status_change();

CREATE FUNCTION public.reject_tenant_status_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tenant status audit rows are append-only';
END
$$;
CREATE TRIGGER tenant_status_audit_append_only BEFORE UPDATE OR DELETE ON public.tenant_status_audits
FOR EACH ROW EXECUTE FUNCTION public.reject_tenant_status_audit_mutation();

CREATE TABLE public.tenant_lifecycle_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  period_start timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('deletion_30d','deletion_7d','deletion_1d')),
  due_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt timestamptz,
  sent_at timestamptz,
  UNIQUE(tenant_id,period_start,kind)
);
CREATE INDEX tenant_lifecycle_notices_due_idx
  ON public.tenant_lifecycle_notices(due_at) WHERE sent_at IS NULL;
ALTER TABLE public.tenant_lifecycle_notices ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_lifecycle_notices_scope ON public.tenant_lifecycle_notices
  USING (tenant_id=current_setting('app.tenant_id',true)::uuid)
  WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.tenant_lifecycle_notices TO astrama_app;

CREATE FUNCTION public.pending_tenant_lifecycle() RETURNS TABLE(
  tenant_id uuid,slug text,status text,trial_ends_at timestamptz,
  read_only_since timestamptz,delete_after timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT id,slug,status,trial_ends_at,read_only_since,delete_after
  FROM public.tenants WHERE status IN ('trial','read_only','deleted')
$$;
ALTER FUNCTION public.pending_tenant_lifecycle() OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.pending_tenant_lifecycle() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pending_tenant_lifecycle() TO astrama_app;

GRANT UPDATE(status,read_only_reason,trial_ends_at,read_only_since,delete_after,seat_limit,plan_id,starter_template_version,active)
  ON public.tenants TO astrama_app;

CREATE OR REPLACE FUNCTION public.pending_sla_tenants() RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT tenant.id FROM public.tenants tenant WHERE tenant.active AND tenant.status IN ('trial','active')
$$;

CREATE OR REPLACE FUNCTION public.pending_automation_tenants() RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT s.tenant_id FROM public.automation_settings s
  JOIN public.tenants t ON t.id=s.tenant_id
  WHERE s.enabled AND t.active AND t.status IN ('trial','active')
$$;

CREATE OR REPLACE FUNCTION public.resolve_inbound_address(normalized_address text)
RETURNS TABLE(tenant_id uuid,address_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  WITH exact_match AS (
    SELECT address.tenant_id,address.id AS address_id,0 AS priority
    FROM public.inbound_mail_addresses address
    JOIN public.tenants tenant ON tenant.id=address.tenant_id
      AND tenant.active AND tenant.status IN ('trial','active')
    WHERE address.address=lower(normalized_address)
  ), domain_match AS (
    SELECT min(address.tenant_id::text)::uuid AS tenant_id,NULL::uuid AS address_id,1 AS priority
    FROM public.inbound_mail_addresses address
    JOIN public.tenants tenant ON tenant.id=address.tenant_id
      AND tenant.active AND tenant.status IN ('trial','active')
    WHERE split_part(address.address,'@',2)=split_part(lower(normalized_address),'@',2)
    GROUP BY split_part(address.address,'@',2)
    HAVING count(DISTINCT address.tenant_id)=1
  )
  SELECT candidate.tenant_id,candidate.address_id
  FROM (SELECT * FROM exact_match UNION ALL SELECT * FROM domain_match) candidate
  ORDER BY candidate.priority LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.pending_inbound_messages()
RETURNS TABLE(tenant_id uuid,id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT message.tenant_id,message.id
  FROM public.inbound_messages message
  JOIN public.tenants tenant ON tenant.id=message.tenant_id
    AND tenant.active AND tenant.status IN ('trial','active')
  WHERE message.status IN ('queued','failed') AND message.next_attempt_at<=now()
  ORDER BY message.next_attempt_at,message.id
  LIMIT 500
$$;

CREATE OR REPLACE FUNCTION public.pending_invitation_mail()
RETURNS TABLE(id uuid,tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT mail.id,mail.tenant_id
  FROM public.invitation_mails mail
  JOIN public.tenants tenant ON tenant.id=mail.tenant_id
  WHERE mail.status='pending' AND mail.next_attempt_at<=now()
    AND tenant.active AND tenant.status IN ('trial','active')
  ORDER BY mail.created_at,mail.id LIMIT 100
$$;

CREATE OR REPLACE FUNCTION public.pending_recovery_mail()
RETURNS TABLE(id uuid,tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT recovery.id,recovery.tenant_id
  FROM public.password_recoveries recovery
  JOIN public.tenants tenant ON tenant.id=recovery.tenant_id
  WHERE recovery.status='pending' AND recovery.next_attempt_at<=now()
    AND tenant.active AND tenant.status IN ('trial','active')
  ORDER BY recovery.created_at,recovery.id LIMIT 100
$$;

ALTER FUNCTION public.resolve_inbound_address(text) OWNER TO astrama_auth_reader;
ALTER FUNCTION public.pending_inbound_messages() OWNER TO astrama_auth_reader;
ALTER FUNCTION public.pending_invitation_mail() OWNER TO astrama_auth_reader;
ALTER FUNCTION public.pending_recovery_mail() OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.resolve_inbound_address(text),public.pending_inbound_messages(),
  public.pending_invitation_mail(),public.pending_recovery_mail() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_inbound_address(text),public.pending_inbound_messages(),
  public.pending_invitation_mail(),public.pending_recovery_mail() TO astrama_app;
