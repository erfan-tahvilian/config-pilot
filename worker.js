const USERS_KEY = "users_v2";
const ADMIN_PASSWORD_HASH_KEY = "admin_password_hash_v1";
const ADMIN_PASSWORD_META_KEY = "admin_password_meta_v1";
const TELEGRAM_SETTINGS_KEY = "telegram_settings_v1";
const TELEGRAM_STATE_PREFIX = "telegram_state:";
const TELEGRAM_CONTROL_MESSAGE_PREFIX = "telegram_control_message:";
const MAX_CONFIG_BYTES = 5 * 1024 * 1024;
const DEFAULT_ADMIN_PASSWORD = "admin";

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: securityHeaders() });
      }

      if (url.pathname === "/" && request.method === "GET") {
        return Response.redirect(url.origin + "/admin", 302);
      }

      if ((url.pathname === "/admin" || url.pathname === "/admin/") && request.method === "GET") {
        return htmlResponse(ADMIN_HTML);
      }

      if ((url.pathname === "/tg-app" || url.pathname === "/tg-app/") && request.method === "GET") {
        return htmlResponse(ADMIN_HTML);
      }

      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        if (!(await isAdminAuthorized(request, env))) {
          return jsonResponse({ ok: false, error: "رمز عبور نادرست است." }, 401);
        }
        return jsonResponse({ ok: true });
      }

      if (url.pathname === "/api/admin/state" && request.method === "GET") {
        await requireAdmin(request, env);
        const users = await getUsers(env);
        const telegramSettings = await getTelegramSettings(env);
        const adminPasswordHash = await env.CONFIGS_KV.get(ADMIN_PASSWORD_HASH_KEY);
        return jsonResponse({
          ok: true,
          users: users.map(user => publicUser(user, url, env)),
          adminPasswordChanged: Boolean(adminPasswordHash),
          telegram: publicTelegramSettings(telegramSettings, url, env)
        });
      }

      if (url.pathname === "/api/telegram-miniapp/auth-status" && request.method === "GET") {
        assertKvBinding(env);

        const initData = request.headers.get("x-telegram-init-data") || "";
        const settings = await getTelegramSettings(env);

        if (!initData) {
          return jsonResponse({ ok: false, error: "Telegram initData was not received. Set BotFather Mini App URL to /tg-app and open it from Telegram." }, 401);
        }

        if (!settings || !settings.botToken) {
          return jsonResponse({ ok: false, error: "Bot token is not saved in the Telegram settings panel." }, 401);
        }

        if (!settings.adminChatId) {
          return jsonResponse({ ok: false, error: "Admin Chat ID is not saved in the Telegram settings panel." }, 401);
        }

        const verified = await verifyTelegramWebAppInitData(initData, settings.botToken);

        if (!verified.ok || !verified.user) {
          return jsonResponse({ ok: false, error: "Telegram initData verification failed. Re-save the correct bot token and open the Mini App again from Telegram." }, 401);
        }

        const telegramUserId = String(verified.user.id || "");

        if (!constantTimeEqual(telegramUserId, String(settings.adminChatId || ""))) {
          return jsonResponse({
            ok: false,
            error: "Telegram user ID does not match the saved Admin Chat ID.",
            telegramUserId,
            savedAdminChatId: settings.adminChatId
          }, 401);
        }

        return jsonResponse({ ok: true, telegramUserId });
      }

      if (url.pathname === "/api/admin/password/change" && request.method === "POST") {
        await requireAdmin(request, env);
        const payload = await readJson(request);
        const currentPassword = String(payload.currentPassword || "");
        const newPassword = String(payload.newPassword || "");

        if (!(await passwordMatches(currentPassword, env))) {
          return jsonResponse({ ok: false, error: "رمز عبور فعلی نادرست است." }, 401);
        }

        if (newPassword.length < 8) {
          return jsonResponse({ ok: false, error: "رمز عبور جدید باید حداقل ۸ کاراکتر باشد." }, 400);
        }

        const hash = await sha256Hex(newPassword);
        const meta = { updatedAt: new Date().toISOString() };
        await env.CONFIGS_KV.put(ADMIN_PASSWORD_HASH_KEY, hash);
        await env.CONFIGS_KV.put(ADMIN_PASSWORD_META_KEY, JSON.stringify(meta));

        return jsonResponse({ ok: true, message: "رمز عبور با موفقیت تغییر کرد." });
      }

      if (url.pathname === "/api/admin/users/create" && request.method === "POST") {
        await requireAdmin(request, env);
        const payload = await readJson(request);
        const name = cleanName(payload.name || "");
        if (!name) return jsonResponse({ ok: false, error: "نام کاربر را وارد کنید." }, 400);

        const users = await getUsers(env);
        const user = {
          id: generateId(),
          name,
          token: generateToken(),
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastConfigUpdate: null
        };

        users.push(user);
        await saveUsers(env, users);
        await env.CONFIGS_KV.put(tokenKey(user.token), user.id);
        await env.CONFIGS_KV.put(configKey(user.id), "");

        return jsonResponse({ ok: true, message: "کاربر ایجاد شد.", user: publicUser(user, url, env) });
      }

      if (url.pathname === "/api/admin/users/update" && request.method === "POST") {
        await requireAdmin(request, env);
        const payload = await readJson(request);
        const users = await getUsers(env);
        const user = users.find(item => item.id === payload.id);
        if (!user) return jsonResponse({ ok: false, error: "کاربر پیدا نشد." }, 404);

        if (typeof payload.name === "string") {
          const name = cleanName(payload.name);
          if (!name) return jsonResponse({ ok: false, error: "نام کاربر نمی‌تواند خالی باشد." }, 400);
          user.name = name;
        }

        if (typeof payload.enabled === "boolean") {
          user.enabled = payload.enabled;
        }

        if (payload.regenerateToken === true) {
          await env.CONFIGS_KV.delete(tokenKey(user.token));
          user.token = generateToken();
          await env.CONFIGS_KV.put(tokenKey(user.token), user.id);
        }

        user.updatedAt = new Date().toISOString();
        await saveUsers(env, users);
        return jsonResponse({ ok: true, message: "اطلاعات کاربر ذخیره شد.", user: publicUser(user, url, env) });
      }

      if (url.pathname === "/api/admin/users/delete" && request.method === "POST") {
        await requireAdmin(request, env);
        const payload = await readJson(request);
        const users = await getUsers(env);
        const index = users.findIndex(item => item.id === payload.id);
        if (index === -1) return jsonResponse({ ok: false, error: "کاربر پیدا نشد." }, 404);

        const [removed] = users.splice(index, 1);
        await saveUsers(env, users);
        await env.CONFIGS_KV.delete(tokenKey(removed.token));
        await env.CONFIGS_KV.delete(configKey(removed.id));
        await env.CONFIGS_KV.delete(backupConfigKey(removed.id));
        await env.CONFIGS_KV.delete(metaKey(removed.id));
        await env.CONFIGS_KV.delete(backupMetaKey(removed.id));

        return jsonResponse({ ok: true, message: "کاربر حذف شد." });
      }

      if (url.pathname === "/api/admin/users/configs" && request.method === "GET") {
        await requireAdmin(request, env);
        const userId = url.searchParams.get("id") || "";
        const user = await getUserById(env, userId);
        if (!user) return jsonResponse({ ok: false, error: "کاربر پیدا نشد." }, 404);

        const configs = await env.CONFIGS_KV.get(configKey(user.id)) || "";
        const meta = await getJson(env, metaKey(user.id), {});
        const backupMeta = await getJson(env, backupMetaKey(user.id), {});
        const backupExists = Boolean(await env.CONFIGS_KV.get(backupConfigKey(user.id)));

        return jsonResponse({
          ok: true,
          user: publicUser(user, url, env),
          configs,
          meta,
          backupMeta,
          backupExists,
          stats: analyzeConfigs(configs)
        });
      }

      if (url.pathname === "/api/admin/users/configs/save" && request.method === "POST") {
        await requireAdmin(request, env);
        const payload = await readJson(request);
        const users = await getUsers(env);
        const user = users.find(item => item.id === payload.id);
        if (!user) return jsonResponse({ ok: false, error: "کاربر پیدا نشد." }, 404);

        const result = await saveConfigsForUser(env, user, String(payload.configs || ""), {
          normalize: payload.normalize !== false,
          dedupe: payload.dedupe !== false
        });

        user.lastConfigUpdate = result.meta.updatedAt;
        user.updatedAt = result.meta.updatedAt;
        await saveUsers(env, users);

        return jsonResponse({
          ok: true,
          message: "کانفیگ‌های کاربر ذخیره شد.",
          user: publicUser(user, url, env),
          configs: result.configs,
          meta: result.meta,
          stats: result.stats
        });
      }

      if (url.pathname === "/api/admin/users/configs/restore" && request.method === "POST") {
        await requireAdmin(request, env);
        const payload = await readJson(request);
        const users = await getUsers(env);
        const user = users.find(item => item.id === payload.id);
        if (!user) return jsonResponse({ ok: false, error: "کاربر پیدا نشد." }, 404);

        const backup = await env.CONFIGS_KV.get(backupConfigKey(user.id));
        if (!backup || !backup.trim()) {
          return jsonResponse({ ok: false, error: "برای این کاربر بکاپی وجود ندارد." }, 404);
        }

        const result = await saveConfigsForUser(env, user, backup, { normalize: true, dedupe: true });
        user.lastConfigUpdate = result.meta.updatedAt;
        user.updatedAt = result.meta.updatedAt;
        await saveUsers(env, users);

        return jsonResponse({
          ok: true,
          message: "آخرین بکاپ این کاربر بازیابی شد.",
          user: publicUser(user, url, env),
          configs: result.configs,
          meta: result.meta,
          stats: result.stats
        });
      }

      if (url.pathname === "/api/admin/bulk/apply" && request.method === "POST") {
        await requireAdmin(request, env);
        const payload = await readJson(request);
        const users = await getUsers(env);
        const mode = payload.mode === "append" ? "append" : "replace";
        const targetIds = payload.target === "all" ? users.map(user => user.id) : arrayOfStrings(payload.userIds);
        const selectedUsers = users.filter(user => targetIds.includes(user.id));

        if (!selectedUsers.length) {
          return jsonResponse({ ok: false, error: "حداقل یک کاربر را انتخاب کنید." }, 400);
        }

        let inputConfigs = String(payload.configs || "");
        inputConfigs = normalizeAndDedupeConfigs(inputConfigs).text;
        if (!inputConfigs.trim()) {
          return jsonResponse({ ok: false, error: "کانفیگ قابل اعمال وارد نشده است." }, 400);
        }

        const updatedAt = new Date().toISOString();
        const results = [];

        for (const user of selectedUsers) {
          const current = await env.CONFIGS_KV.get(configKey(user.id)) || "";
          const nextText = mode === "append" ? current + "\n" + inputConfigs : inputConfigs;
          const saved = await saveConfigsForUser(env, user, nextText, { normalize: true, dedupe: true });
          user.lastConfigUpdate = saved.meta.updatedAt;
          user.updatedAt = saved.meta.updatedAt;
          results.push({ id: user.id, name: user.name, stats: saved.stats });
        }

        await saveUsers(env, users);

        return jsonResponse({
          ok: true,
          message: "کانفیگ‌ها برای کاربران انتخاب‌شده اعمال شد.",
          updatedAt,
          users: users.map(user => publicUser(user, url, env)),
          results
        });
      }

      if (url.pathname === "/api/admin/download" && request.method === "GET") {
        await requireAdmin(request, env);
        const userId = url.searchParams.get("id") || "";
        const user = await getUserById(env, userId);
        if (!user) return new Response("User not found", { status: 404, headers: securityHeaders() });
        const configs = await env.CONFIGS_KV.get(configKey(user.id)) || "";
        return new Response(configs, {
          status: 200,
          headers: {
            ...securityHeaders(),
            "content-type": "text/plain; charset=utf-8",
            "content-disposition": "attachment; filename=\"configs-" + safeFilename(user.name) + "-" + dateStamp() + ".txt\""
          }
        });
      }

      if (url.pathname === "/api/admin/telegram/save" && request.method === "POST") {
        await requireAdmin(request, env);
        const payload = await readJson(request);
        const settings = await getTelegramSettings(env);

        if (typeof payload.botToken === "string" && payload.botToken.trim()) {
          settings.botToken = payload.botToken.trim();
        }
        if (typeof payload.adminChatId === "string") {
          settings.adminChatId = payload.adminChatId.trim();
        }
        settings.enabled = payload.enabled === true;
        settings.webhookSecret = settings.webhookSecret || generateToken(40);
        settings.updatedAt = new Date().toISOString();

        if (settings.enabled && (!settings.botToken || !settings.adminChatId)) {
          return jsonResponse({ ok: false, error: "توکن بات و شناسه عددی ادمین را وارد کنید." }, 400);
        }

        await env.CONFIGS_KV.put(TELEGRAM_SETTINGS_KEY, JSON.stringify(settings));

        let webhookResult = null;
        if (settings.enabled) {
          webhookResult = await configureTelegramEntryPoints(settings, url.origin);
        }

        return jsonResponse({
          ok: true,
          message: settings.enabled ? "تنظیمات تلگرام ذخیره و وبهوک فعال شد." : "تنظیمات تلگرام ذخیره شد.",
          telegram: publicTelegramSettings(settings, url, env),
          webhookResult
        });
      }

      if (url.pathname === "/api/admin/telegram/test" && request.method === "POST") {
        await requireAdmin(request, env);
        const settings = await getTelegramSettings(env);
        if (!settings.enabled || !settings.botToken || !settings.adminChatId) {
          return jsonResponse({ ok: false, error: "تنظیمات تلگرام کامل یا فعال نیست." }, 400);
        }
        const sent = await telegramSend(settings.botToken, settings.adminChatId, "اتصال ربات تلگرام با موفقیت برقرار شد. از دکمه‌های زیر می‌توانید استفاده کنید.", telegramReplyKeyboard(url.origin));
        return jsonResponse({ ok: true, message: "پیام تست ارسال شد.", telegramResult: sent });
      }

      if (url.pathname.startsWith("/telegram/webhook/") && request.method === "POST") {
        const secret = decodeURIComponent(url.pathname.slice("/telegram/webhook/".length));
        const settings = await getTelegramSettings(env);
        if (!settings.enabled || !settings.webhookSecret || !constantTimeEqual(secret, settings.webhookSecret)) {
          return new Response("Not found", { status: 404, headers: securityHeaders() });
        }
        const update = await readJson(request);
        await handleTelegramUpdate(update, env, settings, url.origin);
        return jsonResponse({ ok: true });
      }

      if (url.pathname.startsWith("/sub/") && request.method === "GET") {
        const token = decodeURIComponent(url.pathname.slice("/sub/".length).split("/")[0] || "");
        const userId = await env.CONFIGS_KV.get(tokenKey(token));
        if (!userId) return new Response("Not found", { status: 404, headers: securityHeaders() });

        const user = await getUserById(env, userId);
        if (!user || !user.enabled || !constantTimeEqual(token, user.token)) {
          return new Response("Not found", { status: 404, headers: securityHeaders() });
        }

        const configs = await env.CONFIGS_KV.get(configKey(user.id)) || "";
        const clean = normalizeAndDedupeConfigs(configs).text;
        if (!clean.trim()) {
          return new Response("No configs found", {
            status: 404,
            headers: {
              ...securityHeaders(),
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "no-store"
            }
          });
        }

        const format = (url.searchParams.get("format") || "raw").toLowerCase();
        const body = format === "base64" ? utf8ToBase64(clean) : clean;

        return new Response(body, {
          status: 200,
          headers: {
            ...securityHeaders(),
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store, no-cache, must-revalidate",
            "subscription-userinfo": "upload=0; download=0; total=107374182400; expire=4102444800"
          }
        });
      }

      return new Response("Not found", { status: 404, headers: securityHeaders() });
    } catch (error) {
      const status = Number(error && error.status) || 500;

      if (status === 401) {
        return jsonResponse({ ok: false, error: "دسترسی غیرمجاز است." }, 401);
      }

      if (error && error.expose === true) {
        return jsonResponse({ ok: false, error: String(error.message || error) }, status);
      }

      return jsonResponse({
        ok: false,
        error: "خطای داخلی Worker",
        details: String(error && error.message ? error.message : error)
      }, 500);
    }
  }
};

async function requireAdmin(request, env) {
  if (!(await isAdminAuthorized(request, env))) {
    const error = new Error("Unauthorized");
    error.status = 401;
    throw error;
  }
}

async function isAdminAuthorized(request, env) {
  assertKvBinding(env);

  if (await telegramMiniAppMatches(request, env)) {
    return true;
  }

  const auth = request.headers.get("authorization") || "";
  const password = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  return passwordMatches(password, env);
}

async function telegramMiniAppMatches(request, env) {
  const initData = request.headers.get("x-telegram-init-data") || "";
  if (!initData) return false;

  const settings = await getTelegramSettings(env);
  if (!settings || !settings.botToken || !settings.adminChatId) return false;

  const verified = await verifyTelegramWebAppInitData(initData, settings.botToken);
  if (!verified.ok || !verified.user) return false;

  const telegramUserId = String(verified.user.id || "");
  return constantTimeEqual(telegramUserId, String(settings.adminChatId || ""));
}

async function verifyTelegramWebAppInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash") || "";
    if (!receivedHash) return { ok: false };

    params.delete("hash");

    const authDate = Number(params.get("auth_date") || "0");
    if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) {
      return { ok: false };
    }

    const pairs = [];
    for (const [key, value] of params.entries()) {
      pairs.push(key + "=" + value);
    }
    pairs.sort();

    const dataCheckString = pairs.join("\n");
    const secretKey = await hmacSHA256Raw("WebAppData", botToken);
    const calculatedHash = await hmacSHA256Hex(secretKey, dataCheckString);

    if (!constantTimeEqual(calculatedHash, receivedHash)) {
      return { ok: false };
    }

    let user = null;
    const rawUser = params.get("user");
    if (rawUser) {
      user = JSON.parse(rawUser);
    }

    return { ok: true, user };
  } catch {
    return { ok: false };
  }
}

async function hmacSHA256Raw(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(String(message))
  );

  return new Uint8Array(signature);
}

async function hmacSHA256Hex(key, message) {
  const raw = await hmacSHA256Raw(key, message);
  return Array.from(raw).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function passwordMatches(password, env) {
  assertKvBinding(env);

  password = normalizePassword(password);

  const storedHash = await env.CONFIGS_KV.get(ADMIN_PASSWORD_HASH_KEY);

  if (storedHash) {
    return constantTimeEqual(await sha256Hex(password), storedHash);
  }

  if (constantTimeEqual(password, DEFAULT_ADMIN_PASSWORD)) {
    await env.CONFIGS_KV.put(ADMIN_PASSWORD_HASH_KEY, await sha256Hex(DEFAULT_ADMIN_PASSWORD));
    await env.CONFIGS_KV.put(ADMIN_PASSWORD_META_KEY, JSON.stringify({
      updatedAt: new Date().toISOString(),
      source: "auto-init"
    }));

    return true;
  }

  return false;
}

function normalizePassword(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/[\u200B-\u200D\u2060]/g, "")
    .trim();
}

function assertKvBinding(env) {
  if (!env || !env.CONFIGS_KV) {
    const error = new Error("KV Binding named CONFIGS_KV is not connected to this Worker.");
    error.status = 500;
    error.expose = true;
    throw error;
  }
}

async function readJson(request) {
  return await request.json().catch(() => ({}));
}

async function getUsers(env) {
  const raw = await env.CONFIGS_KV.get(USERS_KEY);
  if (!raw) return [];
  try {
    const users = JSON.parse(raw);
    return Array.isArray(users) ? users : [];
  } catch {
    return [];
  }
}

async function saveUsers(env, users) {
  await env.CONFIGS_KV.put(USERS_KEY, JSON.stringify(users));
}

async function getUserById(env, id) {
  const users = await getUsers(env);
  return users.find(user => user.id === id) || null;
}

function publicUser(user, url, env) {
  const base = (env.PUBLIC_BASE_URL || url.origin).replace(/\/$/, "");
  const token = encodeURIComponent(user.token);
  return {
    id: user.id,
    name: user.name,
    enabled: user.enabled !== false,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastConfigUpdate: user.lastConfigUpdate || null,
    token: user.token,
    links: {
      raw: base + "/sub/" + token,
      base64: base + "/sub/" + token + "?format=base64"
    }
  };
}

async function saveConfigsForUser(env, user, inputText, options = {}) {
  const normalize = options.normalize !== false;
  const dedupe = options.dedupe !== false;
  let configs = String(inputText || "");

  if (normalize || dedupe) {
    configs = normalizeAndDedupeConfigs(configs, { dedupe }).text;
  }

  const byteSize = new TextEncoder().encode(configs).length;
  if (byteSize > MAX_CONFIG_BYTES) {
    const error = new Error("حجم کانفیگ‌ها برای این پنل بیش از ۵ مگابایت است.");
    error.status = 413;
    throw error;
  }

  if (!configs.trim()) {
    const error = new Error("لیست کانفیگ خالی است.");
    error.status = 400;
    throw error;
  }

  const oldConfigs = await env.CONFIGS_KV.get(configKey(user.id));
  const oldMeta = await getJson(env, metaKey(user.id), null);

  if (oldConfigs && oldConfigs.trim()) {
    await env.CONFIGS_KV.put(backupConfigKey(user.id), oldConfigs);
    if (oldMeta) await env.CONFIGS_KV.put(backupMetaKey(user.id), JSON.stringify(oldMeta));
  }

  const stats = analyzeConfigs(configs);
  const meta = {
    updatedAt: new Date().toISOString(),
    byteSize,
    sha256: await sha256Hex(configs),
    count: stats.total,
    validCount: stats.valid,
    unknownCount: stats.unknown,
    duplicatesRemovedByContent: stats.duplicatesByContent
  };

  await env.CONFIGS_KV.put(configKey(user.id), configs);
  await env.CONFIGS_KV.put(metaKey(user.id), JSON.stringify(meta));

  return { configs, stats, meta };
}

function normalizeAndDedupeConfigs(text, options = {}) {
  const dedupe = options.dedupe !== false;
  const seen = new Set();
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  const output = [];
  let duplicatesByContent = 0;

  for (const line of lines) {
    const key = canonicalConfigKey(line);
    if (dedupe && seen.has(key)) {
      duplicatesByContent++;
      continue;
    }
    seen.add(key);
    output.push(line);
  }

  return { text: output.join("\n"), duplicatesByContent };
}

function canonicalConfigKey(line) {
  let value = String(line || "").trim();
  const lower = value.toLowerCase();

  if (lower.startsWith("vmess://")) {
    const raw = value.slice("vmess://".length).trim();
    const decoded = safeBase64Decode(raw);
    if (decoded) {
      try {
        const obj = JSON.parse(decoded);
        delete obj.ps;
        delete obj.remark;
        delete obj.remarks;
        return "vmess://" + stableJson(obj);
      } catch {
        return "vmess://" + raw.replace(/=+$/, "");
      }
    }
  }

  const hashIndex = value.indexOf("#");
  if (hashIndex !== -1) value = value.slice(0, hashIndex);

  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.searchParams.delete("remarks");
    parsed.searchParams.delete("remark");
    parsed.searchParams.delete("name");
    parsed.searchParams.sort();
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.replace(/#.*$/, "").trim().toLowerCase();
  }
}

function analyzeConfigs(text) {
  const schemes = ["vless://", "vmess://", "trojan://", "ss://", "ssr://", "hysteria://", "hysteria2://", "hy2://", "tuic://"];
  const lines = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const clean = lines.map(line => line.trim());
  const nonEmpty = clean.filter(Boolean);
  const seenExact = new Set();
  const seenContent = new Set();
  let duplicates = 0;
  let duplicatesByContent = 0;
  let valid = 0;
  let unknown = 0;
  const byType = {};

  for (const line of nonEmpty) {
    if (seenExact.has(line)) duplicates++;
    seenExact.add(line);

    const contentKey = canonicalConfigKey(line);
    if (seenContent.has(contentKey)) duplicatesByContent++;
    seenContent.add(contentKey);

    const scheme = schemes.find(item => line.toLowerCase().startsWith(item));
    if (scheme) {
      valid++;
      const key = scheme.replace("://", "");
      byType[key] = (byType[key] || 0) + 1;
    } else {
      unknown++;
    }
  }

  return {
    total: nonEmpty.length,
    valid,
    unknown,
    empty: clean.length - nonEmpty.length,
    duplicates,
    duplicatesByContent,
    unique: seenContent.size,
    byType
  };
}

async function getTelegramSettings(env) {
  return await getJson(env, TELEGRAM_SETTINGS_KEY, {
    enabled: false,
    botToken: "",
    adminChatId: "",
    webhookSecret: "",
    updatedAt: null
  });
}

function publicTelegramSettings(settings, url, env) {
  const base = (env && env.PUBLIC_BASE_URL ? env.PUBLIC_BASE_URL : url.origin).replace(/\/$/, "");
  const miniAppUrl = base + "/tg-app";

  return {
    enabled: settings.enabled === true,
    adminChatId: settings.adminChatId || "",
    botTokenSaved: Boolean(settings.botToken),
    botTokenPreview: settings.botToken ? maskToken(settings.botToken) : "",
    webhookUrl: settings.webhookSecret ? base + "/telegram/webhook/" + encodeURIComponent(settings.webhookSecret) : "",
    miniAppUrl,
    updatedAt: settings.updatedAt || null
  };
}

async function configureTelegramEntryPoints(settings, origin) {
  const webhook = await setTelegramWebhook(settings, origin);
  const commands = await setTelegramCommands(settings);

  if (settings.botToken && settings.adminChatId) {
    await telegramSend(
      settings.botToken,
      settings.adminChatId,
      telegramStartText(settings.adminChatId),
      telegramReplyKeyboard(origin)
    );
  }

  return { webhook, commands };
}

async function setTelegramWebhook(settings, origin) {
  const webhookUrl = origin.replace(/\/$/, "") + "/telegram/webhook/" + encodeURIComponent(settings.webhookSecret);
  const response = await fetch("https://api.telegram.org/bot" + settings.botToken + "/setWebhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: webhookUrl, drop_pending_updates: true })
  });
  return await response.json().catch(() => ({ ok: false, description: "پاسخ تلگرام نامعتبر بود." }));
}

async function setTelegramMenuButton(settings, origin) {
  const miniAppUrl = origin.replace(/\/$/, "") + "/tg-app";
  const response = await fetch("https://api.telegram.org/bot" + settings.botToken + "/setChatMenuButton", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: settings.adminChatId,
      menu_button: {
        type: "web_app",
        text: "پنل مدیریت",
        web_app: { url: miniAppUrl }
      }
    })
  });
  return await response.json().catch(() => ({ ok: false, description: "پاسخ تلگرام نامعتبر بود." }));
}

async function setTelegramCommands(settings) {
  const commands = [
    { command: "start", description: "شروع و نمایش منوی اصلی" },
    { command: "id", description: "نمایش شناسه عددی تلگرام ادمین" },
    { command: "users", description: "نمایش و مدیریت کاربران" },
    { command: "newuser", description: "ایجاد کاربر جدید" },
    { command: "bulk", description: "اعمال گروهی کانفیگ" },
    { command: "file", description: "راهنمای ارسال کانفیگ با فایل" },
    { command: "commands", description: "نمایش لیست کامل دستورها" },
    { command: "help", description: "راهنمای کامل ربات" },
    { command: "cancel", description: "لغو عملیات جاری" },
    { command: "setconfigs", description: "جایگزینی کانفیگ یک کاربر" },
    { command: "appendconfigs", description: "افزودن کانفیگ به یک کاربر" },
    { command: "apply_all", description: "جایگزینی کانفیگ همه کاربران" },
    { command: "append_all", description: "افزودن کانفیگ به همه کاربران" },
    { command: "apply_users", description: "جایگزینی کانفیگ چند کاربر" },
    { command: "append_users", description: "افزودن کانفیگ چند کاربر" },
    { command: "password", description: "تغییر رمز عبور پنل" },
    { command: "webhook", description: "تنظیم مجدد وبهوک و دستورها" }
  ];

  const scopes = [
    { type: "default" },
    { type: "all_private_chats" }
  ];

  if (settings.adminChatId) {
    scopes.push({ type: "chat", chat_id: Number(settings.adminChatId) || settings.adminChatId });
  }

  const results = [];
  for (const scope of scopes) {
    const response = await fetch("https://api.telegram.org/bot" + settings.botToken + "/setMyCommands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands, scope })
    });
    results.push(await response.json().catch(() => ({ ok: false, description: "پاسخ تلگرام نامعتبر بود." })));
  }

  return results;
}

async function telegramSend(botToken, chatId, text, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };

  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  const response = await fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return await response.json().catch(() => ({ ok: false }));
}

async function telegramEditMessage(botToken, chatId, messageId, text, replyMarkup = null) {
  if (!messageId) {
    return telegramSend(botToken, chatId, text, replyMarkup);
  }

  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };

  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  const response = await fetch("https://api.telegram.org/bot" + botToken + "/editMessageText", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  const result = await response.json().catch(() => ({ ok: false }));

  if (!result.ok && String(result.description || "").includes("message is not modified")) {
    return { ok: true, unchanged: true };
  }

  return result;
}

async function telegramEditCallbackMessage(callbackQuery, settings, chatId, text, replyMarkup = null) {
  const messageId = callbackQuery && callbackQuery.message ? callbackQuery.message.message_id : null;
  const result = await telegramEditMessage(settings.botToken, chatId, messageId, text, replyMarkup);

  if (!result || result.ok !== true) {
    return telegramSend(settings.botToken, chatId, text, replyMarkup);
  }

  return result;
}

async function telegramStateReply(botToken, chatId, state, text, replyMarkup = null) {
  if (state && state.messageId) {
    const result = await telegramEditMessage(botToken, chatId, state.messageId, text, replyMarkup);
    if (result && result.ok === true) return result;
  }
  return telegramSend(botToken, chatId, text, replyMarkup);
}

async function telegramAnswerCallback(botToken, callbackQueryId, text = "") {
  const response = await fetch("https://api.telegram.org/bot" + botToken + "/answerCallbackQuery", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text })
  });
  return await response.json().catch(() => ({ ok: false }));
}

function telegramReplyKeyboard(origin) {
  return {
    keyboard: [
      [{ text: "👥 کاربران" }, { text: "➕ افزودن کاربر" }],
      [{ text: "📦 اعمال گروهی" }, { text: "📄 ارسال فایل" }],
      [{ text: "🔐 تغییر رمز" }, { text: "📋 لیست دستورات" }],
      [{ text: "❓ راهنما" }, { text: "❌ لغو" }]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

function telegramInlineKeyboard(origin) {
  return {
    inline_keyboard: [
      [
        { text: "👥 مدیریت کاربران", callback_data: "tg:users" },
        { text: "➕ افزودن کاربر", callback_data: "tg:create_user" }
      ],
      [
        { text: "📦 اعمال گروهی", callback_data: "tg:bulk_menu" },
        { text: "🔐 تغییر رمز", callback_data: "tg:password" }
      ],
      [
        { text: "📄 ارسال فایل", callback_data: "tg:file_help" },
        { text: "📋 دستورات", callback_data: "tg:commands" }
      ],
      [{ text: "❓ راهنما", callback_data: "tg:help" }]
    ]
  };
}

function telegramUsersKeyboard(users) {
  const rows = users.slice(0, 30).map(user => ([{
    text: (user.enabled !== false ? "🟢 " : "🔴 ") + user.name,
    callback_data: "tg:user:" + user.id
  }]));
  rows.push([{ text: "➕ افزودن کاربر", callback_data: "tg:create_user" }]);
  rows.push([{ text: "بازگشت", callback_data: "tg:home" }]);
  return { inline_keyboard: rows };
}

function telegramUserActionsKeyboard(user, origin) {
  return {
    inline_keyboard: [
      [{ text: "🔗 لینک‌های کانفیگ", callback_data: "tg:user_links:" + user.id }],
      [
        { text: "📝 جایگزینی کانفیگ", callback_data: "tg:user_set:" + user.id },
        { text: "➕ افزودن کانفیگ", callback_data: "tg:user_append:" + user.id }
      ],
      [
        { text: "📊 خلاصه کانفیگ", callback_data: "tg:user_summary:" + user.id },
        { text: "✏️ تغییر نام", callback_data: "tg:user_rename:" + user.id }
      ],
      [
        { text: user.enabled !== false ? "🔴 غیرفعال‌سازی" : "🟢 فعال‌سازی", callback_data: "tg:user_toggle:" + user.id },
        { text: "♻️ توکن جدید", callback_data: "tg:user_regen_confirm:" + user.id }
      ],
      [
        { text: "🗑 حذف", callback_data: "tg:user_delete_confirm:" + user.id },
        { text: "👥 کاربران", callback_data: "tg:users" }
      ]
    ]
  };
}

function telegramConfirmKeyboard(action, id, backData = "tg:users") {
  return {
    inline_keyboard: [
      [
        { text: "✅ تأیید", callback_data: action + ":" + id },
        { text: "انصراف", callback_data: backData }
      ]
    ]
  };
}

function telegramBulkModeKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "جایگزینی برای همه", callback_data: "tg:bulk_all:replace" },
        { text: "افزودن برای همه", callback_data: "tg:bulk_all:append" }
      ],
      [
        { text: "انتخاب کاربران برای جایگزینی", callback_data: "tg:bulk_select:replace" },
        { text: "انتخاب کاربران برای افزودن", callback_data: "tg:bulk_select:append" }
      ],
      [{ text: "بازگشت", callback_data: "tg:home" }]
    ]
  };
}

function telegramBulkSelectKeyboard(users, selectedIds = []) {
  const selected = new Set(selectedIds);
  const rows = users.slice(0, 30).map(user => ([{
    text: (selected.has(user.id) ? "✅ " : "✖️ ") + user.name,
    callback_data: "tg:bulk_toggle:" + user.id
  }]));
  rows.push([{ text: "ادامه و ارسال کانفیگ", callback_data: "tg:bulk_selected_continue" }]);
  rows.push([{ text: "انصراف", callback_data: "tg:bulk_menu" }]);
  return { inline_keyboard: rows };
}
function telegramControlMessageKey(chatId) {
  return TELEGRAM_CONTROL_MESSAGE_PREFIX + chatId;
}

async function getTelegramControlMessageId(env, chatId) {
  return await env.CONFIGS_KV.get(telegramControlMessageKey(chatId));
}

async function setTelegramControlMessageId(env, chatId, messageId) {
  if (messageId) {
    await env.CONFIGS_KV.put(telegramControlMessageKey(chatId), String(messageId), { expirationTtl: 172800 });
  }
}

async function telegramControlMessage(botToken, chatId, text, replyMarkup, env) {
  const oldMessageId = env ? await getTelegramControlMessageId(env, chatId) : null;

  if (oldMessageId) {
    const edited = await telegramEditMessage(botToken, chatId, oldMessageId, text, replyMarkup);
    if (edited && edited.ok) {
      return edited;
    }
  }

  const sent = await telegramSend(botToken, chatId, text, replyMarkup);
  if (env && sent && sent.ok && sent.result && sent.result.message_id) {
    await setTelegramControlMessageId(env, chatId, sent.result.message_id);
  }
  return sent;
}


async function handleTelegramUpdate(update, env, settings, origin) {
  if (update.callback_query) {
    await handleTelegramCallback(update.callback_query, env, settings, origin);
    return;
  }

  const message = update.message || update.edited_message || null;
  if (!message || !message.chat) return;

  const chatId = String(message.chat.id);
  if (!constantTimeEqual(chatId, String(settings.adminChatId || ""))) {
    if (settings.botToken) {
      await telegramSend(settings.botToken, chatId, "دسترسی شما مجاز نیست.");
    }
    return;
  }

  const state = await getTelegramState(env, chatId);

  if (message.document) {
    const caption = normalizeTelegramText(String(message.caption || "").trim());
    const reply = await handleTelegramConfigDocument(message.document, caption, state, chatId, env, settings, origin);
    await telegramStateReply(settings.botToken, chatId, state, reply, telegramInlineKeyboard(origin));
    return;
  }

  if (typeof message.text !== "string") {
    await telegramSend(settings.botToken, chatId, "این پیام قابل پردازش نیست. برای ارسال کانفیگ با فایل، دکمه «📄 ارسال فایل» را بزنید.", telegramReplyKeyboard(origin));
    return;
  }

  const text = normalizeTelegramText(message.text.trim());

  if (text === "/cancel") {
    const activeState = await getTelegramState(env, chatId);
    await clearTelegramState(env, chatId);
    await telegramStateReply(settings.botToken, chatId, activeState, "عملیات جاری لغو شد.", telegramInlineKeyboard(origin));
    return;
  }

  if (state && !text.startsWith("/")) {
    const reply = await handleTelegramStateInput(text, state, chatId, env, settings, origin);
    await telegramStateReply(settings.botToken, chatId, state, reply, telegramInlineKeyboard(origin));
    return;
  }

  if (text === "/users") {
    const users = await getUsers(env);
    await telegramControlMessage(settings.botToken, chatId, users.length ? "کاربر مورد نظر را انتخاب کنید:" : "هنوز کاربری ایجاد نشده است.", users.length ? telegramUsersKeyboard(users) : telegramInlineKeyboard(origin), env);
    return;
  }

  if (text === "/bulk") {
    await telegramControlMessage(settings.botToken, chatId, "نوع اعمال گروهی را انتخاب کنید:", telegramBulkModeKeyboard(), env);
    return;
  }

  if (text === "/newuser") {
    await setTelegramState(env, chatId, { action: "create_user" });
    const sentNewUser = await telegramControlMessage(settings.botToken, chatId, "نام کاربر جدید را ارسال کنید.\nبرای لغو، /cancel را بزنید.", telegramInlineKeyboard(origin), env);
    if (sentNewUser && sentNewUser.result && sentNewUser.result.message_id) await setTelegramState(env, chatId, { action: "create_user", messageId: sentNewUser.result.message_id });
    return;
  }

  if (text === "/password_change") {
    await setTelegramState(env, chatId, { action: "change_password" });
    const sentPass = await telegramControlMessage(settings.botToken, chatId, "رمز عبور جدید پنل را ارسال کنید. حداقل ۸ کاراکتر.\nبرای لغو، /cancel را بزنید.", telegramInlineKeyboard(origin), env);
    if (sentPass && sentPass.result && sentPass.result.message_id) await setTelegramState(env, chatId, { action: "change_password", messageId: sentPass.result.message_id });
    return;
  }

  const reply = await runTelegramCommand(text, env, origin, settings);
  const markup = shouldShowTelegramInlineKeyboard(text) ? telegramInlineKeyboard(origin) : telegramReplyKeyboard(origin);

  if (text === "/start") {
    const sentStart = await telegramSend(settings.botToken, chatId, reply, telegramInlineKeyboard(origin));
    if (sentStart && sentStart.ok && sentStart.result && sentStart.result.message_id) {
      await setTelegramControlMessageId(env, chatId, sentStart.result.message_id);
    }
    return;
  }

  await telegramControlMessage(settings.botToken, chatId, reply, markup.inline_keyboard ? markup : telegramInlineKeyboard(origin), env);
}

async function handleTelegramConfigDocument(document, caption, state, chatId, env, settings, origin) {
  const fileText = await telegramDownloadDocumentText(settings.botToken, document);
  if (!fileText.trim()) {
    return "فایل ارسال‌شده خالی است یا متن قابل خواندن ندارد.";
  }

  if (state && ["set_configs", "append_configs", "bulk_configs"].includes(state.action)) {
    return await handleTelegramStateInput(fileText, state, chatId, env, settings, origin, true);
  }

  const commandLine = String(caption || "").split("\n")[0].trim();
  const command = (commandLine.split(/\s+/)[0] || "").toLowerCase();
  const allowed = new Set(["/setconfigs", "/appendconfigs", "/apply_all", "/append_all", "/apply_users", "/append_users"]);

  if (!allowed.has(command)) {
    return telegramFileHelpText();
  }

  return await runTelegramCommand(commandLine + "\n" + fileText, env, origin, settings);
}

async function telegramDownloadDocumentText(botToken, document) {
  if (!document || !document.file_id) {
    const error = new Error("فایل معتبر نیست.");
    error.status = 400;
    throw error;
  }

  if (document.file_size && document.file_size > MAX_CONFIG_BYTES) {
    const error = new Error("حجم فایل بیشتر از ۵ مگابایت است.");
    error.status = 413;
    throw error;
  }

  const metaResponse = await fetch("https://api.telegram.org/bot" + botToken + "/getFile?file_id=" + encodeURIComponent(document.file_id));
  const meta = await metaResponse.json().catch(() => null);

  if (!meta || !meta.ok || !meta.result || !meta.result.file_path) {
    const error = new Error("دریافت فایل از تلگرام ناموفق بود.");
    error.status = 502;
    throw error;
  }

  const fileResponse = await fetch("https://api.telegram.org/file/bot" + botToken + "/" + meta.result.file_path);
  if (!fileResponse.ok) {
    const error = new Error("دانلود فایل از تلگرام ناموفق بود.");
    error.status = 502;
    throw error;
  }

  const buffer = await fileResponse.arrayBuffer();
  if (buffer.byteLength > MAX_CONFIG_BYTES) {
    const error = new Error("حجم فایل بیشتر از ۵ مگابایت است.");
    error.status = 413;
    throw error;
  }

  return new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, "");
}

async function handleTelegramCallback(callbackQuery, env, settings, origin) {
  const fromId = String(callbackQuery.from && callbackQuery.from.id ? callbackQuery.from.id : "");

  if (!constantTimeEqual(fromId, String(settings.adminChatId || ""))) {
    await telegramAnswerCallback(settings.botToken, callbackQuery.id, "دسترسی مجاز نیست.");
    return;
  }

  const chatId = callbackQuery.message && callbackQuery.message.chat ? String(callbackQuery.message.chat.id) : fromId;
  const messageId = callbackQuery.message ? callbackQuery.message.message_id : null;
  const data = callbackQuery.data || "";
  const users = await getUsers(env);

  const edit = async function(text, markup) {
    return telegramEditCallbackMessage(callbackQuery, settings, chatId, text, markup);
  };

  await telegramAnswerCallback(settings.botToken, callbackQuery.id, "");

  if (data === "tg:home") {
    await clearTelegramState(env, chatId);
    await edit(telegramStartText(), telegramInlineKeyboard(origin));
    return;
  }

  if (data === "tg:users") {
    await edit(users.length ? "کاربر مورد نظر را انتخاب کنید:" : "هنوز کاربری ایجاد نشده است.", users.length ? telegramUsersKeyboard(users) : telegramInlineKeyboard(origin));
    return;
  }

  if (data.startsWith("tg:user:")) {
    const id = data.slice("tg:user:".length);
    const user = users.find(item => item.id === id);
    if (!user) return edit("کاربر پیدا نشد.", telegramUsersKeyboard(users));
    await edit(telegramUserSummaryText(user), telegramUserActionsKeyboard(user, origin));
    return;
  }

  if (data.startsWith("tg:user_links:")) {
    const id = data.slice("tg:user_links:".length);
    const user = users.find(item => item.id === id);
    if (!user) return edit("کاربر پیدا نشد.", telegramUsersKeyboard(users));
    const p = publicUser(user, new URL(origin), env);
    await edit("لینک‌های کانفیگ " + escapeHtml(user.name) + "\n\nRaw:\n" + p.links.raw + "\n\nBase64:\n" + p.links.base64, telegramUserActionsKeyboard(user, origin));
    return;
  }

  if (data.startsWith("tg:user_summary:")) {
    const id = data.slice("tg:user_summary:".length);
    const user = users.find(item => item.id === id);
    if (!user) return edit("کاربر پیدا نشد.", telegramUsersKeyboard(users));
    const configs = await env.CONFIGS_KV.get(configKey(user.id)) || "";
    const stats = analyzeConfigs(configs);
    await edit("خلاصه کانفیگ " + escapeHtml(user.name) + "\nتعداد: " + stats.total + "\nشناخته‌شده: " + stats.valid + "\nنامشخص: " + stats.unknown + "\nتکراری محتوایی: " + stats.duplicatesByContent, telegramUserActionsKeyboard(user, origin));
    return;
  }

  if (data.startsWith("tg:user_set:") || data.startsWith("tg:user_append:")) {
    const isAppend = data.startsWith("tg:user_append:");
    const id = data.slice(isAppend ? "tg:user_append:".length : "tg:user_set:".length);
    const user = users.find(item => item.id === id);
    if (!user) return edit("کاربر پیدا نشد.", telegramUsersKeyboard(users));
    await setTelegramState(env, chatId, { action: isAppend ? "append_configs" : "set_configs", userId: user.id, messageId });
    await edit((isAppend ? "کانفیگ‌هایی که باید اضافه شوند" : "کانفیگ‌های جایگزین") + " را برای " + escapeHtml(user.name) + " به صورت متن یا فایل ارسال کنید.\nبرای لغو، /cancel را بزنید.", telegramUserActionsKeyboard(user, origin));
    return;
  }

  if (data.startsWith("tg:user_rename:")) {
    const id = data.slice("tg:user_rename:".length);
    const user = users.find(item => item.id === id);
    if (!user) return edit("کاربر پیدا نشد.", telegramUsersKeyboard(users));
    await setTelegramState(env, chatId, { action: "rename_user", userId: user.id, messageId });
    await edit("نام جدید کاربر را ارسال کنید.\nبرای لغو، /cancel را بزنید.", telegramUserActionsKeyboard(user, origin));
    return;
  }

  if (data.startsWith("tg:user_toggle:")) {
    const id = data.slice("tg:user_toggle:".length);
    const user = users.find(item => item.id === id);
    if (!user) return edit("کاربر پیدا نشد.", telegramUsersKeyboard(users));
    user.enabled = user.enabled === false;
    user.updatedAt = new Date().toISOString();
    await saveUsers(env, users);
    await edit("وضعیت کاربر تغییر کرد: " + escapeHtml(user.name) + " - " + (user.enabled ? "فعال" : "غیرفعال"), telegramUserActionsKeyboard(user, origin));
    return;
  }

  if (data.startsWith("tg:user_regen_confirm:")) {
    const id = data.slice("tg:user_regen_confirm:".length);
    await edit("توکن قبلی این کاربر از کار می‌افتد. تأیید می‌کنید؟", telegramConfirmKeyboard("tg:user_regen", id, "tg:user:" + id));
    return;
  }

  if (data.startsWith("tg:user_regen:")) {
    const id = data.slice("tg:user_regen:".length);
    const user = users.find(item => item.id === id);
    if (!user) return edit("کاربر پیدا نشد.", telegramUsersKeyboard(users));
    await env.CONFIGS_KV.delete(tokenKey(user.token));
    user.token = generateToken();
    user.updatedAt = new Date().toISOString();
    await env.CONFIGS_KV.put(tokenKey(user.token), user.id);
    await saveUsers(env, users);
    await edit("توکن جدید ساخته شد.", telegramUserActionsKeyboard(user, origin));
    return;
  }

  if (data.startsWith("tg:user_delete_confirm:")) {
    const id = data.slice("tg:user_delete_confirm:".length);
    await edit("این کاربر و کانفیگ‌های او حذف شود؟", telegramConfirmKeyboard("tg:user_delete", id, "tg:user:" + id));
    return;
  }

  if (data.startsWith("tg:user_delete:")) {
    const id = data.slice("tg:user_delete:".length);
    const index = users.findIndex(item => item.id === id);
    if (index === -1) return edit("کاربر پیدا نشد.", telegramUsersKeyboard(users));
    const [removed] = users.splice(index, 1);
    await saveUsers(env, users);
    await env.CONFIGS_KV.delete(tokenKey(removed.token));
    await env.CONFIGS_KV.delete(configKey(removed.id));
    await env.CONFIGS_KV.delete(backupConfigKey(removed.id));
    await env.CONFIGS_KV.delete(metaKey(removed.id));
    await env.CONFIGS_KV.delete(backupMetaKey(removed.id));
    await edit("کاربر حذف شد: " + escapeHtml(removed.name), users.length ? telegramUsersKeyboard(users) : telegramInlineKeyboard(origin));
    return;
  }

  if (data === "tg:create_user") {
    await setTelegramState(env, chatId, { action: "create_user", messageId });
    await edit("نام کاربر جدید را ارسال کنید.\nبرای لغو، /cancel را بزنید.", telegramInlineKeyboard(origin));
    return;
  }

  if (data === "tg:bulk_menu") {
    await clearTelegramState(env, chatId);
    await edit("نوع اعمال گروهی را انتخاب کنید:", telegramBulkModeKeyboard());
    return;
  }

  if (data.startsWith("tg:bulk_all:")) {
    const mode = data.slice("tg:bulk_all:".length) === "append" ? "append" : "replace";
    await setTelegramState(env, chatId, { action: "bulk_configs", mode, target: "all", userIds: [], messageId });
    await edit((mode === "append" ? "کانفیگ‌هایی که باید به همه کاربران اضافه شوند" : "کانفیگ‌های جایگزین برای همه کاربران") + " را به صورت متن یا فایل ارسال کنید.\nبرای لغو، /cancel را بزنید.", telegramBulkModeKeyboard());
    return;
  }

  if (data.startsWith("tg:bulk_select:")) {
    const mode = data.slice("tg:bulk_select:".length) === "append" ? "append" : "replace";
    await setTelegramState(env, chatId, { action: "bulk_select", mode, userIds: [], messageId });
    await edit("کاربران مورد نظر را انتخاب کنید و سپس «ادامه و ارسال کانفیگ» را بزنید:", telegramBulkSelectKeyboard(users, []));
    return;
  }

  if (data.startsWith("tg:bulk_toggle:")) {
    const id = data.slice("tg:bulk_toggle:".length);
    const state = await getTelegramState(env, chatId);
    if (!state || state.action !== "bulk_select") {
      await setTelegramState(env, chatId, { action: "bulk_select", mode: "replace", userIds: [id], messageId });
      await edit("کاربران انتخاب‌شده: 1", telegramBulkSelectKeyboard(users, [id]));
      return;
    }
    const selected = new Set(state.userIds || []);
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    state.userIds = Array.from(selected);
    state.messageId = state.messageId || messageId;
    await setTelegramState(env, chatId, state);
    await edit("کاربران انتخاب‌شده: " + (state.userIds.length || 0), telegramBulkSelectKeyboard(users, state.userIds));
    return;
  }

  if (data === "tg:bulk_selected_continue") {
    const state = await getTelegramState(env, chatId);
    if (!state || state.action !== "bulk_select" || !state.userIds || !state.userIds.length) {
      await edit("حداقل یک کاربر را انتخاب کنید.", telegramBulkSelectKeyboard(users, []));
      return;
    }
    await setTelegramState(env, chatId, { action: "bulk_configs", mode: state.mode || "replace", target: "selected", userIds: state.userIds, messageId: state.messageId || messageId });
    await edit("اکنون کانفیگ‌ها را به صورت متن یا فایل ارسال کنید.\nبرای لغو، /cancel را بزنید.", telegramBulkSelectKeyboard(users, state.userIds));
    return;
  }

  if (data === "tg:password") {
    await setTelegramState(env, chatId, { action: "change_password", messageId });
    await edit("رمز عبور جدید پنل را ارسال کنید. حداقل ۸ کاراکتر.\nبرای لغو، /cancel را بزنید.", telegramInlineKeyboard(origin));
    return;
  }

  if (data === "tg:help") {
    await edit(telegramHelpText(), telegramInlineKeyboard(origin));
    return;
  }

  if (data === "tg:commands") {
    await edit(telegramCommandsText(), telegramInlineKeyboard(origin));
    return;
  }

  if (data === "tg:file_help") {
    await edit(telegramFileHelpText(), telegramInlineKeyboard(origin));
    return;
  }
}

function normalizeTelegramText(text) {
  const map = {
    "👥 کاربران": "/users",
    "❓ راهنما": "/help",
    "📋 لیست دستورات": "/commands",
    "📄 ارسال فایل": "/file",
    "➕ افزودن کاربر": "/newuser",
    "📦 اعمال گروهی": "/bulk",
    "🔐 تغییر رمز": "/password_change",
    "❌ لغو": "/cancel"
  };

  return map[text] || text;
}

function shouldShowTelegramInlineKeyboard(text) {
  return text === "/start" ||
    text === "/help" ||
    text === "/commands" ||
    text === "/file" ||
    text === "/miniapp" ||
    text === "/newuser" ||
    text === "/bulk" ||
    text === "/password_change";
}

async function getTelegramState(env, chatId) {
  return await getJson(env, telegramStateKey(chatId), null);
}

async function setTelegramState(env, chatId, state) {
  await env.CONFIGS_KV.put(telegramStateKey(chatId), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }), { expirationTtl: 3600 });
}

async function clearTelegramState(env, chatId) {
  await env.CONFIGS_KV.delete(telegramStateKey(chatId));
}

function telegramStateKey(chatId) {
  return TELEGRAM_STATE_PREFIX + chatId;
}

async function handleTelegramStateInput(inputText, state, chatId, env, settings, origin, fromFile = false) {
  const text = String(inputText || "").trim();
  if (!text) return "متن دریافتی خالی است.";

  if (state.action === "create_user") {
    const name = cleanName(text);
    if (!name) return "نام کاربر معتبر نیست.";
    const users = await getUsers(env);
    const user = { id: generateId(), name, token: generateToken(), enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastConfigUpdate: null };
    users.push(user);
    await saveUsers(env, users);
    await env.CONFIGS_KV.put(tokenKey(user.token), user.id);
    await env.CONFIGS_KV.put(configKey(user.id), "");
    await clearTelegramState(env, chatId);
    const p = publicUser(user, new URL(origin), env);
    return "کاربر ایجاد شد.\nنام: " + escapeHtml(user.name) + "\nشناسه: " + user.id + "\nلینک Raw:\n" + p.links.raw;
  }

  if (state.action === "rename_user") {
    const users = await getUsers(env);
    const user = users.find(item => item.id === state.userId);
    if (!user) { await clearTelegramState(env, chatId); return "کاربر پیدا نشد."; }
    const name = cleanName(text);
    if (!name) return "نام جدید معتبر نیست.";
    user.name = name;
    user.updatedAt = new Date().toISOString();
    await saveUsers(env, users);
    await clearTelegramState(env, chatId);
    return "نام کاربر تغییر کرد: " + escapeHtml(user.name);
  }

  if (state.action === "change_password") {
    if (text.length < 8) return "رمز عبور جدید باید حداقل ۸ کاراکتر باشد.";
    await env.CONFIGS_KV.put(ADMIN_PASSWORD_HASH_KEY, await sha256Hex(text));
    await env.CONFIGS_KV.put(ADMIN_PASSWORD_META_KEY, JSON.stringify({ updatedAt: new Date().toISOString(), source: "telegram-button" }));
    await clearTelegramState(env, chatId);
    return "رمز عبور پنل تغییر کرد.";
  }

  if (state.action === "set_configs" || state.action === "append_configs") {
    const users = await getUsers(env);
    const user = users.find(item => item.id === state.userId);
    if (!user) { await clearTelegramState(env, chatId); return "کاربر پیدا نشد."; }
    const current = await env.CONFIGS_KV.get(configKey(user.id)) || "";
    const input = state.action === "append_configs" ? current + "\n" + text : text;
    const saved = await saveConfigsForUser(env, user, input, { normalize: true, dedupe: true });
    user.lastConfigUpdate = saved.meta.updatedAt;
    user.updatedAt = saved.meta.updatedAt;
    await saveUsers(env, users);
    await clearTelegramState(env, chatId);
    return "کانفیگ‌های " + escapeHtml(user.name) + " ذخیره شد." + (fromFile ? "\nمنبع: فایل" : "") + "\nتعداد نهایی: " + saved.stats.total + "\nتکراری حذف‌شده: " + saved.stats.duplicatesByContent;
  }

  if (state.action === "bulk_configs") {
    const users = await getUsers(env);
    const selected = state.target === "all" ? users : users.filter(user => (state.userIds || []).includes(user.id));
    if (!selected.length) { await clearTelegramState(env, chatId); return "کاربری برای اعمال انتخاب نشده است."; }
    for (const user of selected) {
      const current = await env.CONFIGS_KV.get(configKey(user.id)) || "";
      const input = state.mode === "append" ? current + "\n" + text : text;
      const saved = await saveConfigsForUser(env, user, input, { normalize: true, dedupe: true });
      user.lastConfigUpdate = saved.meta.updatedAt;
      user.updatedAt = saved.meta.updatedAt;
    }
    await saveUsers(env, users);
    await clearTelegramState(env, chatId);
    return "کانفیگ‌ها اعمال شد." + (fromFile ? "\nمنبع: فایل" : "") + "\nتعداد کاربران: " + selected.length;
  }

  return "وضعیت عملیات مشخص نیست. /cancel را ارسال کنید.";
}

function telegramUserSummaryText(user) {
  return "کاربر: " + escapeHtml(user.name) + "\nشناسه: " + user.id + "\nوضعیت: " + (user.enabled !== false ? "فعال" : "غیرفعال") + "\nآخرین تغییر: " + (user.updatedAt || "-");
}

async function runTelegramCommand(text, env, origin, settings) {
  const [firstLine, ...restLines] = text.split("\n");
  const args = firstLine.trim().split(/\s+/);
  const command = (args[0] || "").toLowerCase();
  const restText = restLines.join("\n").trim();
  const url = new URL(origin);

  if (command === "/start") {
    return telegramStartText(settings.adminChatId);
  }

  if (command === "/id") {
    return "شناسه عددی تلگرام ادمین ثبت‌شده: " + escapeHtml(settings.adminChatId || "ثبت نشده") + "\n\n" +
      "توجه: USER_ID در دستورهای کانفیگ، شناسه داخلی کاربر پنل است، مثل u_xxxxx. آن را از /users یا دکمه «کاربران» بردارید.";
  }

  if (command === "/help") {
    return telegramHelpText();
  }

  if (command === "/commands") {
    return telegramCommandsText();
  }

  if (command === "/file") {
    return telegramFileHelpText();
  }

  if (command === "/cancel") {
    await clearTelegramState(env, settings.adminChatId);
    return "عملیات جاری لغو شد.";
  }

  if (command === "/newuser") {
    await setTelegramState(env, settings.adminChatId, { action: "create_user" });
    return "نام کاربر جدید را ارسال کنید.\nبرای لغو، /cancel را بزنید.";
  }

  if (command === "/bulk") {
    return "از دکمه‌های اعمال گروهی استفاده کنید.";
  }

  if (command === "/password_change") {
    await setTelegramState(env, settings.adminChatId, { action: "change_password" });
    return "رمز عبور جدید پنل را ارسال کنید. حداقل ۸ کاراکتر.\nبرای لغو، /cancel را بزنید.";
  }

  if (command === "/adduser_help") {
    return "برای ایجاد کاربر جدید، دستور را به این شکل ارسال کنید:\n/adduser mobile";
  }

  if (command === "/bulk_help") {
    return "برای جایگزینی کانفیگ همه کاربران:\n/apply_all\nvless://...\n\nبرای افزودن به کانفیگ فعلی همه کاربران:\n/append_all\nvless://...\n\nبرای چند کاربر مشخص:\n/apply_users id1,id2\nvless://...";
  }

  if (command === "/users") {
    const users = await getUsers(env);
    if (!users.length) return "هنوز کاربری ایجاد نشده است.";
    return users.map(user => {
      const p = publicUser(user, url, env);
      return "شناسه: " + user.id +
        "\nنام: " + escapeHtml(user.name) +
        "\nوضعیت: " + (user.enabled !== false ? "فعال" : "غیرفعال") +
        "\nلینک Raw: " + p.links.raw +
        "\nلینک Base64: " + p.links.base64;
    }).join("\n\n");
  }

  if (command === "/adduser") {
    const name = cleanName(args.slice(1).join(" "));
    if (!name) return "فرمت صحیح:\n/adduser mobile";
    const users = await getUsers(env);
    const user = {
      id: generateId(),
      name,
      token: generateToken(),
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastConfigUpdate: null
    };
    users.push(user);
    await saveUsers(env, users);
    await env.CONFIGS_KV.put(tokenKey(user.token), user.id);
    await env.CONFIGS_KV.put(configKey(user.id), "");
    const p = publicUser(user, url, env);
    return "کاربر ایجاد شد." +
      "\nشناسه: " + user.id +
      "\nنام: " + escapeHtml(user.name) +
      "\nلینک Raw: " + p.links.raw;
  }

  if (command === "/deluser") {
    const id = args[1] || "";
    const users = await getUsers(env);
    const index = users.findIndex(user => user.id === id);
    if (index === -1) return "کاربر پیدا نشد.";
    const [removed] = users.splice(index, 1);
    await saveUsers(env, users);
    await env.CONFIGS_KV.delete(tokenKey(removed.token));
    await env.CONFIGS_KV.delete(configKey(removed.id));
    await env.CONFIGS_KV.delete(backupConfigKey(removed.id));
    await env.CONFIGS_KV.delete(metaKey(removed.id));
    await env.CONFIGS_KV.delete(backupMetaKey(removed.id));
    return "کاربر حذف شد: " + escapeHtml(removed.name);
  }

  if (command === "/enable" || command === "/disable") {
    const id = args[1] || "";
    const users = await getUsers(env);
    const user = users.find(item => item.id === id);
    if (!user) return "کاربر پیدا نشد.";
    user.enabled = command === "/enable";
    user.updatedAt = new Date().toISOString();
    await saveUsers(env, users);
    return "وضعیت کاربر تغییر کرد: " + escapeHtml(user.name) + " - " + (user.enabled ? "فعال" : "غیرفعال");
  }

  if (command === "/configs") {
    const id = args[1] || "";
    const user = await getUserById(env, id);
    if (!user) return "کاربر پیدا نشد.";
    const configs = await env.CONFIGS_KV.get(configKey(user.id)) || "";
    const stats = analyzeConfigs(configs);
    const preview = configs.split("\n").filter(Boolean).slice(0, 8).join("\n");
    return "کاربر: " + escapeHtml(user.name) +
      "\nتعداد: " + stats.total +
      "\nتکراری محتوایی: " + stats.duplicatesByContent +
      "\n\n" + (preview ? escapeHtml(preview) : "کانفیگی ثبت نشده است.");
  }

  if (command === "/setconfigs" || command === "/appendconfigs") {
    const id = args[1] || "";
    const users = await getUsers(env);
    const user = users.find(item => item.id === id);
    if (!user) return "کاربر پیدا نشد.";
    if (!restText) return "کانفیگ‌ها را از خط بعدی پیام وارد کنید، یا یک فایل متنی با کپشن همین دستور ارسال کنید.";
    const current = await env.CONFIGS_KV.get(configKey(user.id)) || "";
    const input = command === "/appendconfigs" ? current + "\n" + restText : restText;
    const saved = await saveConfigsForUser(env, user, input, { normalize: true, dedupe: true });
    user.lastConfigUpdate = saved.meta.updatedAt;
    user.updatedAt = saved.meta.updatedAt;
    await saveUsers(env, users);
    return "کانفیگ‌های " + escapeHtml(user.name) + " ذخیره شد." +
      "\nتعداد نهایی: " + saved.stats.total +
      "\nتکراری حذف‌شده: " + saved.stats.duplicatesByContent;
  }

  if (command === "/apply_all" || command === "/append_all") {
    if (!restText) return "کانفیگ‌ها را از خط بعدی پیام وارد کنید، یا یک فایل متنی با کپشن همین دستور ارسال کنید.";
    const users = await getUsers(env);
    if (!users.length) return "کاربری وجود ندارد.";
    for (const user of users) {
      const current = await env.CONFIGS_KV.get(configKey(user.id)) || "";
      const input = command === "/append_all" ? current + "\n" + restText : restText;
      const saved = await saveConfigsForUser(env, user, input, { normalize: true, dedupe: true });
      user.lastConfigUpdate = saved.meta.updatedAt;
      user.updatedAt = saved.meta.updatedAt;
    }
    await saveUsers(env, users);
    return "کانفیگ‌ها برای همه کاربران اعمال شد. تعداد کاربران: " + users.length;
  }

  if (command === "/apply_users" || command === "/append_users") {
    const ids = String(args[1] || "").split(",").map(item => item.trim()).filter(Boolean);
    if (!ids.length) return "فرمت صحیح:\n/apply_users id1,id2\nسپس کانفیگ‌ها از خط بعدی یا فایل با همین کپشن";
    if (!restText) return "کانفیگ‌ها را از خط بعدی پیام وارد کنید، یا یک فایل متنی با کپشن همین دستور ارسال کنید.";
    const users = await getUsers(env);
    const selected = users.filter(user => ids.includes(user.id));
    if (!selected.length) return "هیچ کاربری با این شناسه‌ها پیدا نشد.";
    for (const user of selected) {
      const current = await env.CONFIGS_KV.get(configKey(user.id)) || "";
      const input = command === "/append_users" ? current + "\n" + restText : restText;
      const saved = await saveConfigsForUser(env, user, input, { normalize: true, dedupe: true });
      user.lastConfigUpdate = saved.meta.updatedAt;
      user.updatedAt = saved.meta.updatedAt;
    }
    await saveUsers(env, users);
    return "کانفیگ‌ها برای کاربران انتخاب‌شده اعمال شد. تعداد: " + selected.length;
  }

  if (command === "/password") {
    const newPassword = args.slice(1).join(" ");
    if (newPassword.length < 8) return "رمز عبور جدید باید حداقل ۸ کاراکتر باشد.";
    await env.CONFIGS_KV.put(ADMIN_PASSWORD_HASH_KEY, await sha256Hex(newPassword));
    await env.CONFIGS_KV.put(ADMIN_PASSWORD_META_KEY, JSON.stringify({ updatedAt: new Date().toISOString(), source: "telegram" }));
    return "رمز عبور پنل تغییر کرد.";
  }

  if (command === "/webhook") {
    const result = await configureTelegramEntryPoints(settings, origin);
    return "وبهوک، منوی ربات، دکمه مینی‌اپ و لیست دستورها دوباره تنظیم شد.\n" + escapeHtml(JSON.stringify(result));
  }

  return "دستور شناخته نشد. برای راهنما /help را ارسال کنید.";
}

function telegramStartText() {
  return "ربات مدیریت کانفیگ‌ها فعال است.\n\nاز دکمه‌های پایین می‌توانید کاربران، کانفیگ‌ها و تنظیمات گروهی را مدیریت کنید.\nبرای راهنمای کامل، دکمه «❓ راهنما» یا دستور /help را بزنید. لیست دستورها نیز با زدن / در تلگرام نمایش داده می‌شود.";
}

function telegramHelpText() {
  return "راهنمای مدیریت ربات\n\n" +
    "📝 ارسال کانفیگ متنی:\n" +
    "/setconfigs USER_ID\n" +
    "vless://...\n" +
    "trojan://...\n\n" +
    "📄 ارسال کانفیگ با فایل:\n" +
    "یک فایل txt/conf ارسال کنید و در Caption آن دستور مورد نظر را بنویسید. مثال:\n" +
    "/setconfigs USER_ID\n\n" +
    "📋 برای دیدن لیست کامل دستورها، /commands را ارسال کنید.";
}

function telegramCommandsText() {
  return "لیست دستورهای ربات\n\n" +
    "/start - نمایش منوی اصلی\n" +
    "/help - راهنمای کامل استفاده\n" +
    "/commands - توضیح دستورها\n" +
    "/file - راهنمای ارسال فایل کانفیگ\n" +
    "/users - باز کردن مدیریت کاربران با دکمه\n" +
    "/newuser - ایجاد کاربر به صورت مرحله‌ای\n" +
    "/bulk - اعمال گروهی با دکمه\n" +
    "/cancel - لغو عملیات جاری\n" +
    "/setconfigs ID - جایگزینی کانفیگ کاربر\n" +
    "/appendconfigs ID - افزودن کانفیگ به کاربر\n" +
    "/apply_all - جایگزینی کانفیگ همه کاربران\n" +
    "/append_all - افزودن کانفیگ به همه کاربران\n" +
    "/apply_users id1,id2 - جایگزینی برای چند کاربر\n" +
    "/append_users id1,id2 - افزودن برای چند کاربر\n" +
    "/password NEW_PASSWORD - تغییر رمز پنل\n" +
    "/webhook - تنظیم مجدد وبهوک، منو و کامندها";
}

function telegramFileHelpText() {
  return "راهنمای ارسال فایل کانفیگ\n\n" +
    "۱. یک فایل متنی با پسوند txt یا conf آماده کنید.\n" +
    "۲. فایل را برای ربات ارسال کنید.\n" +
    "۳. در قسمت Caption فایل، یکی از دستورهای زیر را بنویسید:\n\n" +
    "برای جایگزینی کانفیگ یک کاربر:\n" +
    "/setconfigs USER_ID\n\n" +
    "برای افزودن به کانفیگ یک کاربر:\n" +
    "/appendconfigs USER_ID\n\n" +
    "برای جایگزینی همه کاربران:\n" +
    "/apply_all\n\n" +
    "برای افزودن به همه کاربران:\n" +
    "/append_all\n\n" +
    "برای چند کاربر مشخص:\n" +
    "/apply_users id1,id2\n\n" +
    "بعد از دریافت فایل، کانفیگ‌های تکراری حتی با نام متفاوت حذف می‌شوند.";
}

function configKey(userId) { return "user_configs:" + userId; }
function backupConfigKey(userId) { return "user_configs_backup:" + userId; }
function metaKey(userId) { return "user_configs_meta:" + userId; }
function backupMetaKey(userId) { return "user_configs_backup_meta:" + userId; }
function tokenKey(token) { return "user_token:" + token; }

async function getJson(env, key, fallback) {
  const raw = await env.CONFIGS_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.map(item => String(item)).filter(Boolean) : [];
}

function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function safeFilename(value) {
  return String(value || "user").replace(/[^a-zA-Z0-9-_\u0600-\u06FF]+/g, "-").slice(0, 80) || "user";
}

function generateId() {
  return "u_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function generateToken(length = 56) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(byte => chars[byte % chars.length]).join("");
}

function constantTimeEqual(a, b) {
  a = String(a || "");
  b = String(b || "");
  let result = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0;
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function safeBase64Decode(input) {
  try {
    let value = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
    while (value.length % 4) value += "=";
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function maskToken(token) {
  token = String(token || "");
  if (token.length <= 12) return "ثبت شده";
  return token.slice(0, 6) + "…" + token.slice(-6);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...securityHeaders(),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function htmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: {
      ...securityHeaders(),
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function securityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()"
  };
}

const ADMIN_HTML = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>پنل مدیریت کانفیگ‌ها</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root {
      --bg: #070a12;
      --surface: rgba(255,255,255,.08);
      --surface2: rgba(255,255,255,.12);
      --border: rgba(255,255,255,.14);
      --text: #eef3ff;
      --muted: #aeb9ca;
      --primary: #7c5cff;
      --primary2: #00d4ff;
      --success: #3ddc97;
      --danger: #ff5c7a;
      --warning: #ffc857;
      --shadow: 0 24px 90px rgba(0,0,0,.45);
      --radius: 24px;
      font-family: Vazirmatn, IRANSans, Segoe UI, Tahoma, Arial, sans-serif;
    }

    * { box-sizing: border-box; }
    html { margin: 0; min-height: 100%; background: var(--bg); }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background-color: var(--bg);
      background-image:
        radial-gradient(circle at 15% 10%, rgba(124, 92, 255, .36), transparent 28%),
        radial-gradient(circle at 90% 5%, rgba(0, 212, 255, .22), transparent 26%),
        radial-gradient(circle at 50% 100%, rgba(61, 220, 151, .14), transparent 30%),
        linear-gradient(135deg, #070a12 0%, #101728 100%);
      background-repeat: no-repeat;
      background-size: cover;
      background-attachment: fixed;
    }

    button, input, textarea, select { font: inherit; }
    .hidden { display: none !important; }
    .tg-app-path #logoutBtn { display: none !important; }
    .app { width: min(1320px, calc(100% - 28px)); min-height: 100vh; margin: 0 auto; padding: 28px 0 42px; }

    .shell {
      background: rgba(255,255,255,.065);
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      border-radius: 32px;
      overflow: hidden;
      backdrop-filter: blur(18px);
    }

    .login-wrap { min-height: calc(100vh - 80px); display: grid; place-items: center; padding: 22px; }
    .login-card { width: min(460px, 100%); padding: 30px; }
    .brand { display: flex; align-items: center; gap: 14px; }
    .logo {
      width: 52px; height: 52px; border-radius: 18px;
      display: grid; place-items: center;
      background: linear-gradient(135deg, var(--primary), var(--primary2));
      box-shadow: 0 14px 35px rgba(124,92,255,.32);
      font-weight: 900;
      letter-spacing: -1px;
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: clamp(22px, 3.2vw, 34px); letter-spacing: -1px; }
    h2, h3 { font-size: 18px; }
    .subtitle { color: var(--muted); line-height: 1.9; margin-top: 8px; }

    .field { display: grid; gap: 9px; margin-top: 16px; }
    .label { color: #d9e2f2; font-size: 14px; }
    .input, .textarea, .select {
      width: 100%;
      color: var(--text);
      background: rgba(3, 8, 20, .62);
      border: 1px solid rgba(255,255,255,.16);
      border-radius: 18px;
      outline: none;
      transition: .18s ease;
    }
    .input, .select { padding: 14px 16px; }
    .input.ltr { direction: ltr; text-align: left; }
    .input.rtl { direction: rtl; text-align: right; }
    .input:focus, .textarea:focus, .select:focus { border-color: rgba(124,92,255,.8); box-shadow: 0 0 0 4px rgba(124,92,255,.14); }

    .btn {
      border: 0;
      border-radius: 16px;
      padding: 12px 16px;
      color: var(--text);
      background: rgba(255,255,255,.12);
      border: 1px solid rgba(255,255,255,.14);
      cursor: pointer;
      transition: transform .16s ease, background .16s ease, border-color .16s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      white-space: nowrap;
      user-select: none;
    }
    .btn:hover { transform: translateY(-1px); background: rgba(255,255,255,.16); }
    .btn:active { transform: translateY(0); }
    .btn.primary { background: linear-gradient(135deg, var(--primary), #5d8cff); border-color: transparent; box-shadow: 0 12px 28px rgba(124,92,255,.24); }
    .btn.success { background: linear-gradient(135deg, #16c784, #00b3a4); border-color: transparent; }
    .btn.danger { color: #ffdce3; border-color: rgba(255,92,122,.35); background: rgba(255,92,122,.12); }
    .btn.ghost { background: transparent; }
    .btn.full { width: 100%; margin-top: 18px; }
    .btn.small { padding: 9px 11px; border-radius: 12px; font-size: 12px; }

    .topbar { display: flex; justify-content: space-between; align-items: center; gap: 18px; margin-bottom: 22px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 10px; }
    .dashboard { padding: 20px; }
    .layout { display: grid; grid-template-columns: 290px 1fr; gap: 18px; }
    .card { background: rgba(255,255,255,.075); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; }
    .card-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }

    .tabs { display: grid; gap: 10px; }
    .tab {
      width: 100%; text-align: right; border-radius: 18px; padding: 13px 14px;
      border: 1px solid rgba(255,255,255,.12); background: rgba(3,8,20,.32); color: var(--text); cursor: pointer;
    }
    .tab.active { background: linear-gradient(135deg, rgba(124,92,255,.32), rgba(0,212,255,.14)); border-color: rgba(124,92,255,.54); }
    .panel { display: none; }
    .panel.active { display: block; }

    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .user-list { display: grid; gap: 10px; max-height: 580px; overflow: auto; padding-inline-end: 4px; }
    .user-item {
      border: 1px solid rgba(255,255,255,.12); background: rgba(3,8,20,.36); border-radius: 18px;
      padding: 13px; cursor: pointer;
    }
    .user-item.active { border-color: rgba(124,92,255,.7); background: rgba(124,92,255,.16); }
    .user-item strong { display: block; margin-bottom: 6px; }
    .user-item span { color: var(--muted); font-size: 12px; }

    .textarea {
      min-height: 420px;
      resize: vertical;
      padding: 16px;
      direction: ltr;
      text-align: left;
      line-height: 1.75;
      font-family: Consolas, Monaco, "Courier New", monospace;
      font-size: 13px;
    }
    .textarea.small { min-height: 260px; }

    .drop {
      border: 1.5px dashed rgba(255,255,255,.22);
      border-radius: 22px;
      padding: 16px;
      background: rgba(3,8,20,.34);
      transition: .16s ease;
      text-align: center;
      color: var(--muted);
      line-height: 1.8;
      cursor: pointer;
      margin-bottom: 12px;
    }
    .drop.drag { border-color: var(--primary2); background: rgba(0,212,255,.08); color: var(--text); }

    .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
    .stat { padding: 13px; border-radius: 18px; background: rgba(3,8,20,.42); border: 1px solid rgba(255,255,255,.1); }
    .stat span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 7px; }
    .stat strong { font-size: 22px; letter-spacing: -.5px; }

    .linkbox { display: grid; gap: 8px; }
    .linkrow { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
    .code {
      direction: ltr; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      padding: 12px 13px; border-radius: 14px; background: rgba(3,8,20,.55); border: 1px solid rgba(255,255,255,.1); color: #d9e2f2; font-size: 12px;
    }
    .meta { color: var(--muted); line-height: 2; font-size: 13px; word-break: break-word; }
    .meta b { color: var(--text); font-weight: 700; }
    .checks { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0; color: var(--muted); font-size: 13px; }
    .checks label { display: inline-flex; align-items: center; gap: 7px; }
    .muted { color: var(--muted); line-height: 1.9; }

    .toast { position: fixed; inset-inline: 18px; bottom: 18px; display: grid; gap: 10px; z-index: 50; pointer-events: none; }
    .toast-item { justify-self: end; max-width: min(560px, 100%); padding: 13px 15px; border-radius: 16px; background: rgba(8,12,22,.92); border: 1px solid rgba(255,255,255,.16); box-shadow: 0 15px 44px rgba(0,0,0,.4); color: var(--text); pointer-events: auto; animation: slide .22s ease; }
    .toast-item.ok { border-color: rgba(61,220,151,.42); }
    .toast-item.err { border-color: rgba(255,92,122,.48); }


    .card,
    .field,
    .grid2 > *,
    .layout > *,
    .toolbar,
    .linkrow,
    .code {
      min-width: 0;
    }

    body {
      overflow-x: hidden;
    }

    .select {
      appearance: none;
      -webkit-appearance: none;
      padding-inline: 16px;
      background: linear-gradient(135deg, rgba(124,92,255,.18), rgba(0,212,255,.08));
      box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
    }

    .select option {
      background: #161b2a;
      color: #eef3ff;
    }

    .checks input[type="checkbox"] {
      appearance: none;
      -webkit-appearance: none;
      width: 21px;
      height: 21px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,.24);
      background: rgba(3,8,20,.58);
      display: inline-grid;
      place-items: center;
      cursor: pointer;
      flex: 0 0 auto;
      transition: .16s ease;
    }

    .checks input[type="checkbox"]::after {
      content: "✓";
      color: #fff;
      font-size: 15px;
      font-weight: 900;
      line-height: 1;
      transform: scale(0);
      opacity: 0;
      transition: .16s ease;
    }

    .checks input[type="checkbox"]:checked {
      border-color: transparent;
      background: linear-gradient(135deg, var(--primary), var(--primary2));
      box-shadow: 0 10px 24px rgba(124,92,255,.22);
    }

    .checks input[type="checkbox"]:checked::after {
      transform: scale(1);
      opacity: 1;
    }

    .tg-miniapp .app {
      width: min(100%, 1320px);
      padding: 14px;
    }

    .tg-miniapp .topbar {
      margin-bottom: 14px;
    }

    .tg-miniapp .shell {
      border-radius: 24px;
    }



    #telegramPanel .grid2,
    #bulkPanel .grid2 {
      align-items: end;
    }

    @media (max-width: 520px) {
      .toolbar,
      .card-title {
        display: grid;
        grid-template-columns: 1fr;
        align-items: stretch;
      }

      .toolbar .btn,
      .card-title .btn {
        width: 100%;
      }

      .checks {
        display: grid;
        grid-template-columns: 1fr;
      }

      .checks label {
        width: 100%;
        justify-content: flex-start;
        flex-direction: row-reverse;
        background: rgba(3,8,20,.28);
        border: 1px solid rgba(255,255,255,.08);
        border-radius: 14px;
        padding: 10px 12px;
      }
    }

    @media (max-width: 720px) {
      .app {
        width: 100%;
        padding: 12px;
      }

      .dashboard,
      .card,
      .login-card {
        padding: 14px;
      }

      .shell {
        border-radius: 22px;
      }

      .brand {
        align-items: flex-start;
      }

      .logo {
        width: 44px;
        height: 44px;
        border-radius: 15px;
      }

      .toolbar {
        width: 100%;
        display: grid;
        grid-template-columns: 1fr 1fr;
      }

      .toolbar .btn,
      .card-title .toolbar {
        width: 100%;
      }

      .card-title {
        align-items: stretch;
        flex-direction: column;
      }

      .stats {
        grid-template-columns: 1fr 1fr;
      }

      .textarea {
        min-height: 300px;
        font-size: 12px;
      }

      h1 {
        font-size: 22px;
      }
    }

    @media (max-width: 420px) {
      .toolbar,
      .stats {
        grid-template-columns: 1fr;
      }

      .btn,
      .input,
      .select {
        width: 100%;
      }
    }

    @keyframes slide { from { transform: translateY(14px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

    @media (max-width: 1050px) {
      .layout, .grid2, .grid3 { grid-template-columns: 1fr; }
      .stats { grid-template-columns: repeat(2, 1fr); }
      .topbar { align-items: flex-start; flex-direction: column; }
      .linkrow { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="app">
    <section id="loginView" class="login-wrap">
      <div class="shell login-card">
        <div class="brand">
          <div class="logo">SUB</div>
          <div><h1>پنل مدیریت کانفیگ‌ها</h1></div>
        </div>
        <form id="loginForm">
          <div class="field">
            <label class="label" for="passwordInput">رمز عبور</label>
            <input id="passwordInput" class="input rtl" type="password" autocomplete="current-password" placeholder="رمز عبور" />
          </div>
          <button class="btn primary full" type="submit">ورود به پنل</button>
        </form>
      </div>
    </section>

    <section id="dashboardView" class="hidden">
      <div class="topbar">
        <div class="brand">
          <div class="logo">SUB</div>
          <div>
            <h1>مدیریت پیشرفته کانفیگ‌ها</h1>
            <p class="subtitle">کاربر ایجاد کنید، کانفیگ اختصاصی بدهید، تنظیمات گروهی اعمال کنید و ربات تلگرام را متصل کنید.</p>
          </div>
        </div>
        <div class="toolbar">
          <button id="refreshBtn" class="btn">بارگذاری مجدد</button>
          <button id="logoutBtn" class="btn ghost">خروج</button>
        </div>
      </div>

      <div class="shell dashboard">
        <div class="layout">
          <aside class="card">
            <div class="card-title"><h2>بخش‌ها</h2></div>
            <div class="tabs">
              <button class="tab active" data-tab="usersPanel">کاربران</button>
              <button class="tab" data-tab="configsPanel">کانفیگ اختصاصی کاربر</button>
              <button class="tab" data-tab="bulkPanel">اعمال گروهی کانفیگ</button>
              <button class="tab" data-tab="securityPanel">امنیت و رمز عبور</button>
              <button class="tab" data-tab="telegramPanel">ربات تلگرام</button>
            </div>
          </aside>

          <section>
            <div id="usersPanel" class="panel active">
              <div class="grid2">
                <div class="card">
                  <div class="card-title"><h2>ایجاد کاربر</h2></div>
                  <div class="field">
                    <label class="label">نام کاربر</label>
                    <input id="newUserName" class="input rtl" placeholder="مثلاً موبایل، لپ‌تاپ، کاربر ۱" />
                  </div>
                  <button id="createUserBtn" class="btn primary full">ایجاد کاربر</button>
                </div>
                <div class="card">
                  <div class="card-title"><h2>کاربران</h2></div>
                  <div id="usersList" class="user-list"></div>
                </div>
              </div>
            </div>

            <div id="configsPanel" class="panel">
              <div class="card">
                <div class="card-title">
                  <h2>کانفیگ اختصاصی کاربر</h2>
                  <div class="toolbar">
                    <button id="fileBtn" class="btn">آپلود فایل</button>
                    <button id="cleanBtn" class="btn">پاک‌سازی</button>
                    <button id="downloadBtn" class="btn">دانلود TXT</button>
                    <button id="restoreBtn" class="btn danger">بازیابی بکاپ</button>
                    <button id="saveConfigsBtn" class="btn success">ذخیره کانفیگ‌ها</button>
                  </div>
                </div>

                <div class="grid2">
                  <div>
                    <div class="field">
                      <label class="label">انتخاب کاربر</label>
                      <select id="selectedUserSelect" class="select"></select>
                    </div>
                    <div class="field">
                      <label class="label">نام کاربر</label>
                      <input id="editUserName" class="input rtl" />
                    </div>
                    <div class="checks">
                      <label><input id="editUserEnabled" type="checkbox" checked /> کاربر فعال باشد</label>
                    </div>
                    <div class="toolbar">
                      <button id="updateUserBtn" class="btn">ذخیره مشخصات</button>
                      <button id="regenTokenBtn" class="btn danger">ساخت توکن جدید</button>
                      <button id="deleteUserBtn" class="btn danger">حذف کاربر</button>
                    </div>
                  </div>
                  <div>
                    <div class="label">لینک Raw</div>
                    <div class="linkrow"><div id="rawLink" class="code">-</div><button id="copyRawBtn" class="btn small">کپی</button></div>
                    <div style="height:8px"></div>
                    <div class="label">لینک Base64</div>
                    <div class="linkrow"><div id="base64Link" class="code">-</div><button id="copyBase64Btn" class="btn small">کپی</button></div>
                    <button id="openRawBtn" class="btn full">تست لینک Raw</button>
                  </div>
                </div>

                <div style="height:16px"></div>
                <div class="stats">
                  <div class="stat"><span>کل کانفیگ</span><strong id="statTotal">0</strong></div>
                  <div class="stat"><span>شناخته‌شده</span><strong id="statValid">0</strong></div>
                  <div class="stat"><span>نامشخص</span><strong id="statUnknown">0</strong></div>
                  <div class="stat"><span>تکراری محتوایی</span><strong id="statDupContent">0</strong></div>
                </div>

                <input id="fileInput" class="hidden" type="file" accept=".txt,.conf,.json,.yaml,.yml,text/plain" />
                <div id="dropArea" class="drop">فایل را اینجا بکشید و رها کنید، یا روی «آپلود فایل» بزنید. متن فایل داخل باکس زیر نمایش داده می‌شود.</div>
                <div class="checks">
                  <label><input id="normalizeCheck" type="checkbox" checked /> حذف خطوط خالی و فاصله‌های اضافی</label>
                  <label><input id="dedupeCheck" type="checkbox" checked /> حذف کانفیگ‌های تکراری حتی با نام متفاوت</label>
                </div>
                <textarea id="configsText" class="textarea" spellcheck="false"></textarea>
              </div>
            </div>

            <div id="bulkPanel" class="panel">
              <div class="card">
                <div class="card-title"><h2>اعمال گروهی کانفیگ</h2></div>
                <p class="muted">در این بخش می‌توانید یک مجموعه کانفیگ را برای همه کاربران یا فقط کاربران انتخاب‌شده اعمال کنید.</p>
                <div class="grid2">
                  <div class="field">
                    <label class="label">نوع اعمال</label>
                    <select id="bulkMode" class="select">
                      <option value="replace">جایگزینی کامل کانفیگ کاربران</option>
                      <option value="append">افزودن به کانفیگ فعلی کاربران</option>
                    </select>
                  </div>
                  <div class="field">
                    <label class="label">محدوده اعمال</label>
                    <select id="bulkTarget" class="select">
                      <option value="all">همه کاربران</option>
                      <option value="selected">فقط کاربران انتخاب‌شده</option>
                    </select>
                  </div>
                </div>
                <div id="bulkUsersBox" class="checks"></div>
                <textarea id="bulkConfigsText" class="textarea small" spellcheck="false"></textarea>
                <button id="applyBulkBtn" class="btn success full">اعمال کانفیگ‌ها</button>
              </div>
            </div>

            <div id="securityPanel" class="panel">
              <div class="card">
                <div class="card-title"><h2>تغییر رمز عبور پنل</h2></div>
                <div class="grid2">
                  <div class="field">
                    <label class="label">رمز عبور فعلی</label>
                    <input id="currentPassword" class="input rtl" type="password" />
                  </div>
                  <div class="field">
                    <label class="label">رمز عبور جدید</label>
                    <input id="newPassword" class="input rtl" type="password" />
                  </div>
                </div>
                <button id="changePasswordBtn" class="btn primary full">تغییر رمز عبور</button>
                <p id="passwordMode" class="muted" style="margin-top:14px"></p>
              </div>
            </div>

            <div id="telegramPanel" class="panel">
              <div class="card">
                <div class="card-title"><h2>اتصال ربات تلگرام</h2></div>
                <p class="muted">توکن بات و شناسه عددی ادمین را وارد کنید. بعد از ذخیره، وبهوک، دکمه‌های ربات و لیست کامندها تنظیم می‌شوند. برای دکمه آبی Open کنار پروفایل ربات، همین آدرس مینی‌اپ را در BotFather بخش /myapps ثبت کنید.</p>
                <div class="grid2">
                  <div class="field">
                    <label class="label">توکن بات تلگرام</label>
                    <input id="telegramBotToken" class="input ltr" placeholder="123456:ABC..." />
                  </div>
                  <div class="field">
                    <label class="label">شناسه عددی ادمین</label>
                    <input id="telegramAdminId" class="input ltr" placeholder="مثلاً 123456789" />
                  </div>
                </div>
                <div class="checks"><label><input id="telegramEnabled" type="checkbox" /> ربات فعال باشد</label></div>
                <div class="toolbar">
                  <button id="saveTelegramBtn" class="btn primary">ذخیره و فعال‌سازی وبهوک</button>
                  <button id="testTelegramBtn" class="btn">ارسال پیام تست</button>
                </div>
                <div style="height:14px"></div>
                <div class="label">آدرس وبهوک</div>
                <div id="telegramWebhook" class="code">-</div>
                <div style="height:14px"></div>
                <div class="label">آدرس مینی‌اپ</div>
                <div class="linkrow">
                  <div id="telegramMiniApp" class="code">-</div>
                  <button id="copyMiniAppBtn" class="btn small">کپی</button>
                </div>
                <div style="height:14px"></div>
                <div class="card" style="background:rgba(3,8,20,.32)">
                  <h3>نمونه دستورهای ربات</h3>
                  <p class="muted" style="direction:ltr;text-align:left;white-space:pre-line">/users
/adduser mobile
/setconfigs USER_ID
vless://...
/apply_all
vless://...
/apply_users id1,id2
vless://...</p>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </section>
  </main>

  <div id="toast" class="toast"></div>

  <script>
    var $ = function(id) { return document.getElementById(id); };
    var storageKey = "sub_panel_admin_password";
    var isTelegramMiniAppPath = location.pathname.replace(/\\/$/, "") === "/tg-app";
    var telegramWebApp = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
    var telegramInitData = getTelegramInitData();
    var authMode = isTelegramMiniAppPath && telegramInitData ? "telegram" : "password";

    if (isTelegramMiniAppPath) {
      document.body.classList.add("tg-app-path");
    }

    if (telegramWebApp) {
      telegramWebApp.ready();
      telegramWebApp.expand();
      document.body.classList.add("tg-miniapp");
      try { telegramWebApp.MainButton.hide(); } catch (e) {}
    }

    function getTelegramInitData() {
      try {
        if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) {
          return window.Telegram.WebApp.initData;
        }

        var hash = String(location.hash || "").replace(/^#/, "");
        if (hash) {
          var params = new URLSearchParams(hash);
          var fromHash = params.get("tgWebAppData");
          if (fromHash) return decodeURIComponent(fromHash);
        }
      } catch (e) {}

      return "";
    }

    function showMiniAppAuthError(message) {
      showLogin();
      $("passwordInput").placeholder = "رمز عبور";
      toast(message || "ورود خودکار تلگرام انجام نشد.", "err");
    }

    var users = [];
    var currentUserId = "";
    var currentLinks = { raw: "", base64: "" };

    function getPassword() { return localStorage.getItem(storageKey) || ""; }
    function setPassword(value) { localStorage.setItem(storageKey, value); }
    function clearPassword() { localStorage.removeItem(storageKey); }

    async function api(path, options) {
      options = options || {};
      var headers = Object.assign({}, options.headers || {});

      if (authMode === "telegram" && telegramInitData) {
        headers["x-telegram-init-data"] = telegramInitData;
      } else {
        headers["authorization"] = "Bearer " + getPassword();
      }

      var res = await fetch(path, Object.assign({}, options, { headers: headers }));
      var data = null;
      try { data = await res.json(); } catch (e) { data = { ok: false, error: "پاسخ سرور نامعتبر است." }; }
      if (!res.ok || !data.ok) throw new Error(data.error || "درخواست ناموفق بود.");
      return data;
    }

    function showLogin() { $("loginView").classList.remove("hidden"); $("dashboardView").classList.add("hidden"); $("passwordInput").focus(); }
    function showDashboard() { $("loginView").classList.add("hidden"); $("dashboardView").classList.remove("hidden"); }

    function toast(message, type) {
      var box = document.createElement("div");
      box.className = "toast-item " + (type === "err" ? "err" : "ok");
      box.textContent = message;
      $("toast").appendChild(box);
      setTimeout(function() { box.remove(); }, 4200);
    }

    function switchTab(tabId) {
      document.querySelectorAll(".tab").forEach(function(btn) { btn.classList.toggle("active", btn.dataset.tab === tabId); });
      document.querySelectorAll(".panel").forEach(function(panel) { panel.classList.toggle("active", panel.id === tabId); });
    }

    document.querySelectorAll(".tab").forEach(function(btn) { btn.addEventListener("click", function() { switchTab(btn.dataset.tab); }); });

    async function login(password) {
      setPassword(password);
      await api("/api/admin/login", { method: "POST" });
      showDashboard();
      await refreshState();
    }

    async function refreshState() {
      var data = await api("/api/admin/state");
      users = data.users || [];
      renderUsers();
      renderSelects();
      renderBulkUsers();
      renderTelegram(data.telegram || {});
      $("passwordMode").textContent = data.adminPasswordChanged ? "رمز عبور اختصاصی برای پنل ثبت شده است." : "در حال حاضر رمز اولیه admin استفاده می‌شود.";
      if (!currentUserId && users.length) currentUserId = users[0].id;
      if (currentUserId) await loadUserConfigs(currentUserId);
    }

    function renderUsers() {
      var box = $("usersList");
      box.innerHTML = "";
      if (!users.length) {
        box.innerHTML = '<p class="muted">هنوز کاربری ایجاد نشده است.</p>';
        return;
      }
      users.forEach(function(user) {
        var item = document.createElement("div");
        item.className = "user-item" + (user.id === currentUserId ? " active" : "");
        item.innerHTML = "<strong>" + escapeHtml(user.name) + "</strong><span>" + (user.enabled ? "فعال" : "غیرفعال") + " · " + user.id + "</span>";
        item.addEventListener("click", async function() { currentUserId = user.id; switchTab("configsPanel"); await loadUserConfigs(user.id); renderUsers(); renderSelects(); });
        box.appendChild(item);
      });
    }

    function renderSelects() {
      var select = $("selectedUserSelect");
      select.innerHTML = "";
      users.forEach(function(user) {
        var opt = document.createElement("option");
        opt.value = user.id;
        opt.textContent = user.name;
        if (user.id === currentUserId) opt.selected = true;
        select.appendChild(opt);
      });
    }

    function renderBulkUsers() {
      var box = $("bulkUsersBox");
      box.innerHTML = "";
      users.forEach(function(user) {
        var label = document.createElement("label");
        label.innerHTML = '<input type="checkbox" class="bulk-user" value="' + user.id + '" /> ' + escapeHtml(user.name);
        box.appendChild(label);
      });
    }

    function renderTelegram(tg) {
      $("telegramEnabled").checked = tg.enabled === true;
      $("telegramAdminId").value = tg.adminChatId || "";
      $("telegramBotToken").placeholder = tg.botTokenSaved ? "Saved token" : "123456:ABC...";
      $("telegramWebhook").textContent = tg.webhookUrl || "-";
      $("telegramMiniApp").textContent = tg.miniAppUrl || (location.origin + "/tg-app");
    }

    async function loadUserConfigs(id) {
      if (!id) return;
      currentUserId = id;
      var data = await api("/api/admin/users/configs?id=" + encodeURIComponent(id));
      var user = data.user;
      $("selectedUserSelect").value = user.id;
      $("editUserName").value = user.name;
      $("editUserEnabled").checked = user.enabled;
      $("configsText").value = data.configs || "";
      setLinks(user.links);
      updateStats(data.stats);
    }

    function setLinks(links) {
      currentLinks = links || { raw: "", base64: "" };
      $("rawLink").textContent = currentLinks.raw || "-";
      $("base64Link").textContent = currentLinks.base64 || "-";
    }

    function clientAnalyze(text) {
      var schemes = ["vless://", "vmess://", "trojan://", "ss://", "ssr://", "hysteria://", "hysteria2://", "hy2://", "tuic://"];
      var lines = String(text || "").replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n").split("\\n").map(function(x) { return x.trim(); });
      var nonEmpty = lines.filter(Boolean);
      var seenExact = new Set();
      var seenContent = new Set();
      var valid = 0, unknown = 0, duplicatesByContent = 0;
      nonEmpty.forEach(function(line) {
        var key = canonicalClientKey(line);
        if (seenContent.has(key)) duplicatesByContent++;
        seenContent.add(key);
        if (seenExact.has(line)) {}
        seenExact.add(line);
        if (schemes.some(function(s) { return line.toLowerCase().startsWith(s); })) valid++; else unknown++;
      });
      return { total: nonEmpty.length, valid: valid, unknown: unknown, duplicatesByContent: duplicatesByContent };
    }

    function canonicalClientKey(line) {
      var value = String(line || "").trim();
      var idx = value.indexOf("#");
      if (idx !== -1) value = value.slice(0, idx);
      try {
        var u = new URL(value);
        u.hash = "";
        u.searchParams.delete("remarks");
        u.searchParams.delete("remark");
        u.searchParams.delete("name");
        u.searchParams.sort();
        return u.toString().replace(/\\/$/, "").toLowerCase();
      } catch (e) { return value.replace(/#.*$/, "").trim().toLowerCase(); }
    }

    function normalizeText(text, dedupe) {
      var seen = new Set();
      var output = [];
      String(text || "").replace(/^\\uFEFF/, "").replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n").split("\\n").map(function(line) { return line.trim(); }).filter(Boolean).forEach(function(line) {
        var key = canonicalClientKey(line);
        if (dedupe && seen.has(key)) return;
        seen.add(key);
        output.push(line);
      });
      return output.join("\\n");
    }

    function updateStats(stats) {
      var s = stats || clientAnalyze($("configsText").value);
      $("statTotal").textContent = s.total || 0;
      $("statValid").textContent = s.valid || 0;
      $("statUnknown").textContent = s.unknown || 0;
      $("statDupContent").textContent = s.duplicatesByContent || 0;
    }

    $("loginForm").addEventListener("submit", async function(e) {
      e.preventDefault();
      var password = $("passwordInput").value.trim();
      if (!password) return toast("رمز عبور را وارد کنید.", "err");
      try { await login(password); } catch (err) { clearPassword(); toast(err.message, "err"); }
    });

    $("logoutBtn").addEventListener("click", function() {
      if (authMode === "telegram" && telegramWebApp) {
        telegramWebApp.close();
        return;
      }
      clearPassword();
      showLogin();
      toast("از پنل خارج شدید.");
    });
    $("refreshBtn").addEventListener("click", function() { refreshState().catch(function(err) { toast(err.message, "err"); }); });

    $("createUserBtn").addEventListener("click", async function() {
      try {
        var name = $("newUserName").value.trim();
        var data = await api("/api/admin/users/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name }) });
        $("newUserName").value = "";
        currentUserId = data.user.id;
        await refreshState();
        switchTab("configsPanel");
        toast(data.message);
      } catch (err) { toast(err.message, "err"); }
    });

    $("selectedUserSelect").addEventListener("change", function() { loadUserConfigs(this.value).catch(function(err) { toast(err.message, "err"); }); });
    $("configsText").addEventListener("input", function() { updateStats(); });

    $("updateUserBtn").addEventListener("click", async function() {
      try {
        var data = await api("/api/admin/users/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: currentUserId, name: $("editUserName").value, enabled: $("editUserEnabled").checked }) });
        await refreshState();
        toast(data.message);
      } catch (err) { toast(err.message, "err"); }
    });

    $("regenTokenBtn").addEventListener("click", async function() {
      if (!confirm("برای این کاربر توکن جدید ساخته شود؟ لینک قبلی از کار می‌افتد.")) return;
      try {
        var data = await api("/api/admin/users/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: currentUserId, regenerateToken: true }) });
        await refreshState();
        toast(data.message);
      } catch (err) { toast(err.message, "err"); }
    });

    $("deleteUserBtn").addEventListener("click", async function() {
      if (!currentUserId) return;
      if (!confirm("این کاربر و کانفیگ‌های او حذف شود؟")) return;
      try {
        var data = await api("/api/admin/users/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: currentUserId }) });
        currentUserId = "";
        await refreshState();
        toast(data.message);
      } catch (err) { toast(err.message, "err"); }
    });

    $("cleanBtn").addEventListener("click", function() { $("configsText").value = normalizeText($("configsText").value, $("dedupeCheck").checked); updateStats(); toast("متن پاک‌سازی شد."); });

    $("saveConfigsBtn").addEventListener("click", async function() {
      try {
        var data = await api("/api/admin/users/configs/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: currentUserId, configs: $("configsText").value, normalize: $("normalizeCheck").checked, dedupe: $("dedupeCheck").checked }) });
        $("configsText").value = data.configs || "";
        updateStats(data.stats);
        await refreshState();
        toast(data.message);
      } catch (err) { toast(err.message, "err"); }
    });

    $("restoreBtn").addEventListener("click", async function() {
      if (!confirm("آخرین بکاپ این کاربر بازیابی شود؟")) return;
      try {
        var data = await api("/api/admin/users/configs/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: currentUserId }) });
        $("configsText").value = data.configs || "";
        updateStats(data.stats);
        toast(data.message);
      } catch (err) { toast(err.message, "err"); }
    });

    $("downloadBtn").addEventListener("click", async function() {
      try {
        var downloadHeaders = {};
        if (authMode === "telegram" && telegramInitData) {
          downloadHeaders["x-telegram-init-data"] = telegramInitData;
        } else {
          downloadHeaders["authorization"] = "Bearer " + getPassword();
        }
        var res = await fetch("/api/admin/download?id=" + encodeURIComponent(currentUserId), { headers: downloadHeaders });
        if (!res.ok) throw new Error("دانلود ناموفق بود.");
        var blob = await res.blob();
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = "configs-" + new Date().toISOString().slice(0, 10) + ".txt";
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      } catch (err) { toast(err.message, "err"); }
    });

    $("copyRawBtn").addEventListener("click", function() { copyText(currentLinks.raw); });
    $("copyBase64Btn").addEventListener("click", function() { copyText(currentLinks.base64); });
    $("openRawBtn").addEventListener("click", function() { if (currentLinks.raw) window.open(currentLinks.raw, "_blank", "noopener,noreferrer"); });

    async function copyText(text) {
      if (!text) return toast("لینکی برای کپی وجود ندارد.", "err");
      await navigator.clipboard.writeText(text);
      toast("کپی شد.");
    }

    $("fileBtn").addEventListener("click", function() { $("fileInput").click(); });
    $("fileInput").addEventListener("change", async function(e) {
      var file = e.target.files && e.target.files[0];
      if (file) await readFileIntoTextarea(file, $("configsText"));
      e.target.value = "";
    });

    async function readFileIntoTextarea(file, textarea) {
      if (file.size > 5 * 1024 * 1024) return toast("حجم فایل بیشتر از ۵ مگابایت است.", "err");
      textarea.value = await file.text();
      updateStats();
      toast("محتوای فایل داخل باکس قرار گرفت.");
    }

    var dropArea = $("dropArea");
    ["dragenter", "dragover"].forEach(function(name) { dropArea.addEventListener(name, function(e) { e.preventDefault(); dropArea.classList.add("drag"); }); });
    ["dragleave", "drop"].forEach(function(name) { dropArea.addEventListener(name, function(e) { e.preventDefault(); dropArea.classList.remove("drag"); }); });
    dropArea.addEventListener("drop", async function(e) { var file = e.dataTransfer.files && e.dataTransfer.files[0]; if (file) await readFileIntoTextarea(file, $("configsText")); });
    dropArea.addEventListener("click", function() { $("fileInput").click(); });

    $("applyBulkBtn").addEventListener("click", async function() {
      try {
        var checked = Array.from(document.querySelectorAll(".bulk-user:checked")).map(function(x) { return x.value; });
        var data = await api("/api/admin/bulk/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: $("bulkTarget").value, userIds: checked, mode: $("bulkMode").value, configs: $("bulkConfigsText").value }) });
        await refreshState();
        toast(data.message);
      } catch (err) { toast(err.message, "err"); }
    });

    $("changePasswordBtn").addEventListener("click", async function() {
      try {
        var currentPassword = $("currentPassword").value;
        var newPassword = $("newPassword").value;
        var data = await api("/api/admin/password/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword: currentPassword, newPassword: newPassword }) });
        setPassword(newPassword);
        $("currentPassword").value = "";
        $("newPassword").value = "";
        await refreshState();
        toast(data.message);
      } catch (err) { toast(err.message, "err"); }
    });

    $("saveTelegramBtn").addEventListener("click", async function() {
      try {
        var data = await api("/api/admin/telegram/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ botToken: $("telegramBotToken").value.trim(), adminChatId: $("telegramAdminId").value.trim(), enabled: $("telegramEnabled").checked }) });
        renderTelegram(data.telegram || {});
        $("telegramBotToken").value = "";
        toast(data.message);
      } catch (err) { toast(err.message, "err"); }
    });

    $("testTelegramBtn").addEventListener("click", async function() {
      try {
        var data = await api("/api/admin/telegram/test", { method: "POST" });
        toast(data.message);
      } catch (err) { toast(err.message, "err"); }
    });

    $("copyMiniAppBtn").addEventListener("click", function() {
      copyText($("telegramMiniApp").textContent);
    });

    function escapeHtml(value) {
      return String(value || "").replace(/[&<>'"]/g, function(char) {
        return {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          "'": "&#39;",
          '"': "&quot;"
        }[char];
      });
    }

    if (typeof window !== "undefined" && typeof window.escapeHtml === "undefined") {
      window.escapeHtml = escapeHtml;
    }

    function delay(ms) {
      return new Promise(function(resolve) {
        setTimeout(resolve, ms);
      });
    }

    (async function boot() {
      if (isTelegramMiniAppPath) {
        for (var i = 0; i < 12 && !telegramInitData; i++) {
          telegramInitData = getTelegramInitData();
          if (!telegramInitData) await delay(150);
        }

        authMode = telegramInitData ? "telegram" : "password";

        if (authMode === "telegram" && telegramInitData) {
          showDashboard();

          try {
            await api("/api/telegram-miniapp/auth-status");
            await refreshState();
            return;
          } catch (e) {
            showMiniAppAuthError(e.message);
            return;
          }
        }

        showMiniAppAuthError("Telegram initData was not received. In BotFather, set the Mini App URL to /tg-app and open it with the blue Open button inside Telegram.");
        return;
      }

      var saved = getPassword();
      if (!saved) return showLogin();
      try { showDashboard(); await refreshState(); } catch (e) { clearPassword(); showLogin(); }
    })();
  </script>
</body>
</html>`;
