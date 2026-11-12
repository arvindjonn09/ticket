# Account and encryption recovery

Password recovery is available from **Forgot your password?** on sign in. The API always acknowledges valid requests identically for unknown, inactive and throttled accounts. Active accounts receive a 32-byte random, single-use link, stored only as a SHA-256 digest and an AES-GCM encrypted mail-outbox URL. Links expire after 30 minutes. A new request supersedes earlier links. Successful reset consumes the link atomically, changes the password, revokes every session and leaves enrolled MFA and its replay/lockout state intact. Changing email/password or disabling the account invalidates outstanding links. Do not put recovery tokens in logs, screenshots, tickets or query strings; the browser clears the URL fragment after reading it.

Public requests always encrypt and durably enqueue the organisation/email pair; they never look up an account or wait for its tenant lock. Known and unknown accounts take the same acknowledgement path, including storage/key failures. The private infrastructure queue expires after 15 minutes, erases resolved ciphertext and retries processing failures at most five times. The worker resolves the account under the tenant lock and creates the token/mail atomically with consuming the queued request. Queued requests for deleted/inactive organisations produce no email. Expired request rows are purged on enqueue and worker dispatch.

The worker retries committed recovery mail with bounded exponential backoff, rechecks the active tenant/account, current email/password, expiry and token state, and erases encrypted URLs after delivery, cancellation or ten failures. A new request is required after expiry/exhaustion. SMTP acknowledgement can be ambiguous, so duplicate email is possible; the link remains single-use. Monitor pending/skipped recovery requests/deliveries and worker failures without recording encrypted payloads or URL/token fields.

Login limits are shared in PostgreSQL across API instances: five attempts per organisation/email and thirty per source IP in a fixed 15-minute window. Successful login clears its account counter and releases one IP attempt. Recovery request limits are three per account and thirty per IP; reset is thirty per IP. A reverse proxy must strip incoming forwarding headers and `TRUST_PROXY=1` is valid only with one trusted proxy hop. These are technical defaults to validate against the organisation's access and support policy.

## Lost authenticator: verified operator action

Email password recovery never removes MFA. There is no email-only lost-authenticator bypass. The organisation must appoint an authorised operator and approve an identity-verification procedure before production. Independently verify identity through that procedure (for example, an established HR contact and an in-person check); email possession or information supplied by the requester alone is insufficient. Record a restricted evidence reference rather than copies of identity documents or secrets.

Stop/limit access as appropriate, build the API, and provide `MIGRATION_DATABASE_URL` through the operator's secret store. This command requires ownership of the users table and permission to read all tenants under FORCE RLS; the restricted application role is rejected. Create a protected JSON file:

```json
{
  "organisation": "explicit-organisation-slug",
  "userId": "11111111-1111-4111-8111-111111111111",
  "operator": "authorised-operator-reference",
  "reason": "Lost authenticator, verified under approved procedure",
  "verificationEvidence": "Restricted verification case reference and approved checks"
}
```

From `apps/api`, run `node dist/recovery.js verified-recovery.json` for a dry run. Check the exact organisation/user. Apply the same verified input using `node dist/recovery.js verified-recovery.json --apply`. The transaction clears only that enrolled active administrator's MFA, revokes all sessions and password-reset links, and appends `mfa.operator_recovery` with operator, reason and evidence. The password is preserved. The user must sign in and enrol a new authenticator before administrative access. Remove the protected input file according to the organisation's retention policy. An ordinary invitation never resets existing MFA.

## Offline encryption-key rotation

Rehearse in an isolated restored environment before production. Keep a consistent backup of the database, objects and old encryption key; an encrypted database without its matching key cannot recover MFA or queued links. This command never generates, prints or updates deployment secrets and must not be run against the live local demo as a test.

1. Stop every API, worker, provisioning/recovery process and other database writer. Confirm maintenance mode. Capture a recoverable backup and preserve the old key in restricted escrow.
2. Generate a fresh independent 32-byte key using your secret manager. Supply the existing key as `MFA_ENCRYPTION_KEY` and the new 64-character hexadecimal key as `MFA_NEW_ENCRYPTION_KEY` through protected environment injection. Never put key values in command arguments or shell history. Supply the explicit owner `MIGRATION_DATABASE_URL`.
3. From `apps/api`, run `node dist/key-rotation.js --offline`. It validates key lengths, rejects the same key, decrypts every current encrypted value and verifies re-encryption using the new key. It reports counts only and writes nothing.
4. Run `node dist/key-rotation.js --offline --apply`. Exclusive table locks and one transaction cover user MFA secrets, queued invitation URLs, queued password-recovery URLs and encrypted recovery requests across every tenant, including inactive tenants and unknown-account requests. Any invalid ciphertext or key rolls the entire transaction back. The command refuses a database owner whose FORCE RLS access would silently omit rows.
5. After successful commit, atomically change the deployment's `MFA_ENCRYPTION_KEY` to the new value for **all** application/worker instances before restarting any of them. Remove `MFA_NEW_ENCRYPTION_KEY` from their environment. If secret deployment fails, keep services stopped; restore the matching pre-rotation database/key pair or rotate back using the new key as source. Never start mixed old/new-key instances.
6. Verify sign-in/MFA, invitation activation and password recovery in the isolated rehearsal and then the controlled deployment. Record counts, backup identifier, operator and outcomes in the restricted operations log, never plaintext keys or links. Retain old-key escrow for backups that still require it under the approved retention policy.

New encrypted columns must be added to this rotation's table list before shipping. No claims of live online rotation or automatic secret-store updates are made.
