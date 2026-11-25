CREATE TABLE public.tenant_outgoing_mail (
 tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
 revision integer NOT NULL DEFAULT 0,
 mode text NOT NULL DEFAULT 'platform' CHECK(mode IN ('platform','smtp','microsoft365')),
 status text NOT NULL DEFAULT 'working' CHECK(status IN ('working','problem')),
 provider text,host text,port integer,security text,username text,from_address text,
 encrypted_secret text,account_id text,configured_by_id uuid,
 consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0),
 last_error_code text,tested_at timestamptz,
 notice_pending_at timestamptz,notice_sent_at timestamptz,notice_attempts integer NOT NULL DEFAULT 0,
 notice_next_attempt_at timestamptz NOT NULL DEFAULT now(),
 CHECK(mode='platform' OR (provider IN ('smtp','google','microsoft365') AND host IS NOT NULL AND port IN (465,587,25,2525)
   AND security IN ('tls','starttls') AND username IS NOT NULL AND from_address IS NOT NULL AND encrypted_secret IS NOT NULL)),
 CHECK(mode<>'microsoft365' OR (host='smtp.office365.com' AND port=587 AND security='starttls' AND account_id IS NOT NULL)),
 FOREIGN KEY(tenant_id,configured_by_id) REFERENCES public.users(tenant_id,id)
);
CREATE TABLE public.mail_oauth_connections (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 admin_id uuid NOT NULL,session_id uuid NOT NULL,revision integer NOT NULL,
 mailbox_address text NOT NULL,from_address text NOT NULL,
 state_hash text NOT NULL UNIQUE,encrypted_pkce text,encrypted_cache text,account_id text,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','problem')),
 error_code text,expires_at timestamptz NOT NULL,consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,admin_id) REFERENCES public.users(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,session_id) REFERENCES public.sessions(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX mail_oauth_connections_tenant_admin ON public.mail_oauth_connections(tenant_id,admin_id,created_at);
ALTER TABLE public.tenant_outgoing_mail ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_outgoing_mail FORCE ROW LEVEL SECURITY;
ALTER TABLE public.mail_oauth_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mail_oauth_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outgoing_scope ON public.tenant_outgoing_mail TO astrama_app USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY mail_oauth_scope ON public.mail_oauth_connections TO astrama_app USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
REVOKE ALL ON public.tenant_outgoing_mail,public.mail_oauth_connections FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.tenant_outgoing_mail,public.mail_oauth_connections TO astrama_app;
GRANT SELECT,UPDATE,DELETE ON public.mail_oauth_connections TO astrama_auth_reader;
GRANT SELECT(tenant_id,notice_pending_at,notice_sent_at,notice_attempts,notice_next_attempt_at) ON public.tenant_outgoing_mail TO astrama_auth_reader;
CREATE POLICY oauth_state_lookup ON public.mail_oauth_connections TO astrama_auth_reader USING(true) WITH CHECK(true);
CREATE POLICY outgoing_notice_lookup ON public.tenant_outgoing_mail FOR SELECT TO astrama_auth_reader USING(true);
GRANT SELECT(id,tenant_id,user_id,mfa_verified,expires_at) ON public.sessions TO astrama_auth_reader;
CREATE POLICY oauth_session_lookup ON public.sessions FOR SELECT TO astrama_auth_reader USING(true);
GRANT SELECT(id,tenant_id,active,role,mfa_enrolled) ON public.users TO astrama_auth_reader;

-- OAuth returns on the fixed public host without a tenant session cookie. Only a random,
-- unexpired one-use state can resolve its tenant; current administrator/session authority is rechecked.
CREATE FUNCTION public.claim_mail_oauth_state(p_hash text) RETURNS SETOF public.mail_oauth_connections
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.mail_oauth_connections%ROWTYPE;
BEGIN
 SELECT * INTO c FROM public.mail_oauth_connections WHERE state_hash=p_hash AND consumed_at IS NULL AND expires_at>now() FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.users u JOIN public.sessions s ON s.user_id=u.id AND s.tenant_id=u.tenant_id
   JOIN public.tenants t ON t.id=u.tenant_id
   WHERE u.id=c.admin_id AND u.tenant_id=c.tenant_id AND u.active AND u.role='admin' AND u.mfa_enrolled
     AND s.id=c.session_id AND s.mfa_verified AND s.expires_at>now() AND t.active AND t.status IN ('trial','active')) THEN RETURN; END IF;
 UPDATE public.mail_oauth_connections SET consumed_at=clock_timestamp(),encrypted_pkce=NULL WHERE id=c.id;
 RETURN NEXT c;
END $$;
ALTER FUNCTION public.claim_mail_oauth_state(text) OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.claim_mail_oauth_state(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_mail_oauth_state(text) TO astrama_app;

CREATE FUNCTION public.pending_outgoing_mail_notices() RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT m.tenant_id FROM public.tenant_outgoing_mail m JOIN public.tenants t ON t.id=m.tenant_id
 WHERE t.active AND t.status IN ('trial','active','read_only') AND m.notice_pending_at IS NOT NULL AND m.notice_sent_at IS NULL
   AND m.notice_next_attempt_at<=now() ORDER BY m.notice_pending_at LIMIT 100
$$;
ALTER FUNCTION public.pending_outgoing_mail_notices() OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.pending_outgoing_mail_notices() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pending_outgoing_mail_notices() TO astrama_app;

CREATE FUNCTION public.delete_expired_mail_oauth_connections() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DELETE FROM public.mail_oauth_connections WHERE expires_at<=now()
$$;
ALTER FUNCTION public.delete_expired_mail_oauth_connections() OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.delete_expired_mail_oauth_connections() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_expired_mail_oauth_connections() TO astrama_app;
