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
  if (Array.isArray(value)) return value.join(" ");
  return typeof value === "string" ? value : "";
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

async function waitForVerificationCode(
  provider,
  mailbox,
  maxRetries = 24,
) {
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await sleep(2_500);

    try {
      const messages =
        provider.type === "tempmailing"
          ? await getTempMailIngMessages(provider, mailbox)
          : await getMailTmMessages(provider, mailbox);

      for (const message of messages.slice(0, 5)) {
        const body = [
          normalizeMailBody(message.text),
          normalizeMailBody(message.html),
          normalizeMailBody(message.content),
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

async function createMailbox(provider) {
  if (provider.type === "tempmailing") {
    return createTempMailIngMailbox(provider);
  }

  return createMailTmMailbox(provider);
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

  for (const provider of MAIL_PROVIDERS) {
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

module.exports = {
  createAccount,
};
