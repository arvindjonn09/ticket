-- Runtime privileges belong to migrations, independent of fictional demo data.
-- The explicit owner bootstrap creates the restricted role before migrations 005+.
GRANT USAGE ON SCHEMA public TO astrama_app;
GRANT SELECT ON tenants,users,departments,memberships,categories,counters,tickets,activities,audits,outbox,idempotency,sessions TO astrama_app;
GRANT INSERT,UPDATE ON counters,tickets TO astrama_app;
GRANT INSERT ON activities,audits,outbox,idempotency TO astrama_app;
GRANT INSERT,UPDATE,DELETE ON sessions TO astrama_app;
GRANT EXECUTE ON FUNCTION auth_login_lookup(text,text),auth_session_lookup(text) TO astrama_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON departments,memberships,categories,subcategories TO astrama_app;
GRANT SELECT,INSERT ON config_audits TO astrama_app;
GRANT UPDATE(mfa_secret,mfa_enrolled,mfa_last_step,mfa_failures,mfa_locked_until,mfa_pending_session_id,mfa_pending_expires_at) ON users TO astrama_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON catalog_items,approvals,approval_delegations,attachments,notification_deliveries TO astrama_app;
GRANT UPDATE(published_at,attempts) ON outbox TO astrama_app;
GRANT EXECUTE ON FUNCTION pending_outbox_events(),auth_invitation_lookup(text,text),pending_invitation_mail() TO astrama_app;
GRANT INSERT ON users TO astrama_app;
GRANT SELECT,INSERT,UPDATE ON invitation_mails TO astrama_app;
GRANT UPDATE(name,email,password_hash,role,active,revision,approver_eligible,is_vp,manager_id,home_department,phone,job_title,invitation_hash,invitation_expires_at,invited_at,updated_at) ON users TO astrama_app;
GRANT UPDATE(name,brand_name,incident_prefix,request_prefix,default_priority,default_severity,timezone,locale,primary_colour,revision) ON tenants TO astrama_app;
