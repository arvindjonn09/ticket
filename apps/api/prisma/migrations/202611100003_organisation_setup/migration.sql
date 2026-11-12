-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "mfa_verified" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "subcategory_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mfa_enrolled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mfa_failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mfa_last_step" INTEGER NOT NULL DEFAULT -1,
ADD COLUMN     "mfa_locked_until" TIMESTAMPTZ(6),
ADD COLUMN     "mfa_pending_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "mfa_pending_session_id" UUID,
ADD COLUMN     "mfa_secret" TEXT;

-- CreateTable
CREATE TABLE "subcategories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "department_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "subcategories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "config_audits" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "config_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subcategories_tenant_id_id_key" ON "subcategories"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subcategories_tenant_id_category_id_id_key" ON "subcategories"("tenant_id", "category_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subcategories_tenant_id_category_id_name_key" ON "subcategories"("tenant_id", "category_id", "name");

-- CreateIndex
CREATE INDEX "config_audits_tenant_id_created_at_idx" ON "config_audits"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_category_id_subcategory_id_fkey" FOREIGN KEY ("tenant_id", "category_id", "subcategory_id") REFERENCES "subcategories"("tenant_id", "category_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcategories" ADD CONSTRAINT "subcategories_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcategories" ADD CONSTRAINT "subcategories_tenant_id_department_id_fkey" FOREIGN KEY ("tenant_id", "department_id") REFERENCES "departments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "config_audits" ADD CONSTRAINT "config_audits_tenant_id_actor_id_fkey" FOREIGN KEY ("tenant_id", "actor_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('employee','agent','admin'));
ALTER TABLE subcategories ADD CONSTRAINT subcategory_revision_check CHECK (revision >= 0);
ALTER TABLE departments ADD CONSTRAINT department_revision_check CHECK (revision >= 0);
ALTER TABLE users ADD CONSTRAINT mfa_enrolment_check CHECK (NOT mfa_enrolled OR mfa_secret IS NOT NULL);
ALTER TABLE subcategories ENABLE ROW LEVEL SECURITY;
ALTER TABLE subcategories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subcategories USING (tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE config_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_audits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON config_audits USING (tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
DROP FUNCTION public.auth_session_lookup(text);
CREATE FUNCTION public.auth_session_lookup(session_token_hash text)
RETURNS TABLE(id uuid, tenant_id uuid, name text, email text, role text, tenant_name text, slug text, brand_name text, session_id uuid, csrf_token text, department_ids uuid[], mfa_verified boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.id, u.tenant_id, u.name, u.email, u.role, t.name, t.slug, t.brand_name, s.id, s.csrf_token,
    ARRAY(SELECT m.department_id FROM public.memberships m JOIN public.departments d ON d.tenant_id=m.tenant_id AND d.id=m.department_id WHERE m.tenant_id=u.tenant_id AND m.user_id=u.id AND d.active), s.mfa_verified AND u.mfa_enrolled
  FROM public.sessions s JOIN public.users u ON u.tenant_id=s.tenant_id AND u.id=s.user_id JOIN public.tenants t ON t.id=u.tenant_id
  WHERE s.token_hash=session_token_hash AND s.expires_at > now() AND u.active AND t.active
    AND s.last_seen_at > now() - CASE WHEN u.role IN ('agent','admin') THEN interval '30 minutes' ELSE interval '8 hours' END
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.auth_session_lookup(text) FROM PUBLIC;

ALTER FUNCTION public.auth_session_lookup(text) OWNER TO astrama_auth_reader;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='astrama_app') THEN
  GRANT SELECT, INSERT, UPDATE, DELETE ON departments, memberships, categories, subcategories TO astrama_app;
  GRANT SELECT, INSERT ON config_audits TO astrama_app;
  GRANT UPDATE(mfa_secret,mfa_enrolled,mfa_last_step,mfa_failures,mfa_locked_until,mfa_pending_session_id,mfa_pending_expires_at) ON users TO astrama_app;
  GRANT EXECUTE ON FUNCTION auth_session_lookup(text) TO astrama_app;
 END IF;
END $$;
