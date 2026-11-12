-- Runtime user lifecycle/settings writes remain constrained by tenant RLS.
GRANT INSERT ON public.users TO astrama_app;
GRANT UPDATE(name,email,password_hash,role,active,revision,approver_eligible,is_vp,manager_id,home_department,phone,job_title,invitation_hash,invitation_expires_at,invited_at,updated_at) ON public.users TO astrama_app;
GRANT UPDATE(name,brand_name,timezone,locale,primary_colour,incident_prefix,request_prefix,default_priority,default_severity,revision) ON public.tenants TO astrama_app;
