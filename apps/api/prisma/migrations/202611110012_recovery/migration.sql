-- Tenant data remains RLS protected; only narrow authentication lookups enumerate it.
CREATE TABLE public.password_recoveries (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE, password_hash text NOT NULL, email text NOT NULL,
 expires_at timestamptz(6) NOT NULL, used_at timestamptz(6), encrypted_url text,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','skipped')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0), last_error text,
 created_at timestamptz(6) NOT NULL DEFAULT now(), next_attempt_at timestamptz(6) NOT NULL DEFAULT now(), sent_at timestamptz(6),
 FOREIGN KEY(tenant_id,user_id) REFERENCES public.users(tenant_id,id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX password_recoveries_pending_idx ON public.password_recoveries(status,next_attempt_at);
ALTER TABLE public.password_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_recoveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.password_recoveries USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY authentication_lookup ON public.password_recoveries FOR SELECT TO astrama_auth_reader USING(true);
GRANT SELECT,INSERT,UPDATE ON public.password_recoveries TO astrama_app;
GRANT SELECT ON public.password_recoveries TO astrama_auth_reader;
CREATE FUNCTION public.auth_recovery_lookup(recovery_hash text, organisation_slug text)
RETURNS TABLE(id uuid,tenant_id uuid,user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT r.id,r.tenant_id,r.user_id FROM public.password_recoveries r
 JOIN public.users u ON u.tenant_id=r.tenant_id AND u.id=r.user_id JOIN public.tenants t ON t.id=r.tenant_id
 WHERE r.token_hash=recovery_hash AND t.slug=organisation_slug AND t.active AND u.active
 AND r.used_at IS NULL AND r.expires_at>now() AND r.password_hash=u.password_hash AND r.email=u.email
$$;
CREATE FUNCTION public.pending_recovery_mail() RETURNS TABLE(id uuid,tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT r.id,r.tenant_id FROM public.password_recoveries r JOIN public.tenants t ON t.id=r.tenant_id
 WHERE r.status='pending' AND r.next_attempt_at<=now() AND t.active ORDER BY r.created_at,r.id LIMIT 100
$$;
ALTER FUNCTION public.auth_recovery_lookup(text,text) OWNER TO astrama_auth_reader;
ALTER FUNCTION public.pending_recovery_mail() OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.auth_recovery_lookup(text,text),public.pending_recovery_mail() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_recovery_lookup(text,text),public.pending_recovery_mail() TO astrama_app;

-- Infrastructure keys are SHA-256 digests, never tenant/user/IP strings. Runtime has no direct table access.
CREATE TABLE public.auth_rate_limits (key text PRIMARY KEY CHECK(key ~ '^[0-9a-f]{64}$'), attempts integer NOT NULL, expires_at timestamptz NOT NULL);
CREATE FUNCTION public.auth_reserve_attempt(attempt_key text, maximum integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE accepted boolean;
BEGIN
 IF attempt_key !~ '^[0-9a-f]{64}$' OR maximum<1 OR maximum>1000 THEN RAISE EXCEPTION 'Invalid authentication limit'; END IF;
 DELETE FROM public.auth_rate_limits WHERE expires_at<=clock_timestamp();
 INSERT INTO public.auth_rate_limits AS limits(key,attempts,expires_at) VALUES(attempt_key,1,clock_timestamp()+interval '15 minutes')
 ON CONFLICT(key) DO UPDATE SET attempts=limits.attempts+1 WHERE limits.attempts<maximum
 RETURNING true INTO accepted;
 RETURN COALESCE(accepted,false);
END $$;
CREATE FUNCTION public.auth_release_attempt(attempt_key text, clear_all boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF clear_all THEN DELETE FROM public.auth_rate_limits WHERE key=attempt_key;
 ELSE UPDATE public.auth_rate_limits SET attempts=greatest(0,attempts-1) WHERE key=attempt_key; END IF;
END $$;
REVOKE ALL ON public.auth_rate_limits FROM PUBLIC,astrama_app;
REVOKE ALL ON FUNCTION public.auth_reserve_attempt(text,integer),public.auth_release_attempt(text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_reserve_attempt(text,integer),public.auth_release_attempt(text,boolean) TO astrama_app;
