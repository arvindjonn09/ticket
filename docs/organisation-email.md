# Organisation outgoing email

Organisation administrators can open **Settings → Organisation → Email** to choose
the platform sender, their own SMTP server, Google Workspace SMTP, or Microsoft 365. These connections are included on every plan. Receiving email still uses
the forwarding address shown on the same page.

SMTP settings require implicit TLS or STARTTLS and port 465, 587, 25 or 2525.
Enter the host, username, password and From address, then use **Test and save**.
The test goes only to the signed-in administrator. A failed test preserves the
previous working configuration; the password is never sent back to the browser.

For Google Workspace, use the relay configured by your Workspace administrator,
or `smtp.gmail.com` with the full mailbox username and an app password. App
passwords require 2-Step Verification and may be unavailable under an organisation's
security policy. Use STARTTLS on 587 or implicit TLS on 465. Follow Google's
[SMTP instructions](https://knowledge.workspace.google.com/admin/gmail/send-email-from-a-printer-scanner-or-app) and
[app-password instructions](https://support.google.com/accounts/answer/185833).

Own SMTP destinations must resolve to public addresses. Loopback, private,
link-local and internal service addresses are refused, including after DNS
changes. For isolated open-source testing, use the trusted operator platform
profile described in [the Mox runbook](mail-oss.md).

After five consecutive connection or authentication failures, the organisation
uses the platform sender and shows **Problem**. Administrators receive a notice
through the platform sender. Correct the configuration and test it again to
restore the own sender. Read-only organisations send administrator mail through
the platform. Selecting the platform sender removes the saved own credentials.

## Enable Microsoft 365

The platform operator first registers a multitenant **Web** application in
Microsoft Entra for organisational accounts. Configure delegated Exchange Online
`SMTP.Send` permission and the exact redirect URI
`https://<public-application-host>/api/mail/microsoft365/callback`. In hosted mode
this is the `PUBLIC_SITE_ORIGIN` host, not an organisation or operator host.
See Microsoft's [SMTP OAuth guide](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)
and [redirect URI requirements](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url).

Set these values privately in the deployment environment:

```dotenv
M365_CLIENT_ID=<Entra application ID>
M365_CLIENT_SECRET=<Entra application secret value>
M365_REDIRECT_URI=https://<public-application-host>/api/mail/microsoft365/callback
```

Alternatively, leave `M365_CLIENT_SECRET` blank and set
`M365_CLIENT_SECRET_FILE` to a file mounted read-only inside every API and worker
container that sends mail (`api`, `worker` and `lifecycle` in the supplied files).
Compose passes the path but does not mount an arbitrary
host secret automatically; add the bind mount in a private deployment override.
Keep the environment file and secret accessible only to the deployment account.
Leave the Microsoft settings blank to disable Connect. Production preflight
rejects partial credentials, multiple secret sources and foreign callback URLs.

The organisation administrator selects **Connect Microsoft 365**, signs in and
consents, returns to the Email page, and tests the pending connection before
activating it. Their mailbox must allow
[authenticated SMTP submission](https://learn.microsoft.com/en-us/Exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission).
The application uses OAuth instead of a mailbox password. MSAL's token cache,
including refresh credentials, is encrypted separately for each organisation;
MSAL refreshes access tokens through
[its cache](https://learn.microsoft.com/en-us/entra/msal/javascript/node/caching).
Revoked consent requires reconnecting.

Operator organisation details show outgoing mode and status without SMTP hosts
or credentials. An owner can reset an organisation to the platform sender with
an audit reason. Credentials are excluded from customer exports, covered by
encryption-key rotation, and removed on organisation deletion.
