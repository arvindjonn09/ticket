ALTER TABLE public.inbound_mail_settings
  ADD COLUMN last_received_at timestamptz,
  ADD COLUMN forwarding_probe_hash text,
  ADD COLUMN forwarding_probe_started_at timestamptz,
  ADD COLUMN forwarding_verified_at timestamptz,
  ADD CONSTRAINT forwarding_probe_hash_format CHECK (forwarding_probe_hash IS NULL OR forwarding_probe_hash ~ '^[0-9a-f]{64}$');

-- Shared inbound domains must never turn unknown local-parts into a catch-all.
CREATE OR REPLACE FUNCTION public.resolve_inbound_address(normalized_address text)
RETURNS TABLE(tenant_id uuid,address_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT address.tenant_id,address.id
  FROM public.inbound_mail_addresses address
  JOIN public.tenants tenant ON tenant.id=address.tenant_id
    AND tenant.active AND tenant.status IN ('trial','active')
  WHERE address.address=lower(normalized_address) AND address.active
$$;
