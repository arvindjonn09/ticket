CREATE FUNCTION public.resolve_active_tenant_host(host_slug text)
RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT tenant.id
  FROM public.tenants tenant
  WHERE tenant.slug=lower(host_slug) AND tenant.active
$$;
ALTER FUNCTION public.resolve_active_tenant_host(text) OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.resolve_active_tenant_host(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_active_tenant_host(text) TO astrama_app;
