import * as PostalMime from "postal-mime";

interface Env {
  MAILBOXES: KVNamespace;
  MAIL_DOMAIN: string;
  API_SECRET: string;
}

interface StoredMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  text: string;
  html: string;
  receivedAt: string;
}

const SESSION_TTL_SECONDS = 30 * 60;
const MAX_MESSAGES = 10;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function normalizeDomain(value: string) {
  return value.trim().toLowerCase().replace(/^@/, "");
}

function normalizeAddress(value: string) {
  return value.trim().toLowerCase();
}

function isAuthorized(request: Request, env: Env) {
  const secret = String(env.API_SECRET || "").trim();
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

function tokenKey(token: string) {
  return `token:${token}`;
}

function addressKey(address: string) {
  return `address:${address}`;
}

function inboxKey(address: string) {
  return `inbox:${address}`;
}

async function readInbox(env: Env, address: string): Promise<StoredMessage[]> {
  const raw = await env.MAILBOXES.get(inboxKey(address));
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeInbox(env: Env, address: string, messages: StoredMessage[]) {
  await env.MAILBOXES.put(
    inboxKey(address),
    JSON.stringify(messages.slice(0, MAX_MESSAGES)),
    { expirationTtl: SESSION_TTL_SECONDS },
  );
}

async function createSession(env: Env) {
  const domain = normalizeDomain(env.MAIL_DOMAIN || "");
  if (!domain) return json({ error: "MAIL_DOMAIN is not configured" }, 500);

  const token = crypto.randomUUID().replace(/-/g, "");
  const local = `arc_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
  const address = `${local}@${domain}`;

  await Promise.all([
    env.MAILBOXES.put(tokenKey(token), address, {
      expirationTtl: SESSION_TTL_SECONDS,
    }),
    env.MAILBOXES.put(addressKey(address), token, {
      expirationTtl: SESSION_TTL_SECONDS,
    }),
    env.MAILBOXES.put(inboxKey(address), "[]", {
      expirationTtl: SESSION_TTL_SECONDS,
    }),
  ]);

  return json({
    address,
    token,
    expiresIn: SESSION_TTL_SECONDS,
  });
}

async function getInbox(env: Env, token: string) {
  const address = await env.MAILBOXES.get(tokenKey(token));
  if (!address) return json({ error: "Mailbox not found or expired" }, 404);

  return json({
    address,
    mail: await readInbox(env, address),
  });
}

async function deleteInbox(env: Env, token: string) {
  const address = await env.MAILBOXES.get(tokenKey(token));
  if (!address) return json({ ok: true });

  await Promise.all([
    env.MAILBOXES.delete(tokenKey(token)),
    env.MAILBOXES.delete(addressKey(address)),
    env.MAILBOXES.delete(inboxKey(address)),
  ]);

  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "arcmail" });
    }

    if (!isAuthorized(request, env)) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (request.method === "GET" && url.pathname === "/api/v1/session") {
      return createSession(env);
    }

    const inboxMatch = url.pathname.match(/^\/api\/v1\/inbox\/([A-Za-z0-9_-]+)$/);
    if (inboxMatch && request.method === "GET") {
      return getInbox(env, inboxMatch[1]);
    }

    if (inboxMatch && request.method === "DELETE") {
      return deleteInbox(env, inboxMatch[1]);
    }

    return json({ error: "Not found" }, 404);
  },

  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const domain = normalizeDomain(env.MAIL_DOMAIN || "");
        const address = normalizeAddress(message.to || "");

        if (!domain || !address.endsWith(`@${domain}`)) return;

        const activeToken = await env.MAILBOXES.get(addressKey(address));
        if (!activeToken) return;

        const raw = await new Response(message.raw).arrayBuffer();
        const parser = new PostalMime.default();
        const parsed = await parser.parse(raw);

        const text = typeof parsed.text === "string" ? parsed.text : "";
        const html = typeof parsed.html === "string" ? parsed.html : "";
        const body = [text, html].filter(Boolean).join("\n");

        const item: StoredMessage = {
          id: parsed.messageId || crypto.randomUUID(),
          from: normalizeAddress(message.from || ""),
          to: address,
          subject: parsed.subject || "",
          body,
          text,
          html,
          receivedAt: new Date().toISOString(),
        };

        const inbox = await readInbox(env, address);
        inbox.unshift(item);
        await writeInbox(env, address, inbox);
      })(),
    );
  },
};
