const { readFileSync } = require("fs");
const path = require("path");

const DEFAULT_BASE_FIELDS = Object.freeze({
  model: "Chrome/147.0.0.0",
  version_code: "1",
  version_name: "1.0.0",
  device_name: "我的设备",
  os: "web",
  "manufacturer;": "",
});

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  return !["0", "false", "off", "no"].includes(raw);
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function loadActions() {
  const fromEnv = String(process.env.RACCOON_REWARD_ACTIONS || "").trim();
  if (fromEnv) {
    const parsed = safeJsonParse(fromEnv, null);
    if (!Array.isArray(parsed)) {
      throw new Error("RACCOON_REWARD_ACTIONS must be a JSON array");
    }
    return parsed;
  }

  const file = path.join(__dirname, "reward-actions.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeAction(action, index) {
  if (!action || typeof action !== "object") {
    throw new Error(`reward action #${index + 1} must be an object`);
  }

  const name = String(action.name || `reward-${index + 1}`).trim();
  const claim = action.claim && typeof action.claim === "object"
    ? action.claim
    : action;

  const claimPath = String(claim.path || "").trim();
  if (!claimPath.startsWith("/") || claimPath.startsWith("//")) {
    throw new Error(`${name}: claim path must be a Raccoon-relative path`);
  }

  let probe = null;
  if (action.probe && typeof action.probe === "object") {
    const probePath = String(action.probe.path || "").trim();
    if (!probePath.startsWith("/") || probePath.startsWith("//")) {
      throw new Error(`${name}: probe path must be a Raccoon-relative path`);
    }
    probe = {
      ...action.probe,
      path: probePath,
      method: String(action.probe.method || "POST").toUpperCase(),
    };
  }

  return {
    name,
    probe,
    claim: {
      ...claim,
      path: claimPath,
      method: String(claim.method || "POST").toUpperCase(),
    },
  };
}

function getPath(value, dottedPath) {
  if (!dottedPath) return value;
  return String(dottedPath)
    .split(".")
    .filter(Boolean)
    .reduce((current, key) => (current == null ? undefined : current[key]), value);
}

function matchesCondition(payload, condition) {
  if (!condition || typeof condition !== "object") return true;

  const value = getPath(payload, condition.path);

  if (Object.prototype.hasOwnProperty.call(condition, "equals")) {
    return value === condition.equals;
  }
  if (Object.prototype.hasOwnProperty.call(condition, "notEquals")) {
    return value !== condition.notEquals;
  }
  if (Array.isArray(condition.in)) {
    return condition.in.includes(value);
  }
  if (condition.truthy === true) return Boolean(value);
  if (condition.falsy === true) return !value;

  return Boolean(value);
}

function materializeBody(body, account) {
  const base = {
    ...DEFAULT_BASE_FIELDS,
    sn: account.sn,
    user_token: account.token,
  };

  const source = body && typeof body === "object" ? body : {};
  const replacements = {
    "$sn": account.sn,
    "$token": account.token,
  };

  const replace = (value) => {
    if (typeof value === "string" && replacements[value] !== undefined) {
      return replacements[value];
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, replace(item)]),
      );
    }
    return value;
  };

  return { ...base, ...replace(source) };
}

async function readPayload(response) {
  const raw = await response.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw: raw.slice(0, 1000) };
  }
}

async function performStep(raccoonFetch, account, step) {
  const headers = {
    accept: "*/*",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    cookie: `as_user_token=${account.token}`,
    origin: "https://www.raccoongame.com",
    referer: "https://www.raccoongame.com/",
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36",
    "x-requested-with": "XMLHttpRequest",
    ...(step.headers && typeof step.headers === "object" ? step.headers : {}),
  };

  const method = String(step.method || "POST").toUpperCase();
  const opts = { method, headers };

  if (!["GET", "HEAD"].includes(method)) {
    opts.body = new URLSearchParams(
      Object.entries(materializeBody(step.body, account)).reduce(
        (out, [key, value]) => {
          if (value === undefined || value === null) return out;
          out[key] =
            typeof value === "object" ? JSON.stringify(value) : String(value);
          return out;
        },
        {},
      ),
    );
  }

  const response = await raccoonFetch(step.path, opts);
  const payload = await readPayload(response);

  return {
    ok: response.ok,
    statusCode: response.status,
    payload,
  };
}

async function claimEligibleRewards(account, { raccoonFetch, log } = {}) {
  if (!account?.sn || !account?.token) {
    throw new Error("reward collector requires account sn + token");
  }
  if (typeof raccoonFetch !== "function") {
    throw new Error("reward collector requires raccoonFetch");
  }

  const enabled = boolEnv("RACCOON_REWARDS_ENABLED", true);
  if (!enabled) {
    return { enabled: false, configured: 0, claimed: [], skipped: [], failed: [] };
  }

  const actions = loadActions().map(normalizeAction);
  const result = {
    enabled: true,
    configured: actions.length,
    claimed: [],
    skipped: [],
    failed: [],
  };

  for (const action of actions) {
    try {
      if (action.probe) {
        const probe = await performStep(raccoonFetch, account, action.probe);
        if (!probe.ok) {
          result.failed.push({
            name: action.name,
            stage: "probe",
            statusCode: probe.statusCode,
          });
          log?.(`rewards: ${action.name} probe HTTP ${probe.statusCode}`);
          continue;
        }

        const condition = action.probe.claimWhen || action.probe.when;
        if (!matchesCondition(probe.payload, condition)) {
          result.skipped.push({ name: action.name, reason: "not_eligible" });
          log?.(`rewards: ${action.name} not eligible`);
          continue;
        }
      }

      const claim = await performStep(raccoonFetch, account, action.claim);
      const successCondition = action.claim.successWhen || action.claim.when;
      const success =
        claim.ok &&
        (!successCondition || matchesCondition(claim.payload, successCondition));

      if (success) {
        result.claimed.push({
          name: action.name,
          statusCode: claim.statusCode,
        });
        log?.(`rewards: ${action.name} claimed`);
      } else {
        result.skipped.push({
          name: action.name,
          reason: claim.ok ? "provider_rejected_or_already_claimed" : "http_error",
          statusCode: claim.statusCode,
        });
        log?.(`rewards: ${action.name} skipped (HTTP ${claim.statusCode})`);
      }
    } catch (error) {
      result.failed.push({
        name: action.name,
        stage: "claim",
        error: error instanceof Error ? error.message : String(error),
      });
      log?.(`rewards: ${action.name} failed — ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
  }

  return result;
}

module.exports = {
  claimEligibleRewards,
  loadActions,
};
