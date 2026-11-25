ALTER TABLE public.tenant_mail_deliveries ALTER COLUMN tenant_id DROP NOT NULL;
CREATE POLICY platform_mail_delivery_insert ON public.tenant_mail_deliveries FOR INSERT TO astrama_app WITH CHECK(tenant_id IS NULL);
CREATE TABLE public.platform_mail_profiles (
  id uuid PRIMARY KEY,
  revision integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  settings jsonb NOT NULL CHECK (NOT settings ? 'password'),
  encrypted_password text NOT NULL,
  tested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.platform_mail_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  revision integer NOT NULL DEFAULT 0,
  active_profile_id uuid REFERENCES public.platform_mail_profiles(id),
  previous_profile_id uuid REFERENCES public.platform_mail_profiles(id),
  probe_hash text,
  probe_address text,
  probe_started_at timestamptz,
  probe_received_at timestamptz,
  intake_rejected bigint NOT NULL DEFAULT 0 CHECK(intake_rejected>=0)
);
INSERT INTO public.platform_mail_settings(id) VALUES(true);
ALTER TABLE public.platform_mail_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_mail_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.platform_mail_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_mail_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_mail_profiles,public.platform_mail_settings FROM PUBLIC,astrama_app;
GRANT SELECT,INSERT,UPDATE ON public.platform_mail_profiles,public.platform_mail_settings TO astrama_auth_reader;
GRANT USAGE,SELECT ON SEQUENCE public.platform_mail_profiles_revision_seq TO astrama_auth_reader;
CREATE POLICY platform_mail_privileged ON public.platform_mail_profiles TO astrama_auth_reader USING(true) WITH CHECK(true);
CREATE POLICY platform_mail_privileged ON public.platform_mail_settings TO astrama_auth_reader USING(true) WITH CHECK(true);
GRANT SELECT(id,operator_id,mfa_verified,expires_at,last_seen_at) ON public.operator_sessions TO astrama_auth_reader;
GRANT SELECT(mfa_enrolled) ON public.operators TO astrama_auth_reader;
CREATE POLICY platform_mail_session_check ON public.operator_sessions FOR SELECT TO astrama_auth_reader USING(true);
GRANT SELECT(status,created_at) ON public.tenant_mail_deliveries TO astrama_auth_reader;
CREATE POLICY platform_mail_health ON public.tenant_mail_deliveries FOR SELECT TO astrama_auth_reader USING(true);
GRANT SELECT(id,last_error) ON public.notification_deliveries TO astrama_auth_reader;

-- The runtime can retrieve only the current worker profile, never profile history/secrets.
CREATE FUNCTION public.active_platform_mail_profile() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT p.settings || jsonb_build_object('id',p.id,'revision',s.revision,'encryptedPassword',p.encrypted_password)
 FROM public.platform_mail_settings s JOIN public.platform_mail_profiles p ON p.id=s.active_profile_id
$$;
ALTER FUNCTION public.active_platform_mail_profile() OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.active_platform_mail_profile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.active_platform_mail_profile() TO astrama_app;

-- Owner actions require a currently valid, MFA-verified owner session, including reads/tests.
CREATE FUNCTION public.operator_platform_mail(p_session uuid,p_action text,p_input jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE op uuid; p public.platform_mail_profiles%ROWTYPE; s public.platform_mail_settings%ROWTYPE;
  sent bigint; failed bigint; bounces bigint; target uuid; result jsonb;
BEGIN
 SELECT o.id INTO op FROM public.operators o JOIN public.operator_sessions sess ON sess.operator_id=o.id
 WHERE sess.id=p_session AND o.active AND o.role='owner' AND o.mfa_enrolled AND sess.mfa_verified
   AND sess.expires_at>now() AND sess.last_seen_at>now()-interval '15 minutes';
 IF op IS NULL THEN RAISE EXCEPTION 'owner operator required' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM public.platform_mail_settings WHERE id=true;
 IF p_action='view' THEN
   SELECT count(*) FILTER(WHERE status='sent'),count(*) FILTER(WHERE status='failed') INTO sent,failed
     FROM public.tenant_mail_deliveries WHERE created_at>now()-interval '24 hours';
   -- These are previously accepted provider/webhook bounce reports, not independently verified DSNs.
   SELECT count(*) INTO bounces FROM public.notification_deliveries
     WHERE last_error='Delivery bounce received' AND delivered_at>now()-interval '24 hours';
   SELECT jsonb_build_object('revision',s.revision,'activeProfileId',s.active_profile_id,'previousProfileId',s.previous_profile_id,
     'profiles',COALESCE((SELECT jsonb_agg(settings || jsonb_build_object('id',id,'revision',revision,'passwordSet',true,
       'testedAt',tested_at,'active',COALESCE(id=s.active_profile_id,false)) ORDER BY revision DESC) FROM public.platform_mail_profiles),'[]'::jsonb),
     'health',jsonb_build_object('sent',sent,'failed',failed,'bounceRate',CASE WHEN sent>0 THEN bounces::numeric/sent ELSE NULL END,
       'junkRisk',sent>0 AND bounces::numeric/sent>0.05),
     'receiving',jsonb_build_object('lastReceivedAt',GREATEST((SELECT max(received_at) FROM public.inbound_messages),s.probe_received_at),
       'queueDepth',(SELECT count(*) FROM public.inbound_messages WHERE status IN ('queued','processing','failed')),
       'rejected',s.intake_rejected,
       'testStatus',CASE WHEN s.probe_started_at IS NULL THEN NULL WHEN s.probe_received_at>=s.probe_started_at THEN 'working'
         WHEN s.probe_started_at<now()-interval '10 minutes' THEN 'problem' ELSE 'pending' END)) INTO result;
   RETURN result;
 ELSIF p_action='save' THEN
   INSERT INTO public.platform_mail_profiles(id,settings,encrypted_password)
     VALUES((p_input->>'id')::uuid,p_input->'settings',p_input->>'encryptedPassword') RETURNING * INTO p;
   INSERT INTO public.operator_audits(id,operator_id,action,reason,detail) VALUES(gen_random_uuid(),op,'platform_email.profile_saved',
     'Created immutable SMTP profile',jsonb_build_object('profileId',p.id));
   RETURN p.settings || jsonb_build_object('id',p.id,'revision',p.revision,'passwordSet',true,'testedAt',p.tested_at,'active',false);
 ELSIF p_action IN ('test-profile','tested','dns-profile') THEN
   SELECT * INTO p FROM public.platform_mail_profiles WHERE id=(p_input->>'id')::uuid;
   IF p.id IS NULL THEN RAISE EXCEPTION 'profile not found' USING ERRCODE='P0002'; END IF;
   IF p_action='tested' THEN
     UPDATE public.platform_mail_profiles SET tested_at=clock_timestamp() WHERE id=p.id;
     INSERT INTO public.operator_audits(id,operator_id,action,reason,detail) VALUES(gen_random_uuid(),op,'platform_email.profile_tested',
       'SMTP test succeeded',jsonb_build_object('profileId',p.id));
     RETURN '{"ok":true}'::jsonb;
   END IF;
   RETURN p.settings || jsonb_build_object('id',p.id,'revision',p.revision) || CASE WHEN p_action='test-profile'
     THEN jsonb_build_object('encryptedPassword',p.encrypted_password) ELSE '{}'::jsonb END;
 ELSIF p_action IN ('activate','rollback') THEN
   SELECT * INTO s FROM public.platform_mail_settings WHERE id=true FOR UPDATE;
   IF s.revision IS DISTINCT FROM (p_input->>'revision')::integer THEN
     RAISE EXCEPTION 'mail settings changed' USING ERRCODE='40001';
   END IF;
   IF length(trim(p_input->>'reason')) NOT BETWEEN 10 AND 1000 OR p_input->>'reason' IS NULL THEN RAISE EXCEPTION 'reason required'; END IF;
   target := CASE WHEN p_action='rollback' THEN s.previous_profile_id ELSE (p_input->>'profileId')::uuid END;
   IF target IS NULL THEN
     IF p_action<>'rollback' OR s.active_profile_id IS NULL THEN RAISE EXCEPTION 'no previous profile' USING ERRCODE='P0002'; END IF;
   ELSE
     SELECT * INTO p FROM public.platform_mail_profiles WHERE id=target;
     IF p.id IS NULL THEN RAISE EXCEPTION 'profile not found' USING ERRCODE='P0002'; END IF;
     IF p.tested_at IS NULL THEN RAISE EXCEPTION 'test profile before activation' USING ERRCODE='23514'; END IF;
   END IF;
   IF target IS NOT DISTINCT FROM s.active_profile_id THEN RAISE EXCEPTION 'profile already active' USING ERRCODE='23514'; END IF;
   UPDATE public.platform_mail_settings SET active_profile_id=target,previous_profile_id=s.active_profile_id,revision=revision+1 WHERE id=true;
   INSERT INTO public.operator_audits(id,operator_id,action,reason,detail) VALUES(gen_random_uuid(),op,'platform_email.'||p_action,
     p_input->>'reason',jsonb_build_object('profileId',target,'previousProfileId',s.active_profile_id,'revision',s.revision+1));
   RETURN jsonb_build_object('revision',s.revision+1);
 ELSIF p_action='probe' THEN
   IF NOT EXISTS(SELECT 1 FROM public.resolve_inbound_address(p_input->>'address')) THEN
     RAISE EXCEPTION 'known intake address required' USING ERRCODE='23514'; END IF;
   UPDATE public.platform_mail_settings SET probe_hash=p_input->>'hash',probe_address=p_input->>'address',
     probe_started_at=clock_timestamp(),probe_received_at=NULL WHERE id=true;
   RETURN '{"status":"pending"}'::jsonb;
 END IF;
 RAISE EXCEPTION 'invalid platform mail action';
END $$;
ALTER FUNCTION public.operator_platform_mail(uuid,text,jsonb) OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.operator_platform_mail(uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_platform_mail(uuid,text,jsonb) TO astrama_app;

CREATE FUNCTION public.consume_platform_mail_probe(p_hash text,p_address text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 UPDATE public.platform_mail_settings SET probe_received_at=clock_timestamp()
 WHERE id=true AND probe_hash=p_hash AND probe_address=p_address AND probe_started_at>now()-interval '10 minutes';
 RETURN FOUND;
END $$;
ALTER FUNCTION public.consume_platform_mail_probe(text,text) OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.consume_platform_mail_probe(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_platform_mail_probe(text,text) TO astrama_app;

-- Intake batches an anonymous count; no recipient, sender or rejection text is retained.
CREATE FUNCTION public.record_platform_mail_rejection(p_count bigint DEFAULT 1) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF p_count IS NULL OR p_count<=0 THEN RAISE EXCEPTION 'positive rejection count required' USING ERRCODE='23514'; END IF;
 UPDATE public.platform_mail_settings SET intake_rejected=intake_rejected+p_count WHERE id=true;
END $$;
ALTER FUNCTION public.record_platform_mail_rejection(bigint) OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.record_platform_mail_rejection(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_platform_mail_rejection(bigint) TO astrama_app;
