CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE public.tickets
  ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig, coalesce(summary,'') || ' ' || coalesce(description,''))
  ) STORED;

CREATE INDEX tickets_search_vector_gin ON public.tickets USING gin(search_vector);
CREATE INDEX tickets_number_trgm_gin ON public.tickets USING gin(lower(number) gin_trgm_ops);
CREATE INDEX users_name_trgm_gin ON public.users USING gin(lower(name) gin_trgm_ops);
