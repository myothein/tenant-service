# Tenant-service API contract (draft, not production)

This service is provisioned for **one fixed tenant** via TENANT_ID. The request may not select a tenant using x-tenant-id or x-tenant-code headers. Each tenant must have an isolated database/role and correct schema.

**Auth:** /subjects now requires an RS256-signed JWT from TENANT_OIDC_ISSUER and TENANT_OIDC_JWKS_URL (same HTTPS origin outside loopback). The token must have a valid signature, audience TENANT_OIDC_AUDIENCE, expiry, issued-at, subject, tenant_id equal to fixed deployment TENANT_ID, and TENANT_OIDC_REQUIRED_ROLE (default TENANT_ADMIN). Keycloak `realm_access.roles` and top-level `roles` are supported only after cryptographic verification. /local-events retains a **separate temporary agent Bearer API key**; mTLS/rotation are release blockers. Shared admin API key requires explicit TENANT_ADMIN_AUTH_MODE=legacy, TENANT_ALLOW_DEV_API_KEY=true, and is **forbidden** with NODE_ENV=production. Never run production in legacy mode.

**Endpoints:** GET /health public liveness; /subjects (list/create/update/delete) tenant-scoped; GET /local-events/pending and PATCH /local-events/:id/mark-sent agent-only. /students and /users return 501 even with valid admin credentials because their previous implementations are not schema-valid or sufficiently authorized.

**Outbox contract:** subject mutation and local_events insert occur in one SQL transaction; event ids are UUID strings and must be preserved by the agent. Agent may acknowledge local event only after persisting it in its own durable SQLite outbox; retries must not create duplicate IDs. Central ingestion, delivery receipts, authentication and safe backup/recovery remain release blockers.

**DB contract:** db-helper tenant Prisma schema owns subject and local_events table definitions. There is NO automatic migration on service startup. Apply migrations explicitly to isolated DEV only after a verified backup and review.

**Unresolved:** Student API schema fixes, user role authorization, production identity (OIDC/mTLS), automatic encrypted credential rotation, tenant-agent token injection, PostgreSQL integration tests, end-to-end central event ingestion, Windows service acceptance. Production NO-GO.
