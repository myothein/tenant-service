# Production readiness gates — tenant-service

**Status: NO-GO.** This proposed branch addresses source-control hygiene only. It is **not** a production certification.

## Mandatory pre-merge checks

- [ ] Arrange independent, verified backup of all runtime tenant databases, logs and original configuration. Removing tracked files from a branch must not erase the only copy of operational evidence.
- [ ] Review and rotate/revoke any potentially committed live credentials, and provision secret-manager environment injection. A Git commit deletion does **not** remove secrets or data from past Git history, forks or caches. History cleanup requires separately approved coordination.
- [ ] Generate and commit a pinned dependency lockfile; run clean reproducible dependency install and production build.
- [ ] Add unit/integration tests, verify cross-service API and DB contracts, and collect pass/fail evidence.
- [ ] Prove least-privilege authorization, auditability, tenant isolation, zero hard-coded production credentials, and recovery after restart.
- [ ] Complete service-specific blockers:
- [ ] Unauthenticated student and user APIs
- [ ] Student SQL/table/column mismatches with db-helper
- [ ] Missing atomic subject + event transactions
- [ ] Incorrect local_events tenant_id versus tenant_code schema fields
- [ ] Require independent review, security scan, signed artifacts where applicable, restore drill and approved release go/no-go.

Do not integrate with UIMS V1 until the six infrastructure repositories pass their release gates. No production deployment is authorized by this PR.

## CI verification scope

The initial CI jobs check tracked-file hygiene, dependency lockfile presence, clean npm installation and TypeScript compilation. A successful result **does not** prove authentication, database migrations, offline data safety, functional tests, device integration, signing, or production readiness. Keep the PR as draft until independent release criteria pass.

## Authentication and tenant database safety — Draft QA update (2026-11-23)

- Added RS256 JWT verification against **deployment-pinned OIDC issuer and JWKS URL**, including issuer, audience, expiration, issued-at, subject, fixed tenant ID and required admin role (Keycloak realm roles or top-level roles).
- OIDC is the **default** for admin CRUD. Shared admin bearer credentials are restricted to explicitly configured `NODE_ENV=test|development`, `TENANT_ALLOW_DEV_API_KEY=true` and `TENANT_ADMIN_AUTH_MODE=legacy`. No legacy shared admin keys in production.
- Agent outbox endpoints remain separate and still use a temporary 32+ byte machine key. Agent mTLS/workload identity, credential rotation and revocation are still NOT closed.
- Tenant database connection URLs now require that the resolved database name exactly equals deployment-owned `TENANT_ID`, reject alternate host/query parameters and require verified TLS for non-loopback hosts. Production must explicitly pin `TENANT_DB_EXPECTED_ROLE`.
- Synthetic local JWKS unit tests use ephemeral RSA keys. Real Keycloak issuer, role mapping, audience mapper, redirect/session policies, and live tenant provisioning were **not** validated; do not infer production readiness from these tests.
- Changes are intentionally incompatible with old static-admin-key deployments and unverified DB URL formats. Review environment configuration and client contracts before any merge.
- Do not deploy `NODE_ENV=production` without a verified HTTPS issuer, trusted JWKS, audience mapper, correctly scoped roles, TLS-enabled tenant DB and least-privileged tenant DB role.

### 2026-11-23 — Tenant-local user directory (Draft PR only)

- Replaced the unsafe `SELECT * FROM user` legacy handler with an **admin-authenticated, read-only GET /users** against the fixed tenant PostgreSQL database. Only explicitly approved non-email account metadata is returned; page and limit are bounded and the query is parameterized.
- Unauthorized users, mismatched tenant headers, invalid pagination and all user mutation methods fail closed. No user creation, role assignment, identity lifecycle or account secrets have been enabled.
- Added synthetic auth/validation tests and an ephemeral PostgreSQL 17 integration test that seeds a disposable user row, verifies projected fields, denies mutations and cleans up the row. The private CI still requires owner-approved authentication/cutover.
- The legacy student SQL did not match db-helper's schema; subsequent read-only and opt-in write implementations supersede that unsafe stub. Full production PII authorization and schema acceptance are still required.
- **Not a production authorization:** Real Keycloak realm/client/tenant role mapping, least-privilege user SELECT grants, audit logging, operational privacy policy and backup/restore acceptance remain OPEN.

### 2026-11-23 — Schema-aligned student read-only directory (Draft PR only)

- **GET /students** and **GET /students/:id** now use the actual db-helper PostgreSQL `student` table; requests cannot choose a different tenant and every SQL query includes the fixed `tenant_code` predicate and excludes `"deletedAt"` soft-deleted records.
- Only `id`, `name`, `surname`, `classId`, and `gradeId` are returned. Address, email, phone, birthday, blood type, sex, photographs, username and any other sensitive fields are not returned; `SELECT *` is prohibited.
- At the read-only checkpoint, student writes returned HTTP 405. A subsequent explicitly opt-in write implementation is detailed below; without the feature flag, writes remain disabled with HTTP 405.
- Synthetic negative HTTP/JWT tests and PostgreSQL 17 disposable seed-and-delete regression tests cover same-DB other-tenant rows, soft deletes, field projection, missing credentials, tenant spoofing and disabled mutations.
- Production rollout remains blocked on **real Keycloak role mapping, least-privilege student SELECT grants, access audit logging, privacy/child-data policy, performance and backup/restore acceptance**. No production personal information was queried or modified.

### 2026-11-23 — Default-disabled atomic student writes (Draft PR only)

- Added **POST /students**, **PUT /students/:id** (name/surname only) and **DELETE /students/:id** (soft delete) behind `TENANT_STUDENT_WRITES_ENABLED=true`. The flag is deliberately **unset by default**. Production writes additionally require the subject from a signature-verified OIDC access token; unreviewed Keycloak identity and role provisioning remain NO-GO.
- Create validates a constrained whitelist of mandatory student fields and verifies, under a transaction, that the class and grade belong to the fixed deployment tenant and are linked to each other. Request headers or body cannot select another tenant.
- Domain mutations and `local_events` outbox inserts occur atomically within a single PostgreSQL transaction. Events include only student ID, fixed tenant code and class/grade IDs; they do **not** include name, address, contact, birthdate, health data, sex or other student PII. The audit header carries the verified OIDC subject in production; `nonproduction-legacy-qa` labels isolated QA only.
- Added HTTP input validation/authorization tests and disposable PostgreSQL 17 integration tests for create/rename/soft-delete, event minimization, invalid class/grade, cross-tenant intent, and rollback when outbox insertion fails. Code/CI verification must be tied to the exact Draft HEAD commit; a passing build is not a production operation test.
- **Not yet released:** Require independent privacy/security assessment, least-privilege production insert/update/outbox grants, real Keycloak role/subject mapping, audit retention, immutable event delivery/idempotency, PII incident and child-data handling, restore drills, rollback rehearsals and owner approval. Do not enable this flag in production without formal release acceptance.

**Remaining NO-GO:** actual Keycloak integration, least-privilege DB grants/backup, user- and agent-side RBAC audit, secret rotation, student/user modules, six-repository acceptance, offline recovery under power loss and explicit release approval.
