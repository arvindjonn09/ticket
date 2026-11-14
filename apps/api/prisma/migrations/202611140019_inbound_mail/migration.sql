ALTER TABLE public.tickets
  ADD COLUMN inbound_sender_email text,
  ADD COLUMN inbound_unverified boolean NOT NULL DEFAULT false,
  ADD COLUMN inbound_reply_address text;

ALTER TABLE public.notification_deliveries
  ADD COLUMN reply_token_hash text UNIQUE;

CREATE TABLE public.inbound_mail_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  triage_department_id uuid NOT NULL,
  triage_category_id uuid NOT NULL,
  encrypted_webhook_secret text,
  allow_unverified_senders boolean NOT NULL DEFAULT false,
  FOREIGN KEY (tenant_id,triage_department_id) REFERENCES public.departments(tenant_id,id),
  FOREIGN KEY (tenant_id,triage_category_id) REFERENCES public.categories(tenant_id,id)
);
ALTER TABLE public.inbound_mail_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_mail_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.inbound_mail_settings
  USING (tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT,INSERT,UPDATE ON public.inbound_mail_settings TO astrama_app;

CREATE TABLE public.inbound_mail_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  address text NOT NULL UNIQUE CHECK (address=lower(address)),
  department_id uuid NOT NULL,
  category_id uuid NOT NULL,
  is_general boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,department_id) REFERENCES public.departments(tenant_id,id),
  FOREIGN KEY (tenant_id,category_id) REFERENCES public.categories(tenant_id,id),
  CHECK (address ~ '^[^@[:space:]]+@[^@[:space:]]+$')
);
ALTER TABLE public.inbound_mail_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_mail_addresses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.inbound_mail_addresses
  USING (tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY inbound_lookup ON public.inbound_mail_addresses FOR SELECT TO astrama_auth_reader USING (true);
GRANT SELECT ON public.inbound_mail_addresses TO astrama_auth_reader;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.inbound_mail_addresses TO astrama_app;
CREATE UNIQUE INDEX inbound_mail_one_general_address ON public.inbound_mail_addresses(tenant_id) WHERE is_general AND active;

CREATE TABLE public.inbound_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  message_id text NOT NULL,
  recipient text NOT NULL,
  sender_email text NOT NULL,
  in_reply_to text,
  references_header text[] NOT NULL DEFAULT '{}',
  subject text NOT NULL,
  text_body text NOT NULL,
  html_body text,
  headers jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(headers)='object'),
  reply_token_hash text,
  kind text NOT NULL DEFAULT 'delivery' CHECK (kind IN ('delivery','bounce')),
  bounce_for text,
  auth_results jsonb NOT NULL CHECK (jsonb_typeof(auth_results)='object'),
  attachments jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(attachments)='array'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','processed','ignored','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  ticket_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (tenant_id,message_id),
  FOREIGN KEY (tenant_id,ticket_id) REFERENCES public.tickets(tenant_id,id)
);
ALTER TABLE public.inbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.inbound_messages
  USING (tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY inbound_dispatch_lookup ON public.inbound_messages FOR SELECT TO astrama_auth_reader USING (true);
GRANT SELECT ON public.inbound_messages TO astrama_auth_reader;
GRANT SELECT,INSERT,UPDATE ON public.inbound_messages TO astrama_app;
CREATE INDEX inbound_messages_pending_idx ON public.inbound_messages(tenant_id,next_attempt_at,id)
  WHERE status IN ('queued','failed');

CREATE TABLE public.inbound_sender_rates (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  sender_hash text NOT NULL,
  window_started_at timestamptz NOT NULL,
  message_count integer NOT NULL CHECK (message_count >= 0),
  PRIMARY KEY (tenant_id,sender_hash)
);
ALTER TABLE public.inbound_sender_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_sender_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.inbound_sender_rates
  USING (tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON public.inbound_sender_rates TO astrama_app;

CREATE FUNCTION public.resolve_inbound_address(normalized_address text)
RETURNS TABLE(tenant_id uuid,address_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  WITH exact_match AS (
    SELECT address.tenant_id,address.id AS address_id,0 AS priority
    FROM public.inbound_mail_addresses address
    JOIN public.tenants tenant ON tenant.id=address.tenant_id AND tenant.active
    WHERE address.address=lower(normalized_address)
  ), domain_match AS (
    SELECT min(address.tenant_id::text)::uuid AS tenant_id,NULL::uuid AS address_id,1 AS priority
    FROM public.inbound_mail_addresses address
    JOIN public.tenants tenant ON tenant.id=address.tenant_id AND tenant.active
    WHERE split_part(address.address,'@',2)=split_part(lower(normalized_address),'@',2)
    GROUP BY split_part(address.address,'@',2)
    HAVING count(DISTINCT address.tenant_id)=1
  )
  SELECT candidate.tenant_id,candidate.address_id
  FROM (SELECT * FROM exact_match UNION ALL SELECT * FROM domain_match) candidate
  ORDER BY candidate.priority LIMIT 1
$$;
ALTER FUNCTION public.resolve_inbound_address(text) OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.resolve_inbound_address(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_inbound_address(text) TO astrama_app;

CREATE FUNCTION public.pending_inbound_messages()
RETURNS TABLE(tenant_id uuid,id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT message.tenant_id,message.id
  FROM public.inbound_messages message
  JOIN public.tenants tenant ON tenant.id=message.tenant_id AND tenant.active
  WHERE message.status IN ('queued','failed') AND message.next_attempt_at<=now()
  ORDER BY message.next_attempt_at,message.id
  LIMIT 500
$$;
ALTER FUNCTION public.pending_inbound_messages() OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.pending_inbound_messages() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pending_inbound_messages() TO astrama_app;
