ALTER TABLE public.signup_requests
  ADD COLUMN terms_accepted_at timestamptz,
  ADD COLUMN privacy_accepted_at timestamptz;

CREATE FUNCTION public.public_organisation_links(p_email text)
RETURNS TABLE(slug text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT DISTINCT t.slug
  FROM public.users u
  JOIN public.tenants t ON t.id=u.tenant_id
  WHERE lower(u.email)=lower(p_email)
    AND u.active
    AND t.active
    AND t.status IN ('trial','active','read_only')
  ORDER BY t.slug
$$;
ALTER FUNCTION public.public_organisation_links(text) OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.public_organisation_links(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_organisation_links(text) TO astrama_app;
