CREATE TABLE public.invitation_mails (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid NOT NULL,
  invitation_hash text NOT NULL, encrypted_url text, status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0, last_error text,
  created_at timestamptz(6) NOT NULL DEFAULT now(), next_attempt_at timestamptz(6) NOT NULL DEFAULT now(), sent_at timestamptz(6),
  CONSTRAINT invitation_mails_user_fkey FOREIGN KEY(tenant_id,user_id) REFERENCES public.users(tenant_id,id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT invitation_mails_status_check CHECK(status IN ('pending','sent','skipped')),
  CONSTRAINT invitation_mails_attempts_check CHECK(attempts >= 0)
);
CREATE UNIQUE INDEX invitation_mails_tenant_id_id_key ON public.invitation_mails(tenant_id,id);
CREATE INDEX invitation_mails_status_next_attempt_at_idx ON public.invitation_mails(status,next_attempt_at);
ALTER TABLE public.invitation_mails ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitation_mails FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.invitation_mails USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT,INSERT,UPDATE ON public.invitation_mails TO astrama_app;
GRANT SELECT ON public.invitation_mails TO astrama_auth_reader;
CREATE POLICY authentication_lookup ON public.invitation_mails FOR SELECT TO astrama_auth_reader USING(true);
CREATE FUNCTION public.pending_invitation_mail()
RETURNS TABLE(id uuid,tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT mail.id,mail.tenant_id FROM public.invitation_mails mail JOIN public.tenants tenant ON tenant.id=mail.tenant_id
  WHERE mail.status='pending' AND mail.next_attempt_at <= now() AND tenant.active
  ORDER BY mail.created_at,mail.id LIMIT 100
$$;
ALTER FUNCTION public.pending_invitation_mail() OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.pending_invitation_mail() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pending_invitation_mail() TO astrama_app;
