CREATE UNIQUE INDEX sessions_tenant_id_id_key ON public.sessions(tenant_id,id);
CREATE TABLE public.user_import_previews (
 token_hash text PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL,
 session_id uuid NOT NULL,
 expires_at timestamptz NOT NULL,
 users jsonb NOT NULL CHECK (jsonb_typeof(users)='array' AND jsonb_array_length(users) BETWEEN 1 AND 100),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES public.users(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,session_id) REFERENCES public.sessions(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX user_import_previews_expiry ON public.user_import_previews(tenant_id,expires_at);
ALTER TABLE public.user_import_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_import_previews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.user_import_previews USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT,INSERT,DELETE ON public.user_import_previews TO astrama_app;

-- Infrastructure health only: never put tenant IDs, credentials or business content here.
CREATE TABLE public.operation_heartbeats (
 component text PRIMARY KEY CHECK(component IN ('worker','backup')),
 checked_at timestamptz NOT NULL DEFAULT now(),
 successful boolean NOT NULL
);
GRANT SELECT,INSERT,UPDATE ON public.operation_heartbeats TO astrama_app;
