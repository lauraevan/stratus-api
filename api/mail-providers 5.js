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
  const pollMs = envInteger(
    "MAIL_PROVIDER_POLL_MS",
    2_500,
    750,
    10_000,
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
