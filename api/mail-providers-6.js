const { randomUUID } = require("crypto");

const MAIL_PROVIDERS = [
  {
    name: "Mail.tm",
    type: "mailtm",
    baseUrl: "https://api.mail.tm",
  },
  {
    name: "Mail.gw",
    type: "mailtm",
    baseUrl: "https://api.mail.gw",
  },
  {
    name: "TempMail.ing",
    type: "tempmailing",
    baseUrl: "https://api.tempmail.ing/api",
  },
  {
    name: "NonMail",
    type: "nonmail",
    baseUrl: "https://api.nonmail.com/v1",
  },
  {
    name: "smails",
    type: "smails",
    baseUrl: "https://smails.dev/api",
  },
  {
    name: "DropMail",
    type: "dropmail",
    baseUrl: "https://dropmail.me/api/graphql/",
  },
  {
    name: "Guerrilla Mail",
    type: "guerrilla",
    baseUrl: "https://api.guerrillamail.com/ajax.php",
  },
  {
    name: "Mailsac",
    type: "mailsac",
    baseUrl: "https://mailsac.com",
    requiresEnv: "MAILSAC_API_KEY",
  },
  ...String(process.env.MAIL_PROVIDER_URLS || "")
    .split(",")
    .map((baseUrl) => baseUrl.trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .map((baseUrl, index) => ({
      name: `Custom Mail ${index + 1}`,
      type: "mailtm",
      baseUrl,
    })),
  {
    name: "Maildrop.cc",
    type: "maildropcc",
    baseUrl: "https://api.maildrop.cc/graphql",
    pollIntervalMs: 10_000,
  },
  {
    name: "Catchmail",
    type: "catchmail",
    baseUrl: "https://api.catchmail.io/api/v1",
  },
  {
    name: "Inboxes",
    type: "inboxes",
    baseUrl: "https://inboxes.com/api/v2",
  },
  {
    name: "HarakiriMail",
    type: "harakirimail",
    baseUrl: "https://harakirimail.com/api/v1",
  },
  {
    name: "TempMail.plus",
    type: "tempmailplus",
    baseUrl: "https://tempmail.plus/api/mails",
  },
  {
    name: "Mailinator Public",
    type: "mailinator",
    baseUrl: "https://mailinator.com/api/v2",
  },
  {
    name: "MailSlurp",
    type: "mailslurp",
    baseUrl: "https://api.mailslurp.com",
    requiresEnv: "MAILSLURP_API_KEY",
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCsvEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeProviderName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function envInteger(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] || "", 10);

  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function getConfiguredProviders() {
  const only = new Set(
    parseCsvEnv("MAIL_PROVIDER_ONLY").map(normalizeProviderName),
  );
  const skip = new Set(
    parseCsvEnv("MAIL_PROVIDER_SKIP").map(normalizeProviderName),
  );
  const order = parseCsvEnv("MAIL_PROVIDER_ORDER").map(
    normalizeProviderName,
  );

  const orderIndex = new Map(
    order.map((name, index) => [name, index]),
  );

  return MAIL_PROVIDERS
    .filter((provider) => {
      if (
        provider.requiresEnv &&
        !String(process.env[provider.requiresEnv] || "").trim()
      ) {
        return false;
      }

      const name = normalizeProviderName(provider.name);

      if (only.size && !only.has(name)) return false;
      if (skip.has(name)) return false;

      return true;
    })
    .map((provider, originalIndex) => ({
      provider,
      originalIndex,
    }))
    .sort((left, right) => {
      const leftName = normalizeProviderName(left.provider.name);
      const rightName = normalizeProviderName(right.provider.name);
      const leftOrder = orderIndex.has(leftName)
        ? orderIndex.get(leftName)
        : Number.MAX_SAFE_INTEGER;
      const rightOrder = orderIndex.has(rightName)
        ? orderIndex.get(rightName)
        : Number.MAX_SAFE_INTEGER;

      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.originalIndex - right.originalIndex;
    })
    .map(({ provider }) => provider);
}

function generateSN() {
  return randomUUID().replace(/-/g, "").toLowerCase();
}

function generatePassword() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$";
  let password = "";

  for (let i = 0; i < 12; i++) {
    password += chars[Math.floor(Math.random() * chars.length)];
  }

  return password;
}

function generateMailboxLocal(length = 12) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let local = "rcn";

  for (let i = 0; i < length; i++) {
    local += chars[Math.floor(Math.random() * chars.length)];
  }

  return local;
}

function getMailboxLocal(address) {
  return String(address || "").split("@", 1)[0].trim();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(response, label) {
  const raw = await response.text();

  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`${label}: provider returned invalid JSON`);
    }
  }

  if (!response.ok) {
    throw new Error(`${label}: HTTP ${response.status}`);
  }

  return data;
}

async function mailRequest(provider, path, options, label) {
  const response = await fetchWithTimeout(
    `${provider.baseUrl}${path}`,
    options,
  );

  return readJsonResponse(response, `${provider.name} ${label}`);
}

function normalizeMailBody(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeMailBody).join(" ");
  }

  if (typeof value === "string") return value;

  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  return "";
}

function extractVerificationCode(value) {
  const text = String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ");

  const sixDigits = text.match(/\b\d{6}\b/);
  if (sixDigits) return sixDigits[0];

  const groupedDigits = text.match(/\b(\d{3})[-\s](\d{3})\b/);
  if (groupedDigits) return `${groupedDigits[1]}${groupedDigits[2]}`;

  return null;
}

function tempMailIngHeaders() {
  return {
    "Content-Type": "application/json",
    Referer: "https://tempmail.ing/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/143.0.0.0 Safari/537.36",
  };
}

async function getMailTmMessages(provider, mailbox) {
  const headers = {
    Authorization: `Bearer ${mailbox.token}`,
    "Content-Type": "application/json",
  };

  const inbox = await mailRequest(
    provider,
    "/messages?page=1",
    { headers },
    "inbox polling",
  );

  const messages = inbox["hydra:member"] || [];
  const fullMessages = [];

  for (const message of messages.slice(0, 5)) {
    const full = await mailRequest(
      provider,
      `/messages/${message.id}`,
      { headers },
      "message reading",
    );

    fullMessages.push(full);
  }

  return fullMessages;
}

async function getTempMailIngMessages(provider, mailbox) {
  const response = await fetchWithTimeout(
    `${provider.baseUrl}/emails/${encodeURIComponent(mailbox.address)}`,
    {
      method: "GET",
      headers: tempMailIngHeaders(),
    },
  );

  const data = await readJsonResponse(
    response,
    `${provider.name} inbox polling`,
  );

  if (!data.success) {
    throw new Error(`${provider.name}: inbox request was rejected`);
  }

  return data.emails || [];
}

async function getNonMailMessages(provider, mailbox) {
  const headers = {
    Authorization: `Bearer ${mailbox.token}`,
    "Content-Type": "application/json",
  };

  const inbox = await mailRequest(
    provider,
    "/email/inbox",
    { headers },
    "inbox polling",
  );

  if (inbox.status !== "success") {
    throw new Error(`${provider.name}: inbox request was rejected`);
  }

  const summaries = Array.isArray(inbox.emails) ? inbox.emails : [];
  const fullMessages = [];

  for (const summary of summaries.slice(0, 5)) {
    if (!summary?.id) {
      fullMessages.push(summary);
      continue;
    }

    const full = await mailRequest(
      provider,
      `/email/message/${encodeURIComponent(summary.id)}`,
      { headers },
      "message reading",
    );

    fullMessages.push(full);
  }

  return fullMessages;
}

async function getSmailsMessages(provider, mailbox) {
  const headers = {
    Authorization: `Bearer ${mailbox.token}`,
    "Content-Type": "application/json",
  };

  const response = await fetchWithTimeout(
    `${provider.baseUrl}/mailbox/messages`,
    {
      method: "GET",
      headers,
    },
  );

  const inbox = await readJsonResponse(
    response,
    `${provider.name} inbox polling`,
  );

  const summaries = Array.isArray(inbox)
    ? inbox
    : Array.isArray(inbox.messages)
      ? inbox.messages
      : Array.isArray(inbox.data)
        ? inbox.data
        : [];

  const fullMessages = [];

  for (const summary of summaries.slice(0, 5)) {
    const messageId =
      summary?.id || summary?.messageId || summary?.message_id;

    if (!messageId) {
      fullMessages.push(summary);
      continue;
    }

    const fullResponse = await fetchWithTimeout(
      `${provider.baseUrl}/mailbox/messages/${encodeURIComponent(messageId)}`,
      {
        method: "GET",
        headers,
      },
    );

    const full = await readJsonResponse(
      fullResponse,
      `${provider.name} message reading`,
    );

    fullMessages.push(full);
  }

  return fullMessages;
}

async function dropMailGraphql(provider, query, variables = {}) {
  const response = await fetchWithTimeout(
    provider.baseUrl,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  const payload = await readJsonResponse(
    response,
    `${provider.name} GraphQL request`,
  );

  if (Array.isArray(payload.errors) && payload.errors.length) {
    const message = payload.errors
      .map((error) => error?.message || "unknown GraphQL error")
      .join(" | ");

    throw new Error(`${provider.name}: ${message}`);
  }

  return payload.data || {};
}

async function getDropMailMessages(provider, mailbox) {
  const data = await dropMailGraphql(
    provider,
    `
      query ReadDropMailSession($id: ID!) {
        session(id: $id) {
          mails {
            id
            text
            html
            headerSubject
            fromAddr
            toAddr
          }
        }
      }
    `,
    { id: mailbox.sessionId },
  );

  const messages = data.session?.mails || [];

  return messages.map((message) => ({
    ...message,
    subject: message.headerSubject || "",
    from: message.fromAddr || "",
    to: message.toAddr || "",
  }));
}

function guerrillaRequestUrl(provider, action, params = {}) {
  const query = new URLSearchParams({
    f: action,
    ip: process.env.GUERRILLA_API_IP || "127.0.0.1",
    agent:
      process.env.GUERRILLA_API_AGENT ||
      "EmberCloud-Mail-Provider-Test",
    ...params,
  });

  return `${provider.baseUrl}?${query.toString()}`;
}

function updateGuerrillaCookie(response, mailbox) {
  const cookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);

  for (const cookie of cookies) {
    const match = String(cookie).match(/PHPSESSID=([^;]+)/i);
    if (match) {
      mailbox.cookie = `PHPSESSID=${match[1]}`;
      return;
    }
  }
}

async function guerrillaRequest(
  provider,
  mailbox,
  action,
  params = {},
) {
  const response = await fetchWithTimeout(
    guerrillaRequestUrl(provider, action, params),
    {
      method: "GET",
      headers: mailbox.cookie
        ? { Cookie: mailbox.cookie }
        : undefined,
    },
  );

  updateGuerrillaCookie(response, mailbox);

  return readJsonResponse(
    response,
    `${provider.name} ${action}`,
  );
}

async function getGuerrillaMessages(provider, mailbox) {
  const inbox = await guerrillaRequest(
    provider,
    mailbox,
    "get_email_list",
    {
      offset: "0",
      seq: "0",
    },
  );

  const summaries = Array.isArray(inbox.list) ? inbox.list : [];
  const fullMessages = [];

  for (const summary of summaries.slice(0, 5)) {
    const messageId = summary?.mail_id;

    if (!messageId) {
      fullMessages.push(summary);
      continue;
    }

    const full = await guerrillaRequest(
      provider,
      mailbox,
      "fetch_email",
      {
        email_id: String(messageId),
      },
    );

    fullMessages.push({
      ...summary,
      ...full,
      subject: full.mail_subject || summary.mail_subject || "",
      text:
        full.mail_body ||
        full.mail_excerpt ||
        summary.mail_excerpt ||
        "",
      html: full.mail_body || "",
    });
  }

  return fullMessages;
}

async function getMailsacMessages(provider, mailbox) {
  const key = process.env.MAILSAC_API_KEY;
  if (!key) {
    throw new Error(`${provider.name}: MAILSAC_API_KEY is missing`);
  }

  const headers = {
    "Mailsac-Key": key,
  };

  const inboxResponse = await fetchWithTimeout(
    `${provider.baseUrl}/api/addresses/${encodeURIComponent(
      mailbox.address,
    )}/messages`,
    {
      method: "GET",
      headers,
    },
  );

  const summaries = await readJsonResponse(
    inboxResponse,
    `${provider.name} inbox polling`,
  );

  const messages = Array.isArray(summaries) ? summaries : [];
  const fullMessages = [];

  for (const summary of messages.slice(0, 5)) {
    const messageId = summary?._id;

    if (!messageId) {
      fullMessages.push(summary);
      continue;
    }

    const textResponse = await fetchWithTimeout(
      `${provider.baseUrl}/api/text/${encodeURIComponent(
        mailbox.address,
      )}/${encodeURIComponent(messageId)}`,
      {
        method: "GET",
        headers,
      },
    );

    const text = await textResponse.text();

    if (!textResponse.ok) {
      throw new Error(
        `${provider.name} message reading: HTTP ${textResponse.status}`,
      );
    }

    fullMessages.push({
      ...summary,
      text,
      subject: summary.subject || "",
    });
  }

  return fullMessages;
}

async function maildropCcGraphql(
  provider,
  query,
  variables = {},
) {
  const response = await fetchWithTimeout(
    provider.baseUrl,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: "https://maildrop.cc",
        Referer: "https://maildrop.cc/",
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  const payload = await readJsonResponse(
    response,
    `${provider.name} GraphQL request`,
  );

  if (Array.isArray(payload.errors) && payload.errors.length) {
    const message = payload.errors
      .map((error) => error?.message || "unknown GraphQL error")
      .join(" | ");

    throw new Error(`${provider.name}: ${message}`);
  }

  return payload.data || {};
}

async function getMaildropCcMessages(provider, mailbox) {
  const local = getMailboxLocal(mailbox.address);

  if (!local) {
    throw new Error(`${provider.name}: mailbox address is missing`);
  }

  const data = await maildropCcGraphql(
    provider,
    `
      query MaildropInbox($mailbox: String!) {
        inbox(mailbox: $mailbox) {
          id
          headerfrom
          subject
          date
        }
      }
    `,
    { mailbox: local },
  );

  const summaries = Array.isArray(data.inbox) ? data.inbox : [];
  const messages = [];

  for (const summary of summaries.slice(0, 5)) {
    let full = summary;

    if (summary?.id) {
      try {
        const detail = await maildropCcGraphql(
          provider,
          `
            query MaildropMessage($mailbox: String!, $id: String!) {
              message(mailbox: $mailbox, id: $id) {
                id
                headerfrom
                subject
                date
                data
                html
              }
            }
          `,
          {
            mailbox: local,
            id: String(summary.id),
          },
        );

        if (detail.message) full = detail.message;
      } catch {
        // The inbox summary is still useful if a detail request races expiry.
      }
    }

    messages.push({
      ...summary,
      ...full,
      from: full.headerfrom || summary.headerfrom || "",
      text: full.data || "",
      html: full.html || "",
    });
  }

  return messages;
}

function catchmailHeaders() {
  return {
    Accept: "application/json",
    Origin: "https://catchmail.io",
    Referer: "https://catchmail.io/",
  };
}

async function getCatchmailMessages(provider, mailbox) {
  const inboxResponse = await fetchWithTimeout(
    `${provider.baseUrl}/mailbox?address=${encodeURIComponent(
      mailbox.address,
    )}`,
    {
      method: "GET",
      headers: catchmailHeaders(),
    },
  );

  const inbox = await readJsonResponse(
    inboxResponse,
    `${provider.name} inbox polling`,
  );

  const summaries = Array.isArray(inbox)
    ? inbox
    : Array.isArray(inbox.messages)
      ? inbox.messages
      : [];
  const messages = [];

  for (const summary of summaries.slice(0, 5)) {
    let full = summary;

    if (summary?.id) {
      try {
        const detailResponse = await fetchWithTimeout(
          `${provider.baseUrl}/message/${encodeURIComponent(
            summary.id,
          )}?mailbox=${encodeURIComponent(mailbox.address)}`,
          {
            method: "GET",
            headers: catchmailHeaders(),
          },
        );
        const detail = await readJsonResponse(
          detailResponse,
          `${provider.name} message reading`,
        );

        full = detail.message || detail;
      } catch {
        // Preserve the list row when a message disappears between requests.
      }
    }

    messages.push({
      ...summary,
      ...full,
      from: full.from || summary.from || "",
      to: full.to || full.mailbox || mailbox.address,
      subject: full.subject || summary.subject || "",
      text:
        full.body?.text ||
        full.text ||
        full.body_text ||
        "",
      html:
        full.body?.html ||
        full.html ||
        full.body_html ||
        "",
    });
  }

  return messages;
}

function inboxesHeaders() {
  return {
    Accept: "application/json",
    Origin: "https://inboxes.com",
    Referer: "https://inboxes.com/",
  };
}

async function getInboxesMessages(provider, mailbox) {
  const inboxResponse = await fetchWithTimeout(
    `${provider.baseUrl}/inbox/${encodeURIComponent(mailbox.address)}`,
    {
      method: "GET",
      headers: inboxesHeaders(),
    },
  );

  const inbox = await readJsonResponse(
    inboxResponse,
    `${provider.name} inbox polling`,
  );
  const summaries = Array.isArray(inbox.msgs)
    ? inbox.msgs
    : Array.isArray(inbox.messages)
      ? inbox.messages
      : [];
  const messages = [];

  for (const summary of summaries.slice(0, 5)) {
    const messageId = summary?.uid || summary?.id;
    let full = summary;

    if (messageId) {
      try {
        const detailResponse = await fetchWithTimeout(
          `${provider.baseUrl}/message/${encodeURIComponent(
            messageId,
          )}`,
          {
            method: "GET",
            headers: inboxesHeaders(),
          },
        );
        const detail = await readJsonResponse(
          detailResponse,
          `${provider.name} message reading`,
        );

        full = detail.message || detail;
      } catch {
        // Preserve the summary if the full message is no longer available.
      }
    }

    messages.push({
      ...summary,
      ...full,
      id: full.uid || full.id || messageId || "",
      from:
        full.sf ||
        full.f ||
        full.from ||
        summary.sf ||
        summary.f ||
        "",
      to: full.ib || full.to || mailbox.address,
      subject: full.s || full.subject || summary.s || "",
      text: full.text || full.ph || summary.ph || "",
      html: full.html || "",
    });
  }

  return messages;
}

function harakiriHeaders() {
  return {
    Accept: "application/json",
    Referer: "https://harakirimail.com/",
  };
}

async function getHarakiriMessages(provider, mailbox) {
  const local = getMailboxLocal(mailbox.address);
  const inboxResponse = await fetchWithTimeout(
    `${provider.baseUrl}/inbox/${encodeURIComponent(local)}`,
    {
      method: "GET",
      headers: harakiriHeaders(),
    },
  );

  const inbox = await readJsonResponse(
    inboxResponse,
    `${provider.name} inbox polling`,
  );
  const summaries = Array.isArray(inbox.emails)
    ? inbox.emails
    : Array.isArray(inbox)
      ? inbox
      : [];
  const messages = [];

  for (const summary of summaries.slice(0, 5)) {
    const messageId = summary?._id || summary?.id;
    let full = summary;

    if (
      messageId &&
      !summary.body &&
      !summary.text &&
      !summary.html &&
      !summary.body_html
    ) {
      try {
        const detailResponse = await fetchWithTimeout(
          `${provider.baseUrl}/email/${encodeURIComponent(messageId)}`,
          {
            method: "GET",
            headers: harakiriHeaders(),
          },
        );
        const detail = await readJsonResponse(
          detailResponse,
          `${provider.name} message reading`,
        );

        full = detail.message || detail;
      } catch {
        // Preserve the list row when the provider has already expired it.
      }
    }

    messages.push({
      ...summary,
      ...full,
      id: full._id || full.id || messageId || "",
      from: full.from || summary.from || "",
      to: full.to || mailbox.address,
      subject: full.subject || summary.subject || "",
      text: full.text || full.body || "",
      html: full.html || full.body_html || full.body || "",
    });
  }

  return messages;
}

function tempMailPlusHeaders() {
  return {
    Accept: "application/json",
    Origin: "https://tempmail.plus",
    Referer: "https://tempmail.plus/",
  };
}

async function getTempMailPlusMessages(provider, mailbox) {
  const inboxResponse = await fetchWithTimeout(
    `${provider.baseUrl}/?email=${encodeURIComponent(
      mailbox.address,
    )}&epin=`,
    {
      method: "GET",
      headers: tempMailPlusHeaders(),
    },
  );

  const inbox = await readJsonResponse(
    inboxResponse,
    `${provider.name} inbox polling`,
  );
  const summaries = Array.isArray(inbox.mail_list)
    ? inbox.mail_list
    : [];
  const messages = [];

  for (const summary of summaries.slice(0, 5)) {
    let full = summary;

    if (summary?.mail_id) {
      try {
        const detailResponse = await fetchWithTimeout(
          `${provider.baseUrl}/${encodeURIComponent(
            summary.mail_id,
          )}?email=${encodeURIComponent(mailbox.address)}&epin=`,
          {
            method: "GET",
            headers: tempMailPlusHeaders(),
          },
        );
        const detail = await readJsonResponse(
          detailResponse,
          `${provider.name} message reading`,
        );

        full = detail.message || detail;
      } catch {
        // Preserve the summary if full content expires first.
      }
    }

    messages.push({
      ...summary,
      ...full,
      id: full.mail_id || summary.mail_id || "",
      from:
        full.from_mail ||
        full.from_name ||
        summary.from_mail ||
        "",
      to: full.to || mailbox.address,
      subject: full.subject || summary.subject || "",
      text: full.text || "",
      html: full.html || "",
    });
  }

  return messages;
}

async function getMailinatorMessages(provider, mailbox) {
  const local = getMailboxLocal(mailbox.address);
  const inbox = await mailRequest(
    provider,
    `/domains/public/inboxes/${encodeURIComponent(local)}`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
    },
    "inbox polling",
  );

  const summaries = Array.isArray(inbox)
    ? inbox
    : Array.isArray(inbox.msgs)
      ? inbox.msgs
      : Array.isArray(inbox.data)
        ? inbox.data
        : [];
  const messages = [];

  for (const summary of summaries.slice(0, 5)) {
    const messageId = summary?.id || summary?.messageId;
    let text = "";
    let html = "";

    if (messageId) {
      try {
        const textPayload = await mailRequest(
          provider,
          `/domains/public/messages/${encodeURIComponent(
            messageId,
          )}/text`,
          {
            method: "GET",
            headers: { Accept: "application/json" },
          },
          "message reading",
        );

        text = textPayload.text || textPayload["text/plain"] || "";
      } catch {
        // Some messages expose only an HTML body.
      }

      if (!text) {
        try {
          const htmlPayload = await mailRequest(
            provider,
            `/domains/public/messages/${encodeURIComponent(
              messageId,
            )}/texthtml`,
            {
              method: "GET",
              headers: { Accept: "application/json" },
            },
            "HTML message reading",
          );

          html = htmlPayload.html || htmlPayload["text/html"] || "";
        } catch {
          // The summary can still be scanned for a subject-line code.
        }
      }
    }

    messages.push({
      ...summary,
      id: messageId || "",
      from: summary.from || summary.origfrom || "",
      to: summary.to || mailbox.address,
      subject: summary.subject || "",
      text,
      html,
    });
  }

  return messages;
}

function mailSlurpHeaders() {
  const key = String(process.env.MAILSLURP_API_KEY || "").trim();

  if (!key) {
    throw new Error("MailSlurp: MAILSLURP_API_KEY is missing");
  }

  return {
    Accept: "application/json",
    "x-api-key": key,
  };
}

async function getMailSlurpMessages(provider, mailbox) {
  const inboxResponse = await fetchWithTimeout(
    `${provider.baseUrl}/inboxes/${encodeURIComponent(
      mailbox.inboxId,
    )}/emails?size=5&sort=DESC`,
    {
      method: "GET",
      headers: mailSlurpHeaders(),
    },
  );

  const inbox = await readJsonResponse(
    inboxResponse,
    `${provider.name} inbox polling`,
  );
  const summaries = Array.isArray(inbox)
    ? inbox
    : Array.isArray(inbox.content)
      ? inbox.content
      : [];
  const messages = [];

  for (const summary of summaries.slice(0, 5)) {
    let full = summary;

    if (summary?.id) {
      try {
        const detailResponse = await fetchWithTimeout(
          `${provider.baseUrl}/emails/${encodeURIComponent(summary.id)}`,
          {
            method: "GET",
            headers: mailSlurpHeaders(),
          },
        );
        const detail = await readJsonResponse(
          detailResponse,
          `${provider.name} message reading`,
        );

        full = detail.email || detail;
      } catch {
        // Keep the preview if the detail endpoint is briefly unavailable.
      }
    }

    messages.push({
      ...summary,
      ...full,
      from: full.from || summary.from || "",
      to: full.to || summary.to || mailbox.address,
      subject: full.subject || summary.subject || "",
      text:
        full.text ||
        full.bodyExcerpt ||
        (full.isHTML ? "" : full.body) ||
        "",
      html: full.html || (full.isHTML ? full.body : "") || "",
    });
  }

  return messages;
}

function getMessagesForProvider(provider, mailbox) {
  switch (provider.type) {
    case "tempmailing":
      return getTempMailIngMessages(provider, mailbox);
    case "nonmail":
      return getNonMailMessages(provider, mailbox);
    case "smails":
      return getSmailsMessages(provider, mailbox);
    case "dropmail":
      return getDropMailMessages(provider, mailbox);
    case "guerrilla":
      return getGuerrillaMessages(provider, mailbox);
    case "mailsac":
      return getMailsacMessages(provider, mailbox);
    case "maildropcc":
      return getMaildropCcMessages(provider, mailbox);
    case "catchmail":
      return getCatchmailMessages(provider, mailbox);
    case "inboxes":
      return getInboxesMessages(provider, mailbox);
    case "harakirimail":
      return getHarakiriMessages(provider, mailbox);
    case "tempmailplus":
      return getTempMailPlusMessages(provider, mailbox);
    case "mailinator":
      return getMailinatorMessages(provider, mailbox);
    case "mailslurp":
      return getMailSlurpMessages(provider, mailbox);
    default:
      return getMailTmMessages(provider, mailbox);
  }
}

async function waitForVerificationCode(
  provider,
  mailbox,
  maxRetries = envInteger(
    "MAIL_PROVIDER_POLL_RETRIES",
    24,
    1,
    60,
  ),
) {
  const configuredPollMs = envInteger(
    "MAIL_PROVIDER_POLL_MS",
    2_500,
    750,
    10_000,
  );
  const pollMs = Math.max(
    configuredPollMs,
    Number(provider.pollIntervalMs) || 0,
  );
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await sleep(pollMs);

    try {
      const messages = await getMessagesForProvider(
        provider,
        mailbox,
      );

      for (const message of messages.slice(0, 5)) {
        const body = [
          normalizeMailBody(message.text),
          normalizeMailBody(message.html),
          normalizeMailBody(message.content),
          normalizeMailBody(message.body),
          normalizeMailBody(message.body_text),
          normalizeMailBody(message.body_html),
          normalizeMailBody(message.textBody),
          normalizeMailBody(message.htmlBody),
          normalizeMailBody(message.body_preview),
          message.subject || "",
          message.intro || "",
        ].join(" ");

        const code = extractVerificationCode(body);
        if (code) return code;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw new Error(
      `${provider.name} verification timed out (${lastError.message})`,
    );
  }

  throw new Error(`${provider.name} verification email timed out`);
}

async function createMailTmMailbox(provider) {
  const domainData = await mailRequest(
    provider,
    "/domains?page=1",
    undefined,
    "domain lookup",
  );

  const domains = (domainData["hydra:member"] || []).filter(
    (domain) => domain?.domain && domain.isActive !== false,
  );

  if (!domains.length) {
    throw new Error(`${provider.name}: no active domains available`);
  }

  const domain =
    domains[Math.floor(Math.random() * domains.length)].domain;
  const username = `rcn_${Math.random().toString(36).slice(2, 11)}`;
  const address = `${username}@${domain}`;
  const password = generatePassword();

  await mailRequest(
    provider,
    "/accounts",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, password }),
    },
    "mailbox creation",
  );

  const tokenData = await mailRequest(
    provider,
    "/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, password }),
    },
    "mailbox authentication",
  );

  if (!tokenData.token) {
    throw new Error(`${provider.name}: mailbox token missing`);
  }

  return {
    provider,
    address,
    token: tokenData.token,
  };
}

async function createTempMailIngMailbox(provider) {
  const response = await fetchWithTimeout(
    `${provider.baseUrl}/generate`,
    {
      method: "POST",
      headers: tempMailIngHeaders(),
      body: JSON.stringify({ duration: 30 }),
    },
  );

  const data = await readJsonResponse(
    response,
    `${provider.name} mailbox creation`,
  );

  const address = data.email?.address;

  if (!data.success || !address) {
    throw new Error(`${provider.name}: mailbox creation was rejected`);
  }

  return {
    provider,
    address,
    token: null,
  };
}

async function createNonMailMailbox(provider) {
  const prefix = `rcn_${Math.random().toString(36).slice(2, 11)}`;

  const response = await fetchWithTimeout(
    `${provider.baseUrl}/email/create`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        duration: 300,
        prefix,
      }),
    },
  );

  const data = await readJsonResponse(
    response,
    `${provider.name} mailbox creation`,
  );

  if (
    data.status !== "success" ||
    !data.email ||
    !data.token
  ) {
    throw new Error(`${provider.name}: mailbox creation was rejected`);
  }

  return {
    provider,
    address: data.email,
    token: data.token,
  };
}

async function createSmailsMailbox(provider) {
  const response = await fetchWithTimeout(
    `${provider.baseUrl}/mailbox`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
  );

  const data = await readJsonResponse(
    response,
    `${provider.name} mailbox creation`,
  );

  if (!data.address || !data.token) {
    throw new Error(`${provider.name}: mailbox creation was rejected`);
  }

  return {
    provider,
    address: data.address,
    token: data.token,
  };
}

async function createDropMailMailbox(provider) {
  const data = await dropMailGraphql(
    provider,
    `
      mutation CreateDropMailSession {
        introduceSession(
          input: {
            withAddress: true
            permanentDomainOnly: true
          }
        ) {
          id
          addresses {
            address
          }
        }
      }
    `,
  );

  const session = data.introduceSession;
  const address = session?.addresses?.[0]?.address;

  if (!session?.id || !address) {
    throw new Error(`${provider.name}: mailbox creation was rejected`);
  }

  return {
    provider,
    address,
    sessionId: session.id,
    token: null,
  };
}

async function createGuerrillaMailbox(provider) {
  const mailbox = {
    provider,
    address: "",
    cookie: "",
    token: null,
  };

  const data = await guerrillaRequest(
    provider,
    mailbox,
    "get_email_address",
    {
      lang: "en",
    },
  );

  if (!data.email_addr || !mailbox.cookie) {
    throw new Error(`${provider.name}: mailbox creation was rejected`);
  }

  mailbox.address = data.email_addr;
  return mailbox;
}

async function createMailsacMailbox(provider) {
  const key = String(process.env.MAILSAC_API_KEY || "").trim();

  if (!key) {
    throw new Error(`${provider.name}: MAILSAC_API_KEY is missing`);
  }

  const prefix = `rcn_${Math.random().toString(36).slice(2, 13)}`;

  return {
    provider,
    address: `${prefix}@mailsac.com`,
    token: key,
  };
}

async function createMaildropCcMailbox(provider) {
  return {
    provider,
    address: `${generateMailboxLocal()}@maildrop.cc`,
    token: null,
  };
}

async function createCatchmailMailbox(provider) {
  const address = `${generateMailboxLocal()}@catchmail.io`;
  const response = await fetchWithTimeout(
    `${provider.baseUrl}/mailbox?address=${encodeURIComponent(address)}`,
    {
      method: "GET",
      headers: catchmailHeaders(),
    },
  );

  await readJsonResponse(
    response,
    `${provider.name} mailbox creation`,
  );

  return {
    provider,
    address,
    token: null,
  };
}

async function createInboxesMailbox(provider) {
  const response = await fetchWithTimeout(
    `${provider.baseUrl}/domain`,
    {
      method: "GET",
      headers: inboxesHeaders(),
    },
  );
  const data = await readJsonResponse(
    response,
    `${provider.name} domain lookup`,
  );
  const domains = (Array.isArray(data.domains) ? data.domains : [])
    .map((domain) =>
      String(domain?.qdn || domain?.domain || domain || "")
        .trim()
        .toLowerCase(),
    )
    .filter(
      (domain) =>
        domain.includes(".") &&
        !domain.includes("..") &&
        !/\s/.test(domain),
    );

  if (!domains.length) {
    throw new Error(`${provider.name}: no active domains available`);
  }

  const domain = domains.includes("blondmail.com")
    ? "blondmail.com"
    : domains[0];

  return {
    provider,
    address: `${generateMailboxLocal()}@${domain}`,
    token: null,
  };
}

async function createHarakiriMailbox(provider) {
  const local = generateMailboxLocal();
  const response = await fetchWithTimeout(
    `${provider.baseUrl}/inbox/${encodeURIComponent(local)}`,
    {
      method: "GET",
      headers: harakiriHeaders(),
    },
  );

  await readJsonResponse(
    response,
    `${provider.name} mailbox creation`,
  );

  return {
    provider,
    address: `${local}@harakirimail.com`,
    token: null,
  };
}

async function createTempMailPlusMailbox(provider) {
  const address = `${generateMailboxLocal()}@mailto.plus`;
  const response = await fetchWithTimeout(
    `${provider.baseUrl}/?email=${encodeURIComponent(address)}&epin=`,
    {
      method: "GET",
      headers: tempMailPlusHeaders(),
    },
  );

  await readJsonResponse(
    response,
    `${provider.name} mailbox creation`,
  );

  return {
    provider,
    address,
    token: null,
  };
}

async function createMailinatorMailbox(provider) {
  return {
    provider,
    address: `${generateMailboxLocal()}@mailinator.com`,
    token: null,
  };
}

async function createMailSlurpMailbox(provider) {
  const response = await fetchWithTimeout(
    `${provider.baseUrl}/inboxes?expiresIn=600000&useDomainPool=true`,
    {
      method: "POST",
      headers: mailSlurpHeaders(),
    },
  );
  const data = await readJsonResponse(
    response,
    `${provider.name} mailbox creation`,
  );

  if (!data.id || !data.emailAddress) {
    throw new Error(`${provider.name}: mailbox creation was rejected`);
  }

  return {
    provider,
    address: data.emailAddress,
    inboxId: data.id,
    token: String(process.env.MAILSLURP_API_KEY || "").trim(),
  };
}

async function createMailbox(provider) {
  switch (provider.type) {
    case "tempmailing":
      return createTempMailIngMailbox(provider);
    case "nonmail":
      return createNonMailMailbox(provider);
    case "smails":
      return createSmailsMailbox(provider);
    case "dropmail":
      return createDropMailMailbox(provider);
    case "guerrilla":
      return createGuerrillaMailbox(provider);
    case "mailsac":
      return createMailsacMailbox(provider);
    case "maildropcc":
      return createMaildropCcMailbox(provider);
    case "catchmail":
      return createCatchmailMailbox(provider);
    case "inboxes":
      return createInboxesMailbox(provider);
    case "harakirimail":
      return createHarakiriMailbox(provider);
    case "tempmailplus":
      return createTempMailPlusMailbox(provider);
    case "mailinator":
      return createMailinatorMailbox(provider);
    case "mailslurp":
      return createMailSlurpMailbox(provider);
    default:
      return createMailTmMailbox(provider);
  }
}

async function registerRaccoonAccount(mailbox) {
  const raccoonPassword = generatePassword();
  const sn = generateSN();

  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/147.0.0.0 Safari/537.36",
  };

  const base = {
    sn,
    model: "Chrome/147.0.0.0",
    version_code: "1",
    version_name: "1.0.0",
    device_name: "我的设备",
    os: "web",
  };

  const sendEmailResponse = await fetchWithTimeout(
    "https://www.raccoongame.com/users/sendEmail",
    {
      method: "POST",
      headers,
      body: new URLSearchParams({
        email: mailbox.address,
        type: "register",
        ...base,
      }),
    },
  );

  if (!sendEmailResponse.ok) {
    throw new Error(
      `Raccoon verification request failed: HTTP ${sendEmailResponse.status}`,
    );
  }

  const code = await waitForVerificationCode(
    mailbox.provider,
    mailbox,
  );

  const registerResponse = await fetchWithTimeout(
    "https://www.raccoongame.com/users/emailRegister",
    {
      method: "POST",
      headers,
      body: new URLSearchParams({
        email: mailbox.address,
        code,
        password: raccoonPassword,
        phone: "1",
        country: "Brazil",
        ...base,
      }),
    },
  );

  if (!registerResponse.ok) {
    throw new Error(
      `Raccoon registration failed: HTTP ${registerResponse.status}`,
    );
  }

  const loginResponse = await fetchWithTimeout(
    "https://www.raccoongame.com/users/emailLogin",
    {
      method: "POST",
      headers,
      body: new URLSearchParams({
        email: mailbox.address,
        password: raccoonPassword,
        ...base,
      }),
    },
  );

  if (!loginResponse.ok) {
    throw new Error(
      `Raccoon login failed: HTTP ${loginResponse.status}`,
    );
  }

  const loginData = await readJsonResponse(
    loginResponse,
    "Raccoon login",
  );

  if (loginData.status !== 200) {
    throw new Error("Raccoon login was rejected");
  }

  let userToken = loginData.data?.user_token || "";
  const cookie = loginResponse.headers.get("set-cookie");

  if (cookie) {
    const match = cookie.match(/as_user_token=([^;]+)/);
    if (match) userToken = match[1];
  }

  if (!userToken) {
    throw new Error("Raccoon login returned no user token");
  }

  return { sn, token: userToken };
}

async function createAccount() {
  const errors = [];
  const providers = getConfiguredProviders();

  if (!providers.length) {
    throw new Error(
      "No mail providers are enabled. Check MAIL_PROVIDER_ONLY, MAIL_PROVIDER_SKIP, and provider API-key settings.",
    );
  }

  console.log(
    `[mail] enabled providers: ${providers
      .map((provider) => provider.name)
      .join(" -> ")}`,
  );

  for (const provider of providers) {
    try {
      console.log(`[mail] trying ${provider.name}`);

      const mailbox = await createMailbox(provider);
      const account = await registerRaccoonAccount(mailbox);

      console.log(`[mail] ${provider.name} succeeded`);
      return account;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);

      errors.push(`${provider.name}: ${message}`);
      console.warn(`[mail] ${provider.name} failed; trying fallback`);

      await sleep(1_000);
    }
  }

  throw new Error(
    `All temporary-mail providers failed: ${errors.join(" | ")}`,
  );
}

async function testProvider(providerName) {
  const normalized = normalizeProviderName(providerName);
  const provider = getConfiguredProviders().find(
    (candidate) =>
      normalizeProviderName(candidate.name) === normalized,
  );

  if (!provider) {
    throw new Error(
      `Provider "${providerName}" is not enabled or does not exist.`,
    );
  }

  const mailbox = await createMailbox(provider);
  const messages = await getMessagesForProvider(provider, mailbox);

  return {
    ok: true,
    provider: provider.name,
    address: mailbox.address,
    inboxReadable: true,
    messageCount: Array.isArray(messages) ? messages.length : 0,
  };
}

function listProviders() {
  return getConfiguredProviders().map((provider) => ({
    name: provider.name,
    type: provider.type,
    requiresEnv: provider.requiresEnv || null,
  }));
}

if (require.main === module) {
  const providerName =
    process.argv.slice(2).join(" ").trim() ||
    process.env.MAIL_PROVIDER_ONLY;

  if (!providerName) {
    console.error(
      "Usage: node \"mail-providers 5.js\" \"DropMail\"",
    );
    process.exitCode = 2;
  } else {
    testProvider(providerName)
      .then((result) => {
        console.log(JSON.stringify(result, null, 2));
      })
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
  }
}

module.exports = {
  createAccount,
  listProviders,
  testProvider,
};
