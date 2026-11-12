ALTER TABLE tickets ADD COLUMN submitted_by_id uuid;
UPDATE tickets SET submitted_by_id=caller_id;
ALTER TABLE tickets ALTER COLUMN submitted_by_id SET NOT NULL;
ALTER TABLE tickets ADD CONSTRAINT tickets_tenant_id_submitted_by_id_fkey FOREIGN KEY(tenant_id,submitted_by_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Preserve direct database/legacy imports that predate separate submitter metadata.
-- API creation always supplies the authenticated actor explicitly.
CREATE FUNCTION public.ticket_default_submitter() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.submitted_by_id IS NULL THEN NEW.submitted_by_id:=NEW.caller_id; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ticket_default_submitter() FROM PUBLIC;
CREATE TRIGGER ticket_default_submitter BEFORE INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION public.ticket_default_submitter();
