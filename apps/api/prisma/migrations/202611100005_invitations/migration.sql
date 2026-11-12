CREATE FUNCTION public.auth_invitation_lookup(invitation_hash text, organisation_slug text)
RETURNS TABLE(id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.id, u.tenant_id FROM public.users u JOIN public.tenants t ON t.id=u.tenant_id
  WHERE u.invitation_hash=auth_invitation_lookup.invitation_hash
    AND u.invitation_expires_at > now() AND NOT u.active AND t.active AND t.slug=organisation_slug
$$;
ALTER FUNCTION public.auth_invitation_lookup(text,text) OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.auth_invitation_lookup(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_invitation_lookup(text,text) TO astrama_app;
