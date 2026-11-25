-- Operator seat overrides survive renewals of the same plan.
CREATE OR REPLACE FUNCTION public.apply_billing_event(
  p_event_id text, p_event_type text, p_tenant_id uuid, p_plan_id text, p_customer_id text,
  p_subscription_id text, p_transition text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE inserted integer;
BEGIN
  INSERT INTO public.billing_provider_events(provider,event_id,event_type,processed_at)
  VALUES('stripe',p_event_id,p_event_type,now()) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted=0 THEN RETURN false; END IF;
  PERFORM 1 FROM public.tenants WHERE id=p_tenant_id FOR UPDATE;
  IF p_plan_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.billing_plans WHERE id=p_plan_id AND active
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.tenants
      WHERE id=p_tenant_id AND plan_id=p_plan_id
        AND stripe_subscription_id IS NOT NULL
        AND stripe_subscription_id=p_subscription_id
    ) THEN
      RAISE EXCEPTION 'billing plan is unavailable';
    END IF;
  END IF;
  IF p_transition='noop' THEN RETURN true; END IF;
  IF p_transition='activate' THEN
    UPDATE public.tenants SET status='active',read_only_reason=NULL,read_only_since=NULL,delete_after=NULL,
      plan_id=COALESCE(p_plan_id,plan_id),
      seat_limit=CASE WHEN plan_id IS NOT DISTINCT FROM COALESCE(p_plan_id,plan_id) THEN seat_limit ELSE COALESCE((SELECT seat_limit FROM public.billing_plans WHERE id=p_plan_id AND active),seat_limit) END,
      stripe_customer_id=COALESCE(p_customer_id,stripe_customer_id),
      stripe_subscription_id=COALESCE(p_subscription_id,stripe_subscription_id)
    WHERE id=p_tenant_id AND status IN ('trial','active','read_only')
      AND (status<>'read_only' OR read_only_reason IN ('trial_ended','payment_failed','cancelled'));
  ELSIF p_transition IN ('payment_failed','cancelled') THEN
    UPDATE public.tenants SET status='read_only',read_only_reason=p_transition,
      read_only_since=COALESCE(read_only_since,now()),
      delete_after=COALESCE(delete_after,now()+interval '45 days'),
      stripe_customer_id=COALESCE(p_customer_id,stripe_customer_id),
      stripe_subscription_id=COALESCE(p_subscription_id,stripe_subscription_id)
    WHERE id=p_tenant_id AND status IN ('trial','active','read_only')
      AND (status<>'read_only' OR read_only_reason IN ('trial_ended','payment_failed','cancelled'));
  ELSE
    RAISE EXCEPTION 'invalid billing transition';
  END IF;
  UPDATE public.billing_provider_events SET processed_at=now()
  WHERE provider='stripe' AND event_id=p_event_id;
  RETURN true;
END $$;
