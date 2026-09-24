# ArcMail

Minimal private inbound-mail service for Stratus. It exposes the two endpoints the
current Stratus mail flow needs:

- `GET /api/v1/session` -> `{ address, token }`
- `GET /api/v1/inbox/:token` -> `{ address, mail: [...] }`

It receives real email through Cloudflare Email Routing and stores short-lived
mailboxes in Workers KV. There is no landing page and no public mailbox browser.

## Deploy

1. Put a domain on Cloudflare DNS and enable Email Routing for that domain.
2. From this folder, run `bun install`.
3. Create KV storage:
   `bunx wrangler kv namespace create MAILBOXES`
4. Copy the returned namespace id into `wrangler.jsonc`.
5. Change `MAIL_DOMAIN` in `wrangler.jsonc` to the domain that should receive mail.
6. Set the API secret:
   `bunx wrangler secret put API_SECRET`
7. Deploy:
   `bunx wrangler deploy`
8. In Cloudflare Email Routing, create a catch-all rule for the mail domain and
   send it to the `arcmail` Worker.

## Connect Stratus

Set these variables on the Stratus server:

```
ARCMAIL_URL=https://YOUR-WORKER.workers.dev
ARCMAIL_SECRET=the-same-secret-you-set-in-cloudflare
MAIL_PROVIDER_ORDER=ArcMail,smails,Mail.tm,Mail.gw,TempMail.ing,NonMail,DropMail,Guerrilla Mail
```

ArcMail is disabled automatically when `ARCMAIL_URL` is not set, so adding this
code does not change the current provider stack until you configure it.

## Quick smoke test

```sh
curl -H "Authorization: Bearer $ARCMAIL_SECRET" \
  "$ARCMAIL_URL/api/v1/session"
```

Send a message to the returned address, then:

```sh
curl -H "Authorization: Bearer $ARCMAIL_SECRET" \
  "$ARCMAIL_URL/api/v1/inbox/TOKEN_FROM_SESSION"
```

Mailboxes expire after 30 minutes and keep the newest 10 messages.
