-- Authentication may cross tenant boundaries only through two narrow functions.
-- Their owner is neither a login nor a RLS-bypass role. FORCE RLS still applies;
-- dedicated SELECT policies permit only the five authentication/catalog tables.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='astrama_auth_reader') THEN
    CREATE ROLE astrama_auth_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO astrama_auth_reader;
GRANT SELECT ON public.tenants, public.users, public.departments, public.memberships, public.sessions TO astrama_auth_reader;
CREATE POLICY authentication_lookup ON public.tenants FOR SELECT TO astrama_auth_reader USING (true);
CREATE POLICY authentication_lookup ON public.users FOR SELECT TO astrama_auth_reader USING (true);
CREATE POLICY authentication_lookup ON public.departments FOR SELECT TO astrama_auth_reader USING (true);
CREATE POLICY authentication_lookup ON public.memberships FOR SELECT TO astrama_auth_reader USING (true);
CREATE POLICY authentication_lookup ON public.sessions FOR SELECT TO astrama_auth_reader USING (true);
ALTER FUNCTION public.auth_login_lookup(text,text) OWNER TO astrama_auth_reader;
ALTER FUNCTION public.auth_session_lookup(text) OWNER TO astrama_auth_reader;
