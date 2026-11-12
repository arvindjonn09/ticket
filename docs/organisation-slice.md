# Organisation setup slice

User confirmed 10 November 2026: build group/category/subcategory administration before further workflows; subcategory routing may override its category, otherwise inherit. We provision organisations; each organisation administrator configures its own setup. No public organisation signup in this slice.

One department record is one assignment group for now. UI calls these support groups. Groups have active agent members. Category and subcategory changes affect new tickets only; existing tickets retain stored destination and sensitivity. Subcategory must belong to the chosen category and be active. Category selection clears subcategory. Subcategory is optional. Effective destination = subcategory override ?? category group; retain existing staffed-triage fallback and sensitive restrictions.

## Shared interface (all under /api)

- Session user role adds `admin`; SessionView adds optional `mfaVerified: boolean` (absent treated false for admins). Admin credentials alone never grant configuration access or broader ticket access.
- Login accepts optional `totpCode` (six digits). Admin without configured MFA can receive a restricted session for enrolment only; configured admins must supply a valid code to sign in. Sessions authenticated before MFA setup remain restricted until verified.
- `POST /auth/mfa/setup` (authenticated admin, CSRF) -> `{secret, uri}` for enrolling a not-yet-enrolled administrator. `POST /auth/mfa/verify` body `{code}` -> SessionView and full MFA-verified session. No public MFA disable/reset endpoint. Secrets encrypted using runtime `MFA_ENCRYPTION_KEY`; setup returns a secret only when beginning enrolment, never on ordinary session/config responses. TOTP replay and brute-force checks required.
- The web screen renders the setup URI as a black-on-white QR code locally, with a four-module quiet zone and a collapsible manual-key fallback. No external QR service receives the secret. Browser verification decodes the rendered QR with an independent decoder and uses its secret to complete MFA enrolment.
- `GET /admin/config` -> `{organisation:{id,name,brandName}, groups:Group[], agents:{id,name,email}[], categories:AdminCategory[], subcategories:AdminSubcategory[]}`. Admin + verified MFA required on every admin route.
- Group `{id,name,active,isTriage,revision,memberIds:string[]}`. `POST /admin/groups` body `{name,memberIds}`; `POST /admin/groups/:id` body `{revision,name,active,memberIds}`. Responses group. Protect triage availability; reject removing a member with unresolved assigned tickets instead of silently stranding work. Reject inactive groups still used by active mappings or unresolved tickets.
- Category `{id,name,departmentId,active,sensitive,revision}`. `POST /admin/categories` body `{name,departmentId,sensitive}`; `POST /admin/categories/:id` body `{revision,name,departmentId,active,sensitive}`. Responses category. Destination must be an active same-tenant group.
- Subcategory `{id,categoryId,name,departmentId:string|null,active,revision}`. `POST /admin/subcategories` body `{categoryId,name,departmentId}`; `POST /admin/subcategories/:id` body `{revision,name,departmentId,active}`. Responses subcategory. Null means inherit. Parent cannot be changed. Archive used records; do not erase history.
- `POST /admin/categories/:id/delete` and `/admin/subcategories/:id/delete`, body `{revision}` -> `{ok:true}`. Delete only unused categories with no child subcategories and unused subcategories; otherwise return 409 and offer archive.
- Catalog category adds `departmentId`, `subcategories:[{id,name,departmentId:string|null,departmentName:string}]` (effective group name); only active children under active parents.
- Create ticket accepts optional `subcategoryId`. Ticket summary/detail adds nullable `subcategoryId` and `subcategoryName`.

All writes validate input, use tenant-aware relations/RLS, optimistic revisions and append-only configuration audit. Same-tenant entity lookup; no client-supplied tenant IDs. Serialise admin configuration changes against ticket creation to avoid archive/membership races. No role-based bypass to sensitive tickets. Group member list uses existing active agents; employee/admin roles cannot be assigned as agents.

## Ownership and checks

Backend worker: API source/schema/new migrations/seed/tests + contracts/domain. Frontend worker: apps/web/src only. Orchestrator: config/env/docs/Playwright. Independent review: read only. Do not edit applied migrations or reset existing demo tickets.

Tests: MFA required/replay/invalid codes; non-admin and foreign-tenant denial; admin group/category/subcategory create/update/archive/delete and audit; inherited and overridden routing; mismatched/archived subcategories rejected; remapping leaves old tickets unchanged; member removal protection; real Playwright admin setup -> employee ticket -> authorised group agent claim, plus regression journeys. Existing organisations are provisioned by the demo seed; full tenant onboarding and user invitation are separate work.
