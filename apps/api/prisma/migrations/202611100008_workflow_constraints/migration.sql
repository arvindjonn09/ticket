-- SQL CHECK accepts NULL: require populated request costs and rejection reasons explicitly.
ALTER TABLE tickets DROP CONSTRAINT ticket_request_check;
ALTER TABLE tickets ADD CONSTRAINT ticket_request_check CHECK (
  type <> 'request' OR (
    item_id IS NOT NULL AND requested_for_id IS NOT NULL AND
    quantity IS NOT NULL AND unit_cost_minor IS NOT NULL AND total_cost_minor IS NOT NULL AND currency IS NOT NULL AND
    quantity > 0 AND unit_cost_minor >= 0 AND total_cost_minor >= 0 AND
    total_cost_minor::bigint = quantity::bigint * unit_cost_minor::bigint AND currency ~ '^[A-Z]{3}$'
  )
);
ALTER TABLE approvals DROP CONSTRAINT approval_status_check;
ALTER TABLE approvals ADD CONSTRAINT approval_status_check CHECK (
  status IN ('Pending','Approved','Rejected','Invalidated') AND stage IN ('manager','vp') AND version > 0 AND
  (status NOT IN ('Approved','Rejected') OR (decided_by_id IS NOT NULL AND decided_at IS NOT NULL)) AND
  (status <> 'Rejected' OR (comment IS NOT NULL AND length(trim(comment)) > 0))
);
