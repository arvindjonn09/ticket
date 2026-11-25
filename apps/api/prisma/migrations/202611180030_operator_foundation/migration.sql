-- SA-05 operator identity and metadata foundation.
-- Operators belong to no tenant. Cross-tenant metadata is exposed only through a
-- SECURITY DEFINER function owned by the non-login astrama_auth_reader role.

CREATE TABLE public.operators (
  id uuid NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  encrypted_mfa_secret text,
  mfa_enrolled boolean NOT NULL DEFAULT false,
  mfa_last_step integer NOT NULL DEFAULT -1,
  mfa_failures integer NOT NULL DEFAULT 0,
  mfa_locked_until timestamptz(6),
  mfa_pending_session_id uuid,
  mfa_pending_expires_at timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT operators_pkey PRIMARY KEY (id),
  CONSTRAINT operators_role_check CHECK (role IN ('support','owner')),
  CONSTRAINT operators_email_check CHECK (email=lower(email) AND position('@' in email)>1),
  CONSTRAINT operators_mfa_counters_check CHECK (mfa_last_step >= -1 AND mfa_failures >= 0),
  CONSTRAINT operators_mfa_enrolment_check CHECK (NOT mfa_enrolled OR encrypted_mfa_secret IS NOT NULL)
);
CREATE UNIQUE INDEX operators_email_key ON public.operators(email);

CREATE TABLE public.operator_sessions (
  id uuid NOT NULL,
  operator_id uuid NOT NULL,
  token_hash text NOT NULL,
  csrf_token text NOT NULL,
  mfa_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz(6) NOT NULL,
  CONSTRAINT operator_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT operator_sessions_operator_id_fkey FOREIGN KEY (operator_id)
    REFERENCES public.operators(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX operator_sessions_token_hash_key ON public.operator_sessions(token_hash);
CREATE INDEX operator_sessions_operator_id_idx ON public.operator_sessions(operator_id);

CREATE TABLE public.operator_audits (
  id uuid NOT NULL,
  operator_id uuid NOT NULL,
  tenant_id uuid,
  tenant_slug text,
  action text NOT NULL,
  reason text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT operator_audits_pkey PRIMARY KEY (id),
  CONSTRAINT operator_audits_operator_id_fkey FOREIGN KEY (operator_id)
    REFERENCES public.operators(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT operator_audits_detail_check CHECK (jsonb_typeof(detail)='object')
);
CREATE INDEX operator_audits_tenant_id_created_at_idx ON public.operator_audits(tenant_id,created_at);
CREATE INDEX operator_audits_operator_id_created_at_idx ON public.operator_audits(operator_id,created_at);

CREATE TABLE public.operator_support_grants (
  id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
  tenant_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  granted_by_id uuid NOT NULL,
  expires_at timestamptz(6) NOT NULL,
  revoked_at timestamptz(6),
  reason text NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT operator_support_grants_pkey PRIMARY KEY (id),
  CONSTRAINT operator_support_grants_tenant_id_fkey FOREIGN KEY (tenant_id)
    REFERENCES public.tenants(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT operator_support_grants_operator_id_fkey FOREIGN KEY (operator_id)
    REFERENCES public.operators(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT operator_support_grants_tenant_id_granted_by_id_fkey FOREIGN KEY (tenant_id,granted_by_id)
    REFERENCES public.users(tenant_id,id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT operator_support_grants_period_check CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX operator_support_grants_tenant_id_operator_id_key
  ON public.operator_support_grants(tenant_id,operator_id);
CREATE INDEX operator_support_grants_operator_id_idx ON public.operator_support_grants(operator_id);

ALTER TABLE public.operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operators FORCE ROW LEVEL SECURITY;
CREATE POLICY operators_app ON public.operators FOR ALL TO astrama_app
  USING (true) WITH CHECK (true);
CREATE POLICY operators_metadata ON public.operators FOR SELECT TO astrama_auth_reader
  USING (true);

ALTER TABLE public.operator_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_sessions_app ON public.operator_sessions FOR ALL TO astrama_app
  USING (true) WITH CHECK (true);

ALTER TABLE public.operator_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_audits FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_audits_app ON public.operator_audits FOR ALL TO astrama_app
  USING (true) WITH CHECK (true);
CREATE POLICY operator_audits_metadata ON public.operator_audits FOR SELECT TO astrama_auth_reader
  USING (true);

ALTER TABLE public.operator_support_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_support_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_support_grants_scope ON public.operator_support_grants
  USING (tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));

CREATE FUNCTION public.reject_operator_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'operator audit rows are append-only';
END
$$;
REVOKE ALL ON FUNCTION public.reject_operator_audit_mutation() FROM PUBLIC;
CREATE TRIGGER operator_audit_append_only BEFORE UPDATE OR DELETE ON public.operator_audits
FOR EACH ROW EXECUTE FUNCTION public.reject_operator_audit_mutation();

REVOKE ALL ON public.operators, public.operator_sessions, public.operator_audits,
  public.operator_support_grants FROM PUBLIC;
GRANT SELECT,INSERT ON public.operators TO astrama_app;
GRANT UPDATE(name,email,password_hash,role,active,encrypted_mfa_secret,mfa_enrolled,
  mfa_last_step,mfa_failures,mfa_locked_until,mfa_pending_session_id,mfa_pending_expires_at)
  ON public.operators TO astrama_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.operator_sessions TO astrama_app;
GRANT SELECT,INSERT ON public.operator_audits TO astrama_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.operator_support_grants TO astrama_app;

-- The metadata function owner may read only the columns it needs, never ticket
-- text, message bodies, attachment names, credentials, tokens, or audit details.
GRANT SELECT(id,active) ON public.operators TO astrama_auth_reader;
GRANT SELECT(tenant_id,old_status,new_status,changed_at) ON public.tenant_status_audits TO astrama_auth_reader;
GRANT SELECT(tenant_id,created_at) ON public.activities TO astrama_auth_reader;
CREATE POLICY metadata_lookup ON public.activities FOR SELECT TO astrama_auth_reader USING (true);
GRANT SELECT(tenant_id,created_at) ON public.audits TO astrama_auth_reader;
CREATE POLICY metadata_lookup ON public.audits FOR SELECT TO astrama_auth_reader USING (true);
GRANT SELECT(tenant_id,action,created_at) ON public.config_audits TO astrama_auth_reader;
CREATE POLICY metadata_lookup ON public.config_audits FOR SELECT TO astrama_auth_reader USING (true);
GRANT SELECT(tenant_id,size,status) ON public.attachments TO astrama_auth_reader;
CREATE POLICY metadata_lookup ON public.attachments FOR SELECT TO astrama_auth_reader USING (true);
GRANT SELECT(tenant_id,status,attempts,delivered_at) ON public.notification_deliveries TO astrama_auth_reader;
CREATE POLICY metadata_lookup ON public.notification_deliveries FOR SELECT TO astrama_auth_reader USING (true);
GRANT SELECT(tenant_id,action,created_at) ON public.operator_audits TO astrama_auth_reader;

CREATE FUNCTION public.operator_organisation_metadata(
  p_operator_id uuid,
  p_search text DEFAULT '',
  p_tenant_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_search text := lower(coalesce(p_search,''));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.operators o WHERE o.id=p_operator_id AND o.active) THEN
    RAISE EXCEPTION 'operator is unknown or inactive' USING ERRCODE='42501';
  END IF;

  IF p_tenant_id IS NOT NULL THEN
    RETURN COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', t.id,
        'slug', t.slug,
        'name', t.name,
        'status', t.status,
        'active', t.active,
        'planId', t.plan_id,
        'seatLimit', t.seat_limit,
        'revision', t.revision,
        'seatsUsed', (
          SELECT count(*) FROM public.users u
          WHERE u.tenant_id=t.id AND u.role<>'system' AND (u.active OR (u.invitation_hash IS NOT NULL AND u.invitation_expires_at>now()))
        ),
        'createdAt', (
          SELECT min(a.changed_at) FROM public.tenant_status_audits a
          WHERE a.tenant_id=t.id
        ),
        'lastActivity', GREATEST(
          (SELECT max(x.created_at) FROM public.activities x WHERE x.tenant_id=t.id),
          (SELECT max(x.created_at) FROM public.audits x WHERE x.tenant_id=t.id),
          (SELECT max(x.created_at) FROM public.config_audits x WHERE x.tenant_id=t.id),
          (SELECT max(x.changed_at) FROM public.tenant_status_audits x WHERE x.tenant_id=t.id),
          (SELECT max(x.created_at) FROM public.operator_audits x WHERE x.tenant_id=t.id AND x.action LIKE 'operator.%')
        ),
        'trialEndsAt', t.trial_ends_at,
        'deleteAfter', t.delete_after,
        'adminContacts', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', u.id,
            'name', u.name,
            'email', u.email,
            'active', u.active,
            'mfaEnrolled', u.mfa_enrolled
          ) ORDER BY u.name, u.id)
          FROM public.users u
          WHERE u.tenant_id=t.id AND u.role='admin'
        ), '[]'::jsonb),
        'health', jsonb_build_object(
          'outboxBacklog', (
            SELECT count(*) FROM public.outbox o
            WHERE o.tenant_id=t.id AND o.published_at IS NULL
          ),
          'failedJobs', (
            (SELECT count(*) FROM public.outbox o
             WHERE o.tenant_id=t.id AND o.published_at IS NULL AND o.attempts>0)
            + (SELECT count(*) FROM public.notification_deliveries d
             WHERE d.tenant_id=t.id AND d.status='pending' AND d.attempts>0)
            + (SELECT count(*) FROM public.inbound_messages i
               WHERE i.tenant_id=t.id AND i.status='failed')
          ),
          'lastEmailDelivered', GREATEST(
            (SELECT max(m.sent_at) FROM public.invitation_mails m
             WHERE m.tenant_id=t.id AND m.status='sent'),
            (SELECT max(d.delivered_at) FROM public.notification_deliveries d
             WHERE d.tenant_id=t.id),
            (SELECT max(r.sent_at) FROM public.password_recoveries r
             WHERE r.tenant_id=t.id AND r.status='sent')
          ),
          'lastEmailFailureRetryAt', GREATEST(
            (SELECT max(m.next_attempt_at) FROM public.invitation_mails m
             WHERE m.tenant_id=t.id AND m.status='pending' AND m.last_error IS NOT NULL AND m.attempts>0),
            (SELECT max(r.next_attempt_at) FROM public.password_recoveries r
             WHERE r.tenant_id=t.id AND r.status='pending' AND r.last_error IS NOT NULL AND r.attempts>0)
          ),
          'inboundQueue', (
            SELECT count(*) FROM public.inbound_messages i
            WHERE i.tenant_id=t.id AND i.status IN ('queued','processing')
          ),
          'storageBytes', COALESCE((
            SELECT sum(a.size) FROM public.attachments a
            WHERE a.tenant_id=t.id AND a.status<>'rejected'
          ), 0)
        ),
        'timeline', COALESCE((
          SELECT jsonb_agg(jsonb_build_object('action', x.action, 'at', x.at) ORDER BY x.at DESC)
          FROM (
            SELECT 'status:'||a.new_status AS action, a.changed_at AS at
            FROM public.tenant_status_audits a WHERE a.tenant_id=t.id
            UNION ALL
            SELECT c.action, c.created_at
            FROM public.config_audits c WHERE c.tenant_id=t.id
            UNION ALL
            SELECT o.action, o.created_at
            FROM public.operator_audits o WHERE o.tenant_id=t.id
            ORDER BY at DESC
            LIMIT 50
          ) x
        ), '[]'::jsonb)
      ))
      FROM (SELECT * FROM public.tenants t2 WHERE t2.id=p_tenant_id LIMIT 1) t
    ), '[]'::jsonb);
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', t.id,
      'slug', t.slug,
      'name', t.name,
      'status', t.status,
      'active', t.active,
      'planId', t.plan_id,
      'seatLimit', t.seat_limit,
        'revision', t.revision,
      'seatsUsed', (
        SELECT count(*) FROM public.users u
        WHERE u.tenant_id=t.id AND u.role<>'system' AND (u.active OR (u.invitation_hash IS NOT NULL AND u.invitation_expires_at>now()))
      ),
      'createdAt', (
        SELECT min(a.changed_at) FROM public.tenant_status_audits a
        WHERE a.tenant_id=t.id
      ),
      'lastActivity', GREATEST(
        (SELECT max(x.created_at) FROM public.activities x WHERE x.tenant_id=t.id),
        (SELECT max(x.created_at) FROM public.audits x WHERE x.tenant_id=t.id),
        (SELECT max(x.created_at) FROM public.config_audits x WHERE x.tenant_id=t.id),
        (SELECT max(x.changed_at) FROM public.tenant_status_audits x WHERE x.tenant_id=t.id),
        (SELECT max(x.created_at) FROM public.operator_audits x WHERE x.tenant_id=t.id AND x.action LIKE 'operator.%')
      ),
      'trialEndsAt', t.trial_ends_at,
      'deleteAfter', t.delete_after
    ) ORDER BY t.slug)
    FROM (
      SELECT * FROM public.tenants t2
      WHERE v_search='' OR t2.name ILIKE '%'||v_search||'%' OR t2.slug ILIKE '%'||v_search||'%'
      ORDER BY t2.slug
      LIMIT 100
    ) t
  ), '[]'::jsonb);
END
$$;
ALTER FUNCTION public.operator_organisation_metadata(uuid,text,uuid) OWNER TO astrama_auth_reader;
REVOKE ALL ON FUNCTION public.operator_organisation_metadata(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_organisation_metadata(uuid,text,uuid) TO astrama_app;
