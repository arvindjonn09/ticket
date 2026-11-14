ALTER TABLE public.sla_alerts
  ADD COLUMN cycle_started_at timestamptz;

UPDATE public.sla_alerts alert
SET cycle_started_at = CASE
  WHEN alert.target = 'resolution' THEN COALESCE(ticket.sla_resolution_started_at, ticket.created_at)
  ELSE ticket.created_at
END
FROM public.tickets ticket
WHERE ticket.tenant_id = alert.tenant_id AND ticket.id = alert.ticket_id;

ALTER TABLE public.sla_alerts
  ALTER COLUMN cycle_started_at SET NOT NULL,
  DROP CONSTRAINT sla_alerts_tenant_id_ticket_id_target_stage_key,
  ADD CONSTRAINT sla_alerts_cycle_unique
    UNIQUE (tenant_id, ticket_id, target, stage, cycle_started_at);
