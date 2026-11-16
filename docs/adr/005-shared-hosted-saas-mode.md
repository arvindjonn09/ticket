# ADR 005: Shared hosted SaaS mode

- Status: Accepted
- Date: 17 November 2026
- Decision owners: product owner and technical owner

## Context

The original deployment direction was a Docker stack installed for one company
on one machine. The SaaS onboarding requirements add self-service signup,
customer subdomains, billing, and an internal operator console. This changes the
hosting model to one shared hosted stack serving many organisations. The
application already isolates business data by tenant ID, PostgreSQL row-level
security, composite tenant-aware relationships, and a restricted runtime role.

The product must still support a single-company installation. The production
domain, region, and hosting provider are not selected yet; `APP_BASE_DOMAIN`
remains configuration, and `astrama.test` is only for local and CI use.

## Decision

Support two deployment modes in the same codebase:

- `PLATFORM_MODE=hosted` serves the public site, operator console, and tenant
  subdomains from one shared deployment. The trusted HTTP host selects the
  tenant; application code still verifies the tenant and authorization through
  the existing tenant-scoped session and RLS boundary.
- `PLATFORM_MODE=single` preserves the current one-company installation and
  `APP_ORIGIN` behavior. Signup, billing, and operator-console routes are not
  exposed in this mode.

Use Caddy on-demand TLS guarded by an API `ask` endpoint. It may authorize only
an active tenant hostname, the configured public hostname, and the configured
operator hostname. Do not issue certificates for arbitrary names. Keep session
cookies host-only; never set a parent-domain cookie.

## Consequences

- Hosted mode adds shared-service operational responsibility: tenant-aware
  monitoring, fairness limits, all-tenant backup/restore, and audited support
  access are release requirements.
- Tenant selection from a host is an untrusted routing hint. Login, session
  validation, CSRF/origin checks, and data queries must all bind to the resolved
  active tenant and fail closed on mismatch.
- Caddy calls the TLS authorization endpoint over the private service network;
  the public Caddy route returns 404 for that path. Keep the API rate-limited
  and independent of user-supplied forwarded-host headers.
- Active-only on-demand certificate issuance means a never-provisioned
  subdomain cannot complete its first HTTPS handshake, so its neutral HTML page
  cannot render in a browser on that first visit. The API and SPA return the
  same neutral not-found response when reached through an already-valid TLS
  connection. A trusted first-visit page requires a wildcard certificate or a
  broader certificate authorization policy; either changes the stated TLS
  boundary and must be resolved before hosted launch.
- Single mode remains available for customers requiring an isolated deployment;
  it uses the same versioned schema and migrations.
- `APP_BASE_DOMAIN`, `PUBLIC_SITE_ORIGIN`, and `OPERATOR_ORIGIN` are deployment
  configuration. No real domain, region, plan price, or legal text is embedded
  in application defaults.

## Rollout and validation

Implement the SA-01 to SA-06 packets in order. Before enabling hosted signup,
verify cross-subdomain session denial, host-bound login and CSRF behavior,
unknown-host neutrality, TLS allowlist refusal, tenant lifecycle enforcement,
operator access grants, fairness limits, backup and single-tenant restore, and
the full signup-to-first-ticket journey. Keep hosted mode disabled until a real
domain, region, provider credentials, legal text, and recovery evidence are
configured and reviewed.
