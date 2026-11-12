-- The NOLOGIN function owner needs an explicit SELECT policy under FORCE RLS.
-- Runtime roles can only call the metadata-only dispatcher function, never inherit this role.
CREATE POLICY outbox_dispatch_lookup ON public.outbox
FOR SELECT TO astrama_auth_reader USING (true);
