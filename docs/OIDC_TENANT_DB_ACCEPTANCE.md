# Tenant Service — OIDC & DB Isolation Acceptance Contract

**Draft only. Production NO-GO.**

## User-facing administrator API authentication

`/subjects` and the guarded `/students`, `/users` routes require an RS256 JWT signed by the deployment-pinned identity provider. Configure only with trusted deployment secrets/settings:

- `TENANT_ADMIN_AUTH_MODE=oidc` (secure default)
- `TENANT_OIDC_ISSUER=https://identity.example/realms/tenant`
- `TENANT_OIDC_JWKS_URL=https://identity.example/realms/tenant/protocol/openid-connect/certs`
- `TENANT_OIDC_AUDIENCE=tenant-service`
- `TENANT_OIDC_REQUIRED_ROLE=TENANT_ADMIN`
- `TENANT_ID=<fixed deployment tenant>`

The JWT must have a valid issuer, audience, expiration, issued-at, subject, exact `tenant_id` match, and required role. The role can be in a Keycloak `realm_access.roles` array or top-level `roles` array; role data is trusted only **after cryptographic verification**. Algorithm allowlist is RS256 only. Public non-loopback identity endpoints must use HTTPS. Arbitrary JWT `jku` / `x5u` header URLs are never followed; public keys come only from the configured JWKS URL.

Legacy `TENANT_ADMIN_API_KEY` is for **explicit non-production testing only**, requiring all three: `NODE_ENV=test|development`, `TENANT_ADMIN_AUTH_MODE=legacy` and `TENANT_ALLOW_DEV_API_KEY=true`. `NODE_ENV=production` or unset cannot enable legacy admin keys. The separate `TENANT_AGENT_API_KEY` remains for outbox-machine requests (provisional until workload identity/mTLS).

## Tenant DB connection protection

`TENANT_DATABASE_URL_TEMPLATE` must contain one literal `{tenant}` placeholder in the database path and cannot contain alternate `host` or other PostgreSQL query parameters. The resolved database name must equal the fixed `TENANT_ID`. Remote PostgreSQL connections require `sslmode=verify-full` and a trusted database CA. Production additionally requires `TENANT_DB_EXPECTED_ROLE` matching the non-superuser runtime role. A domain SQL user supplied via a request may not select the database.

## Executed automated QA

- Synthetic OIDC/JWKS RSA tokens cover acceptance, wrong issuer, wrong audience, expired tokens, cross-tenant claims, missing roles and static-key substitution.
- PostgreSQL 17 synthetic CI tests exercise Subject CRUD + atomic outbox rollback.
- URL parsing guard tests cover tenant path substitution, host override, query overrides and missing remote verified TLS.
- Compile, security unit, PostgreSQL integration and repository hygiene must all PASS on the **latest** draft-branch revision.

## Open blockers

1. Real configured Keycloak realm, OIDC mapper for `tenant_id`, aud, and role; MFA, user lifecycle, logout/revocation, audit.
2. Central/tenant API contracts, agent identity/rotation, rate limiting, network policy and security telemetry.
3. Separate least-privileged PostgreSQL role grants verified under the actual tenant-service process. Existing CI uses synthetic DBA fixtures.
4. Student/User module functional closure, full cross-module authorization matrix, recovery and load tests.
5. Public historical credentials rotation, signed releases, Windows acceptance and owner production approval.

No production deployment, merging or UIMS integration is authorized by this PR.

## Verified 2026-11-23 GitHub Actions evidence

- **Run:** https://github.com/myothein/tenant-service/actions/runs/45087333693
- **Clean build + API/OIDC/DB validation unit tests:** 16/16 PASS (4 PostgreSQL-only tests skipped in the non-database unit job).
- **Actual ephemeral PostgreSQL 17:** 4/4 tests PASS, including tenant Subject CRUD + transaction rollback and production role privilege rejection/acceptance.
- The PostgreSQL tests used a synthetic superuser (`ci_qa`), which the production role guard correctly rejected, and a distinct `tenant_ci_runtime` login, which was accepted after verifying it had no DBA privileges. The test also confirmed the restricted role could not CREATE ROLE.
- Unit OIDC/JWKS tests generated a disposable RSA signing key and rejected other tenants, expired tokens, invalid issuer/audience and missing admin roles. **No live Keycloak realm, user session or production credentials were used.**

These results certify only the executed CI conditions, not real-world production identity, least-privilege grant matrix under the full application, OIDC key rotation, revocation, service account hardening, throughput or UIMS integration.
