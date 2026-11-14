CREATE TABLE public.notification_preferences (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  mode text NOT NULL DEFAULT 'immediate' CHECK (mode IN ('immediate','daily','off')),
  PRIMARY KEY (tenant_id,user_id),
  FOREIGN KEY (tenant_id,user_id) REFERENCES public.users(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.notification_preferences
  USING (tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON public.notification_preferences TO astrama_app;
GRANT SELECT ON public.notification_preferences TO astrama_auth_reader;

ALTER TABLE public.notification_deliveries DROP CONSTRAINT delivery_status_check;
ALTER TABLE public.notification_deliveries ADD CONSTRAINT delivery_status_check
  CHECK (status IN ('pending','deferred','sent','skipped') AND attempts >= 0);
CREATE INDEX notification_delivery_deferred_idx ON public.notification_deliveries(tenant_id,recipient_id,event_id)
  WHERE status='deferred';

CREATE FUNCTION public.pending_notification_digests()
RETURNS TABLE(tenant_id uuid,recipient_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT DISTINCT delivery.tenant_id,delivery.recipient_id
  FROM public.notification_deliveries delivery
  JOIN public.outbox event ON event.tenant_id=delivery.tenant_id AND event.id=delivery.event_id
  JOIN public.notification_preferences preference ON preference.tenant_id=delivery.tenant_id AND preference.user_id=delivery.recipient_id
  JOIN public.tenants tenant ON tenant.id=delivery.tenant_id AND tenant.active
  WHERE delivery.status='deferred' AND (preference.mode<>'daily' OR event.created_at < date_trunc('day',now()))
  ORDER BY delivery.tenant_id,delivery.recipient_id
  LIMIT 500
$$;
ALTER FUNCTION public.pending_notification_digests() OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.pending_notification_digests() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pending_notification_digests() TO astrama_app;
