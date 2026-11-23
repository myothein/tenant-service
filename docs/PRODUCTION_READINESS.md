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
- The legacy **/students remains 501** because the deployed migration uses `student` with `tenant_code`, mandatory identity/class/grade fields and different column naming from the old `students` SQL. Re-enabling it without full schema contract, PII authorization, audit and tests would be unsafe.
- **Not a production authorization:** Real Keycloak realm/client/tenant role mapping, least-privilege user SELECT grants, audit logging, operational privacy policy and backup/restore acceptance remain OPEN.

### 2026-11-23 — Schema-aligned student read-only directory (Draft PR only)

- **GET /students** and **GET /students/:id** now use the actual db-helper PostgreSQL `student` table; requests cannot choose a different tenant and every SQL query includes the fixed `tenant_code` predicate and excludes `"deletedAt"` soft-deleted records.
- Only `id`, `name`, `surname`, `classId`, and `gradeId` are returned. Address, email, phone, birthday, blood type, sex, photographs, username and any other sensitive fields are not returned; `SELECT *` is prohibited.
- All student write operations are explicitly refused with HTTP 405 pending a separately accepted write/transaction/audit/outbox design. Authorization is the verified tenant-admin gate; pagination and identifiers are bounded before database use.
- Synthetic negative HTTP/JWT tests and PostgreSQL 17 disposable seed-and-delete regression tests cover same-DB other-tenant rows, soft deletes, field projection, missing credentials, tenant spoofing and disabled mutations.
- Production rollout remains blocked on **real Keycloak role mapping, least-privilege student SELECT grants, access audit logging, privacy/child-data policy, performance and backup/restore acceptance**. No production personal information was queried or modified.

**Remaining NO-GO:** actual Keycloak integration, least-privilege DB grants/backup, user- and agent-side RBAC audit, secret rotation, student/user modules, six-repository acceptance, offline recovery under power loss and explicit release approval.
