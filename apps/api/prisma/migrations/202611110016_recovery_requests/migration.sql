-- Authentication infrastructure: unknown and known accounts take exactly the same enqueue path.
-- No tenant identifier exists until the worker resolves the encrypted organisation/email request.
CREATE TABLE password_recovery_requests (
 id uuid PRIMARY KEY, encrypted_request text, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','skipped')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 next_attempt_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_recovery_requests_due_idx ON password_recovery_requests(status,next_attempt_at);
CREATE INDEX password_recovery_requests_expiry_idx ON password_recovery_requests(expires_at);
REVOKE ALL ON password_recovery_requests FROM PUBLIC,astrama_app;
CREATE FUNCTION enqueue_password_recovery(request_id uuid,encrypted_payload text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF encrypted_payload IS NULL OR octet_length(encrypted_payload)>4096 THEN RAISE EXCEPTION 'Invalid recovery request'; END IF;
 DELETE FROM public.password_recovery_requests WHERE expires_at<=clock_timestamp();
 INSERT INTO public.password_recovery_requests(id,encrypted_request) VALUES(request_id,encrypted_payload);
END $$;
CREATE FUNCTION pending_password_recovery_requests() RETURNS TABLE(id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT r.id FROM public.password_recovery_requests r WHERE r.status='pending' AND r.next_attempt_at<=now() AND r.expires_at>now()
 ORDER BY r.created_at,r.id LIMIT 100
$$;
CREATE FUNCTION lock_password_recovery_request(request_id uuid) RETURNS TABLE(encrypted_request text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT r.encrypted_request FROM public.password_recovery_requests r WHERE r.id=request_id AND r.status='pending'
 AND r.next_attempt_at<=clock_timestamp() AND r.expires_at>clock_timestamp() FOR UPDATE
$$;
CREATE FUNCTION finish_password_recovery_request(request_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 UPDATE public.password_recovery_requests SET status='completed',encrypted_request=NULL,last_error=NULL WHERE id=request_id AND status='pending'
$$;
CREATE FUNCTION fail_password_recovery_request(request_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 UPDATE public.password_recovery_requests SET attempts=attempts+1,
 status=CASE WHEN attempts>=4 OR expires_at<=clock_timestamp() THEN 'skipped' ELSE 'pending' END,
 encrypted_request=CASE WHEN attempts>=4 OR expires_at<=clock_timestamp() THEN NULL ELSE encrypted_request END,
 next_attempt_at=clock_timestamp()+least(300,30*power(2,least(attempts,4))) * interval '1 second',last_error='Recovery request processing failed'
 WHERE id=request_id AND status='pending'
$$;
CREATE FUNCTION purge_expired_recovery_requests() RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DELETE FROM public.password_recovery_requests WHERE expires_at<=clock_timestamp()
$$;
REVOKE ALL ON FUNCTION enqueue_password_recovery(uuid,text),pending_password_recovery_requests(),lock_password_recovery_request(uuid),finish_password_recovery_request(uuid),fail_password_recovery_request(uuid),purge_expired_recovery_requests() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_password_recovery(uuid,text),pending_password_recovery_requests(),lock_password_recovery_request(uuid),finish_password_recovery_request(uuid),fail_password_recovery_request(uuid),purge_expired_recovery_requests() TO astrama_app;
