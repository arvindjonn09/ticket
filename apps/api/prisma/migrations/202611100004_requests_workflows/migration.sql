-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "allow_incidents" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allow_requests" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "queue_owner_id" UUID,
ADD COLUMN     "substitute_id" UUID;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'en-AU',
ADD COLUMN     "primary_colour" TEXT NOT NULL DEFAULT '#2563eb',
ADD COLUMN     "request_prefix" TEXT NOT NULL DEFAULT 'SR',
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Australia/Sydney';

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "approval_correction_reason" TEXT,
ADD COLUMN     "approval_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'Self Service',
ADD COLUMN     "currency" TEXT,
ADD COLUMN     "duplicate_of_id" UUID,
ADD COLUMN     "hold_reason" TEXT,
ADD COLUMN     "item_id" UUID,
ADD COLUMN     "justification" TEXT,
ADD COLUMN     "previous_state" TEXT,
ADD COLUMN     "quantity" INTEGER,
ADD COLUMN     "requested_for_id" UUID,
ADD COLUMN     "total_cost_minor" INTEGER,
ADD COLUMN     "unit_cost_minor" INTEGER,
ADD COLUMN     "untriaged" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "approver_eligible" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "home_department" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "invitation_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "invitation_hash" TEXT,
ADD COLUMN     "invited_at" TIMESTAMPTZ(6),
ADD COLUMN     "is_vp" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "job_title" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "manager_id" UUID,
ADD COLUMN     "phone" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "catalog_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "unit_cost_minor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "recurring_period" TEXT,
    "requires_manager" BOOLEAN NOT NULL DEFAULT false,
    "requires_vp" BOOLEAN NOT NULL DEFAULT false,
    "vp_threshold_minor" INTEGER,
    "vp_approver_id" UUID,
    "alternate_approver_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "version" INTEGER NOT NULL,
    "approver_id" UUID,
    "decided_by_id" UUID,
    "correction_reason" TEXT,
    "comment" TEXT,
    "decided_at" TIMESTAMPTZ(6),

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_delegations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "approver_id" UUID NOT NULL,
    "delegate_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "approval_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "audience" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'quarantined',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "delivered_at" TIMESTAMPTZ(6),

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "catalog_items_tenant_id_id_key" ON "catalog_items"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_items_tenant_id_name_key" ON "catalog_items"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "approvals_tenant_id_approver_id_status_idx" ON "approvals"("tenant_id", "approver_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "approvals_tenant_id_ticket_id_version_stage_key" ON "approvals"("tenant_id", "ticket_id", "version", "stage");

-- CreateIndex
CREATE INDEX "approval_delegations_tenant_id_approver_id_starts_at_ends_a_idx" ON "approval_delegations"("tenant_id", "approver_id", "starts_at", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_storage_key_key" ON "attachments"("storage_key");

-- CreateIndex
CREATE INDEX "attachments_tenant_id_ticket_id_idx" ON "attachments"("tenant_id", "ticket_id");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_tenant_id_id_key" ON "attachments"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_tenant_id_event_id_recipient_id_key" ON "notification_deliveries"("tenant_id", "event_id", "recipient_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_invitation_hash_key" ON "users"("invitation_hash");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_manager_id_fkey" FOREIGN KEY ("tenant_id", "manager_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_queue_owner_id_fkey" FOREIGN KEY ("tenant_id", "queue_owner_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_substitute_id_fkey" FOREIGN KEY ("tenant_id", "substitute_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_requested_for_id_fkey" FOREIGN KEY ("tenant_id", "requested_for_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_item_id_fkey" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "catalog_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_duplicate_of_id_fkey" FOREIGN KEY ("tenant_id", "duplicate_of_id") REFERENCES "tickets"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_tenant_id_vp_approver_id_fkey" FOREIGN KEY ("tenant_id", "vp_approver_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_tenant_id_alternate_approver_id_fkey" FOREIGN KEY ("tenant_id", "alternate_approver_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_id_ticket_id_fkey" FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_id_approver_id_fkey" FOREIGN KEY ("tenant_id", "approver_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_id_decided_by_id_fkey" FOREIGN KEY ("tenant_id", "decided_by_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_tenant_id_approver_id_fkey" FOREIGN KEY ("tenant_id", "approver_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_tenant_id_delegate_id_fkey" FOREIGN KEY ("tenant_id", "delegate_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_tenant_id_ticket_id_fkey" FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_tenant_id_author_id_fkey" FOREIGN KEY ("tenant_id", "author_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenant_id_event_id_fkey" FOREIGN KEY ("tenant_id", "event_id") REFERENCES "outbox"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenant_id_recipient_id_fkey" FOREIGN KEY ("tenant_id", "recipient_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE tickets DROP CONSTRAINT ticket_state_check;
ALTER TABLE tickets ADD CONSTRAINT ticket_state_check CHECK (state IN ('Open','Pending Approval','In Progress','On Hold','Resolved','Complete','Cancelled','Rejected'));
ALTER TABLE tickets DROP CONSTRAINT ticket_sequence_check;
ALTER TABLE tickets ADD CONSTRAINT ticket_sequence_check CHECK (sequence > 0 AND revision >= 0 AND type IN ('incident','request'));
ALTER TABLE tickets ADD CONSTRAINT ticket_request_check CHECK (type <> 'request' OR (item_id IS NOT NULL AND requested_for_id IS NOT NULL AND quantity > 0 AND unit_cost_minor >= 0 AND total_cost_minor >= 0 AND total_cost_minor::bigint = quantity::bigint * unit_cost_minor::bigint AND currency ~ '^[A-Z]{3}$'));
ALTER TABLE tickets ADD CONSTRAINT ticket_channel_check CHECK (channel IN ('Email','Phone','Self Service','Walk In'));
ALTER TABLE users ADD CONSTRAINT user_manager_check CHECK (manager_id IS NULL OR manager_id <> id);
ALTER TABLE catalog_items ADD CONSTRAINT catalog_cost_check CHECK (unit_cost_minor >= 0 AND (vp_threshold_minor IS NULL OR vp_threshold_minor >= 0) AND currency ~ '^[A-Z]{3}$' AND revision >= 0);
ALTER TABLE approvals ADD CONSTRAINT approval_status_check CHECK (status IN ('Pending','Approved','Rejected','Invalidated') AND stage IN ('manager','vp') AND version > 0 AND (status NOT IN ('Approved','Rejected') OR (decided_by_id IS NOT NULL AND decided_at IS NOT NULL)) AND (status <> 'Rejected' OR length(trim(comment)) > 0));
ALTER TABLE approval_delegations ADD CONSTRAINT delegation_period_check CHECK (starts_at < ends_at AND approver_id <> delegate_id AND revision >= 0);
ALTER TABLE attachments ADD CONSTRAINT attachment_policy_check CHECK (size >= 0 AND audience IN ('customer','internal') AND status IN ('quarantined','clean','rejected'));
ALTER TABLE notification_deliveries ADD CONSTRAINT delivery_status_check CHECK (status IN ('pending','sent','skipped') AND attempts >= 0);

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['catalog_items','approvals','approval_delegations','attachments','notification_deliveries'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I USING (tenant_id::text=current_setting(''app.tenant_id'',true)) WITH CHECK (tenant_id::text=current_setting(''app.tenant_id'',true))',table_name);
  END LOOP;
END $$;

CREATE FUNCTION public.pending_outbox_events()
RETURNS TABLE(tenant_id uuid,id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT o.tenant_id,o.id FROM public.outbox o JOIN public.tenants t ON t.id=o.tenant_id WHERE o.published_at IS NULL AND t.active ORDER BY o.created_at,o.id LIMIT 100
$$;
REVOKE ALL ON FUNCTION public.pending_outbox_events() FROM PUBLIC;
GRANT SELECT ON public.outbox TO astrama_auth_reader;
ALTER FUNCTION public.pending_outbox_events() OWNER TO astrama_auth_reader;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='astrama_app') THEN
 GRANT SELECT,INSERT,UPDATE,DELETE ON catalog_items,approvals,approval_delegations,attachments,notification_deliveries TO astrama_app;
 GRANT UPDATE(published_at,attempts) ON outbox TO astrama_app;
 GRANT UPDATE(request_prefix,timezone,locale,primary_colour,revision) ON tenants TO astrama_app;
 GRANT UPDATE(manager_id,approver_eligible,is_vp,revision,home_department,phone,job_title,invitation_hash,invitation_expires_at,invited_at,updated_at) ON users TO astrama_app;
 GRANT EXECUTE ON FUNCTION public.pending_outbox_events() TO astrama_app;
END IF; END $$;

