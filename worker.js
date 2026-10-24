const USERS_KEY = "users_v2";
const ADMIN_PASSWORD_HASH_KEY = "admin_password_hash_v1";
const ADMIN_PASSWORD_META_KEY = "admin_password_meta_v1";
const TELEGRAM_SETTINGS_KEY = "telegram_settings_v1";
const TELEGRAM_STATE_PREFIX = "telegram_state:";
const TELEGRAM_CONTROL_MESSAGE_PREFIX = "telegram_control_message:";
const MAX_CONFIG_BYTES = 5 * 1024 * 1024;

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

      if (
        (url.pathname === "/admin" || url.pathname === "/admin/") &&
        request.method === "GET"
      ) {
        return htmlResponse(ADMIN_HTML);
      }

      if (
        (url.pathname === "/tg-app" || url.pathname === "/tg-app/") &&
        request.method === "GET"
      ) {
        return htmlResponse(ADMIN_HTML);
      }

      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        if (!(await isAdminAuthorized(request, env))) {
          return jsonResponse(
            { ok: false, error: "رمز عبور نادرست است." },
            401,
          );
        }
        return jsonResponse({ ok: true });
      }

      if (url.pathname === "/api/admin/state" && request.method === "GET") {
        await requireAdmin(request, env);
        const users = await getUsers(env);
        const telegramSettings = await getTelegramSettings(env);
        const adminPasswordHash = await env.CONFIGS_KV.get(
          ADMIN_PASSWORD_HASH_KEY,
        );
        return jsonResponse({
          ok: true,
          users: users.map((user) => publicUser(user, url, env)),
          adminPasswordChanged: Boolean(adminPasswordHash),
          telegram: publicTelegramSettings(telegramSettings, url, env),
        });
      }

      if (
        url.pathname === "/api/telegram-miniapp/auth-status" &&
        request.method === "GET"
      ) {
        assertKvBinding(env);

        const initData = request.headers.get("x-telegram-init-data") || "";
        const settings = await getTelegramSettings(env);

        if (!initData) {
          return jsonResponse(
            {
              ok: false,
              error:
                "Telegram initData was not received. Set BotFather Mini App URL to /tg-app and open it from Telegram.",
            },
            401,
          );
        }

        if (!settings || !settings.botToken) {
          return jsonResponse(
            {
              ok: false,
              error: "Bot token is not saved in the Telegram settings panel.",
            },
            401,
          );
        }

        if (!settings.adminChatId) {
          return jsonResponse(
            {
              ok: false,
              error:
                "Admin Chat ID is not saved in the Telegram settings panel.",
            },
            401,
          );
        }

        const verified = await verifyTelegramWebAppInitData(
          initData,
          settings.botToken,
        );

        if (!verified.ok || !verified.user) {
          return jsonResponse(
            {
              ok: false,
              error:
                "Telegram initData verification failed. Re-save the correct bot token and open the Mini App again from Telegram.",
            },
            401,
          );
        }

        const telegramUserId = String(verified.user.id || "");

        if (
          !constantTimeEqual(telegramUserId, String(settings.adminChatId || ""))
        ) {
          return jsonResponse(
            {
              ok: false,
              error: "Telegram user ID does not match the saved Admin Chat ID.",
              telegramUserId,
              savedAdminChatId: settings.adminChatId,
            },
            401,
          );
        }

        return jsonResponse({ ok: true, telegramUserId });
      }

      if (
        url.pathname === "/api/admin/password/change" &&
        request.method === "POST"
      ) {
        await requireAdmin(request, env);
        const payload = await readJson(request);
        const currentPassword = String(payload.currentPassword || "");
        const newPassword = String(payload.newPassword || "");

        if (!(await passwordMatches(currentPassword, env))) {
          return jsonResponse(
            { ok: false, error: "رمز عبور فعلی نادرست است." },
            401,
          );
        }

        if (newPassword.length < 8) {
          return jsonResponse(
            { ok: false, error: "رمز عبور جدید باید حداقل ۸ کاراکتر باشد." },
            400,
          );
        }

        const hash = await sha256Hex(newPassword);
        const meta = { updatedAt: new Date().toISOString() };
        await env.CONFIGS_KV.put(ADMIN_PASSWORD_HASH_KEY, hash);
        await env.CONFIGS_KV.put(ADMIN_PASSWORD_META_KEY, JSON.stringify(meta));

        return jsonResponse({
          ok: true,
          message: "رمز عبور با موفقیت تغییر کرد.",
        });
      }

      if (
        url.pathname === "/api/admin/users/create" &&
        request.method === "POST"
      ) {
        await requireAdmin(request, env);
        const payload = await readJson(request);
        const name = cleanName(payload.name || "");
        if (!name)
          return jsonResponse(
            { ok: false, error: "نام کاربر را وارد کنید." },
            400,
          );

        const users = await getUsers(env);
        // Read and validate the source before creating any records.
        const sourceConfigs = payload.sourceUserId
          ? await readSourceConfigs(env, users, payload.sourceUserId)
          : null;
        const user = {
          id: generateId(),
          name,
          token: generateToken(),
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastConfigUpdate: null,
        };

        if (sourceConfigs !== null) {
          const saved = await saveConfigsForUser(env, user, sourceConfigs, {
            normalize: false, dedupe: false,
          });
          user.lastConfigUpdate = saved.meta.updatedAt;
          user.updatedAt = saved.meta.updatedAt;
        } else {
          await env.CONFIGS_KV.put(configKey(user.id), "");
        }
        users.push(user);
        await saveUsers(env, users);
        await env.CONFIGS_KV.put(tokenKey(user.token), user.id);

        return jsonResponse({
          ok: true,
          message: "کاربر ایجاد شد.",
          user: publicUser(user, url, env),
        });
      }

      if (
        url.pathname === "/api/admin/users/update" &&
        request.method === "POST"
      ) {
        await requireAdmin(request, env);
        const payload = await readJson(request);
        const users = await getUsers(env);
        const user = users.find((item) => item.id === payload.id);
        if (!user)
          return jsonResponse({ ok: false, error: "کاربر پیدا نشد." }, 404);

        if (typeof payload.name === "string") {
          const name = cleanName(payload.name);
          if (!name)
            return jsonResponse(
              { ok: false, error: "نام کاربر نمی‌تواند خالی باشد." },
              400,
            );
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
        return jsonResponse({
          ok: true,
          message: "اطلاعات کاربر ذخیره شد.",
          user: publicUser(user, url, env),
        });
      }

      if (
        url.pathname === "/api/admin/users/delete" &&
        request.method === "POST"
      ) {
        await requireAdmin(request, env);
        const payload = await readJson(request);
        const users = await getUsers(env);
        const index = users.findIndex((item) => item.id === payload.id);
        if (index === -1)
          return jsonResponse({ ok: false, error: "کاربر پیدا نشد." }, 404);

        const [removed] = users.splice(index, 1);
        await saveUsers(env, users);
        await env.CONFIGS_KV.delete(tokenKey(removed.token));
        await env.CONFIGS_KV.delete(configKey(removed.id));
        await env.CONFIGS_KV.delete(backupConfigKey(removed.id));
        await env.CONFIGS_KV.delete(metaKey(removed.id));
        await env.CONFIGS_KV.delete(backupMetaKey(removed.id));

        return jsonResponse({ ok: true, message: "کاربر حذف شد." });
      }

      if (
        url.pathname === "/api/admin/users/configs" &&
        request.method === "GET"
      ) {
        await requireAdmin(request, env);
        const userId = url.searchParams.get("id") || "";
        const user = await getUserById(env, userId);
        if (!user)
          return jsonResponse({ ok: false, error: "کاربر پیدا نشد." }, 404);

        const configs = (await env.CONFIGS_KV.get(configKey(user.id))) || "";
        const meta = await getJson(env, metaKey(user.id), {});
        const backupMeta = await getJson(env, backupMetaKey(user.id), {});
        const backupExists = Boolean(
          await env.CONFIGS_KV.get(backupConfigKey(user.id)),
        );

        return jsonResponse({
          ok: true,
          user: publicUser(user, url, env),
          configs,
          meta,
          backupMeta,
          backupExists,
          stats: analyzeConfigs(configs),
        });
      }

      if (
        url.pathname === "/api/admin/users/configs/save" &&
        request.method === "POST"
      ) {
        await requireAdmin(request, env);
        const payload = await readJson(request);
        const users = await getUsers(env);
        const user = users.find((item) => item.id === payload.id);
        if (!user)
          return jsonResponse({ ok: false, error: "کاربر پیدا نشد." }, 404);

        const result = await saveConfigsForUser(
          env,
          user,
          String(payload.configs || ""),
          {
            normalize: payload.normalize !== false,
            dedupe: payload.dedupe !== false,
          },
        );

        user.lastConfigUpdate = result.meta.updatedAt;
        user.updatedAt = result.meta.updatedAt;
        await saveUsers(env, users);

        return jsonResponse({
          ok: true,
          message: "کانفیگ‌های کاربر ذخیره شد.",
          user: publicUser(user, url, env),
          configs: result.configs,
          meta: result.meta,
          stats: result.stats,
        });
      }

      if (
        url.pathname === "/api/admin/users/configs/copy" &&
        request.method === "POST"
      ) {
        await requireAdmin(request, env);
        const payload = await readJson(request);
        const users = await getUsers(env);
        const user = users.find((item) => item.id === payload.id);
        if (!user) return jsonResponse({ ok: false, error: "کاربر پیدا نشد." }, 404);
        if (payload.sourceUserId === user.id) {
          return jsonResponse({ ok: false, error: "کاربر منبع باید متفاوت باشد." }, 400);
        }
        const configs = await readSourceConfigs(env, users, payload.sourceUserId);
        const saved = await saveConfigsForUser(env, user, configs, {
          normalize: false, dedupe: false,
        });
        user.lastConfigUpdate = saved.meta.updatedAt;
        user.updatedAt = saved.meta.updatedAt;
        await saveUsers(env, users);
        return jsonResponse({
          ok: true, message: "کانفیگ‌ها از کاربر منبع کپی شدند.",
          user: publicUser(user, url, env), ...saved,
        });
      }

      if (
        url.pathname === "/api/admin/users/configs/restore" &&
        request.method === "POST"
      ) {
        await requireAdmin(request, env);
        const payload = await readJson(request);
        const users = await getUsers(env);
        const user = users.find((item) => item.id === payload.id);
        if (!user)
          return jsonResponse({ ok: false, error: "کاربر پیدا نشد." }, 404);

        const backup = await env.CONFIGS_KV.get(backupConfigKey(user.id));
        if (!backup || !backup.trim()) {
          return jsonResponse(
            { ok: false, error: "برای این کاربر بکاپی وجود ندارد." },
            404,
          );
        }

        const result = await saveConfigsForUser(env, user, backup, {
          normalize: true,
          dedupe: true,
        });
        user.lastConfigUpdate = result.meta.updatedAt;
        user.updatedAt = result.meta.updatedAt;
        await saveUsers(env, users);

        return jsonResponse({
          ok: true,
          message: "آخرین بکاپ این کاربر بازیابی شد.",
          user: publicUser(user, url, env),
          configs: result.configs,
          meta: result.meta,
          stats: result.stats,
        });
      }

      if (
        url.pathname === "/api/admin/bulk/apply" &&
        request.method === "POST"
      ) {
        await requireAdmin(request, env);
        const payload = await readJson(request);
        const users = await getUsers(env);
        const mode = payload.mode === "append" ? "append" : "replace";
        const targetIds =
          payload.target === "all"
            ? users.map((user) => user.id)
            : arrayOfStrings(payload.userIds);
        const selectedUsers = users.filter((user) =>
          targetIds.includes(user.id),
        );

        if (!selectedUsers.length) {
          return jsonResponse(
            { ok: false, error: "حداقل یک کاربر را انتخاب کنید." },
            400,
          );
        }

        let inputConfigs = String(payload.configs || "");

        if (payload.sourceUserId) {
          const sourceUser = users.find((u) => u.id === payload.sourceUserId);
          if (!sourceUser) {
            return jsonResponse(
              { ok: false, error: "کاربر منبع یافت نشد." },
              400,
            );
          }
          inputConfigs =
            (await env.CONFIGS_KV.get(configKey(sourceUser.id))) || "";
        }

        inputConfigs = normalizeAndDedupeConfigs(inputConfigs).text;
        if (!inputConfigs.trim()) {
          return jsonResponse(
            {
              ok: false,
              error: payload.sourceUserId
                ? "کاربر منبع فاقد کانفیگ است."
                : "کانفیگ قابل اعمال وارد نشده است.",
            },
            400,
          );
        }

        const updatedAt = new Date().toISOString();
        const results = [];

        for (const user of selectedUsers) {
          const current = (await env.CONFIGS_KV.get(configKey(user.id))) || "";
          const nextText =
            mode === "append" ? current + "\n" + inputConfigs : inputConfigs;
          const saved = await saveConfigsForUser(env, user, nextText, {
            normalize: true,
            dedupe: true,
          });
          user.lastConfigUpdate = saved.meta.updatedAt;
          user.updatedAt = saved.meta.updatedAt;
          results.push({ id: user.id, name: user.name, stats: saved.stats });
        }

        await saveUsers(env, users);

        return jsonResponse({
          ok: true,
          message: "کانفیگ‌ها برای کاربران انتخاب‌شده اعمال شد.",
          updatedAt,
          users: users.map((user) => publicUser(user, url, env)),
          results,
        });
      }

      if (url.pathname === "/api/admin/download" && request.method === "GET") {
        await requireAdmin(request, env);
        const userId = url.searchParams.get("id") || "";
        const user = await getUserById(env, userId);
        if (!user)
          return new Response("User not found", {
            status: 404,
            headers: securityHeaders(),
          });
        const configs = (await env.CONFIGS_KV.get(configKey(user.id))) || "";
        return new Response(configs, {
          status: 200,
          headers: {
            ...securityHeaders(),
            "content-type": "text/plain; charset=utf-8",
            "content-disposition":
              'attachment; filename="configs-' +
              safeFilename(user.name) +
              "-" +
              dateStamp() +
              '.txt"',
          },
        });
      }

      if (
        url.pathname === "/api/admin/telegram/save" &&
        request.method === "POST"
      ) {
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
          return jsonResponse(
            { ok: false, error: "توکن بات و شناسه عددی ادمین را وارد کنید." },
            400,
          );
        }

        await env.CONFIGS_KV.put(
          TELEGRAM_SETTINGS_KEY,
          JSON.stringify(settings),
        );

        let webhookResult = null;
        if (settings.enabled) {
          const bot = await getTelegramBot(env, settings);
          webhookResult = await bot.configureTelegramEntryPoints(
            settings,
            url.origin,
          );
        }

        return jsonResponse({
          ok: true,
          message: settings.enabled
            ? "تنظیمات تلگرام ذخیره و وبهوک فعال شد."
            : "تنظیمات تلگرام ذخیره شد.",
          telegram: publicTelegramSettings(settings, url, env),
          webhookResult,
        });
      }

      if (
        url.pathname === "/api/admin/telegram/test" &&
        request.method === "POST"
      ) {
        await requireAdmin(request, env);
        const settings = await getTelegramSettings(env);
        if (!settings.enabled || !settings.botToken || !settings.adminChatId) {
          return jsonResponse(
            { ok: false, error: "تنظیمات تلگرام کامل یا فعال نیست." },
            400,
          );
        }
        const bot = await getTelegramBot(env, settings);
        const sent = await bot.sendTest(settings, url.origin);
        return jsonResponse({
          ok: true,
          message: "پیام تست ارسال شد.",
          telegramResult: sent,
        });
      }

      if (
        url.pathname.startsWith("/telegram/webhook/") &&
        request.method === "POST"
      ) {
        const secret = decodeURIComponent(
          url.pathname.slice("/telegram/webhook/".length),
        );
        const settings = await getTelegramSettings(env);
        if (
          !settings.enabled ||
          !settings.webhookSecret ||
          !constantTimeEqual(secret, settings.webhookSecret)
        ) {
          return new Response("Not found", {
            status: 404,
            headers: securityHeaders(),
          });
        }
        const update = await readJson(request);
        const bot = await getTelegramBot(env, settings);
        await bot.handleTelegramUpdate(update, env, settings, url.origin);
        return jsonResponse({ ok: true });
      }

      if (url.pathname.startsWith("/sub/") && request.method === "GET") {
        const token = decodeURIComponent(
          url.pathname.slice("/sub/".length).split("/")[0] || "",
        );
        const userId = await env.CONFIGS_KV.get(tokenKey(token));
        if (!userId)
          return new Response("Not found", {
            status: 404,
            headers: securityHeaders(),
          });

        const user = await getUserById(env, userId);
        if (!user || !user.enabled || !constantTimeEqual(token, user.token)) {
          return new Response("Not found", {
            status: 404,
            headers: securityHeaders(),
          });
        }

        const configs = (await env.CONFIGS_KV.get(configKey(user.id))) || "";
        const clean = normalizeAndDedupeConfigs(configs).text;
        if (!clean.trim()) {
          return new Response("No configs found", {
            status: 404,
            headers: {
              ...securityHeaders(),
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "no-store",
            },
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
            "subscription-userinfo":
              "upload=0; download=0; total=107374182400; expire=4102444800",
          },
        });
      }

      return new Response("Not found", {
        status: 404,
        headers: securityHeaders(),
      });
    } catch (error) {
      const status = Number(error && error.status) || 500;

      if (status === 401) {
        return jsonResponse({ ok: false, error: "دسترسی غیرمجاز است." }, 401);
      }

      if (error && error.expose === true) {
        return jsonResponse(
          { ok: false, error: String(error.message || error) },
          status,
        );
      }

      return jsonResponse(
        {
          ok: false,
          error: "خطای داخلی Worker",
          details: String(error && error.message ? error.message : error),
        },
        500,
      );
    }
  },
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

  const verified = await verifyTelegramWebAppInitData(
    initData,
    settings.botToken,
  );
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
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(String(message)),
  );

  return new Uint8Array(signature);
}

async function hmacSHA256Hex(key, message) {
  const raw = await hmacSHA256Raw(key, message);
  return Array.from(raw)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function passwordMatches(password, env) {
  assertKvBinding(env);

  password = normalizePassword(password);

  const storedHash = await env.CONFIGS_KV.get(ADMIN_PASSWORD_HASH_KEY);

  if (storedHash) {
    return constantTimeEqual(await sha256Hex(password), storedHash);
  }

  const initialPassword = normalizePassword(env.ADMIN_PASSWORD || "");
  if (initialPassword.length >= 8 && constantTimeEqual(password, initialPassword)) {
    await env.CONFIGS_KV.put(
      ADMIN_PASSWORD_HASH_KEY,
      await sha256Hex(initialPassword),
    );
    await env.CONFIGS_KV.put(
      ADMIN_PASSWORD_META_KEY,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        source: "bootstrap-secret",
      }),
    );

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
    const error = new Error(
      "KV Binding named CONFIGS_KV is not connected to this Worker.",
    );
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
  return users.find((user) => user.id === id) || null;
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
      base64: base + "/sub/" + token + "?format=base64",
    },
  };
}

async function readSourceConfigs(env, users, sourceUserId) {
  const source = users.find((user) => user.id === sourceUserId);
  let message = "";
  let configs = "";
  if (!source) message = "کاربر منبع یافت نشد.";
  else {
    configs = (await env.CONFIGS_KV.get(configKey(source.id))) || "";
    if (!configs.trim()) message = "کاربر منبع فاقد کانفیگ است.";
    else if (new TextEncoder().encode(configs).length > MAX_CONFIG_BYTES)
      message = "حجم کانفیگ‌ها برای این پنل بیش از ۵ مگابایت است.";
  }
  if (message) {
    const error = new Error(message);
    error.status = 400;
    error.expose = true;
    throw error;
  }
  return configs;
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
    if (oldMeta)
      await env.CONFIGS_KV.put(backupMetaKey(user.id), JSON.stringify(oldMeta));
  }

  const stats = analyzeConfigs(configs);
  const meta = {
    updatedAt: new Date().toISOString(),
    byteSize,
    sha256: await sha256Hex(configs),
    count: stats.total,
    validCount: stats.valid,
    unknownCount: stats.unknown,
    duplicatesRemovedByContent: stats.duplicatesByContent,
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
    .map((line) => line.trim())
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
  const schemes = [
    "vless://",
    "vmess://",
    "trojan://",
    "ss://",
    "ssr://",
    "hysteria://",
    "hysteria2://",
    "hy2://",
    "tuic://",
  ];
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
  const clean = lines.map((line) => line.trim());
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

    const scheme = schemes.find((item) => line.toLowerCase().startsWith(item));
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
    byType,
  };
}

async function getTelegramSettings(env) {
  return await getJson(env, TELEGRAM_SETTINGS_KEY, {
    enabled: false,
    botToken: "",
    adminChatId: "",
    webhookSecret: "",
    updatedAt: null,
  });
}

function publicTelegramSettings(settings, url, env) {
  const base = (
    env && env.PUBLIC_BASE_URL ? env.PUBLIC_BASE_URL : url.origin
  ).replace(/\/$/, "");
  const miniAppUrl = base + "/tg-app";

  return {
    enabled: settings.enabled === true,
    adminChatId: settings.adminChatId || "",
    botTokenSaved: Boolean(settings.botToken),
    botTokenPreview: settings.botToken ? maskToken(settings.botToken) : "",
    webhookUrl: settings.webhookSecret
      ? base + "/telegram/webhook/" + encodeURIComponent(settings.webhookSecret)
      : "",
    miniAppUrl,
    updatedAt: settings.updatedAt || null,
  };
}

function telegramLanguageKey(chatId) {
  return "telegram_language:" + String(chatId);
}

async function getTelegramBot(env, settings) {
  const language = await env.CONFIGS_KV.get(telegramLanguageKey(settings.adminChatId));
  return createTelegramBot(language === "en" ? "en" : "fa");
}

// Each webhook gets its own language closure, including its keyboards and command handlers.
function createTelegramBot(language) {

  function t(fa, en) { return language === "en" ? en : fa; }

  function telegramLanguageKeyboard() {
    return { inline_keyboard: [[
      { text: (language === "fa" ? "✅ " : "") + "فارسی", callback_data: "tg:language:fa" },
      { text: (language === "en" ? "✅ " : "") + "English", callback_data: "tg:language:en" },
    ]] };
  }

  async function changeLanguage(selected, env, settings, chatId, origin) {
    language = selected;
    await env.CONFIGS_KV.put(telegramLanguageKey(settings.adminChatId), language);
    await setTelegramCommands(settings);
    await telegramSend(settings.botToken, chatId,
      t("زبان ربات به فارسی تغییر کرد.", "Bot language changed to English."),
      telegramReplyKeyboard(origin));
  }

  async function sendTest(settings, origin) {
    return telegramSend(settings.botToken, settings.adminChatId,
      t("اتصال ربات تلگرام با موفقیت برقرار شد. از دکمه‌های زیر می‌توانید استفاده کنید.",
        "Telegram bot connected successfully. Use the buttons below."),
      telegramReplyKeyboard(origin));
  }

  async function handleTelegramUpdate(update, env, settings, origin) {
    try {
      return await processTelegramUpdate(update, env, settings, origin);
    } catch (error) {
      const message = update.message || update.edited_message || (update.callback_query && update.callback_query.message);
      const chatId = message && message.chat ? String(message.chat.id) : "";
      if (chatId !== String(settings.adminChatId)) throw error;
      const errors = {
        "لیست کانفیگ خالی است.": t("لیست کانفیگ خالی است.", "The config list is empty."),
        "حجم کانفیگ‌ها برای این پنل بیش از ۵ مگابایت است.": t("حجم کانفیگ‌ها برای این پنل بیش از ۵ مگابایت است.", "Configs exceed the panel's 5 MB limit."),
        "فایل معتبر نیست.": t("فایل معتبر نیست.", "Invalid file."),
        "حجم فایل بیشتر از ۵ مگابایت است.": t("حجم فایل بیشتر از ۵ مگابایت است.", "The file is larger than 5 MB."),
        "دریافت فایل از تلگرام ناموفق بود.": t("دریافت فایل از تلگرام ناموفق بود.", "Failed to retrieve the file from Telegram."),
        "دانلود فایل از تلگرام ناموفق بود.": t("دانلود فایل از تلگرام ناموفق بود.", "Failed to download the file from Telegram."),
      };
      const known = errors[error.message];
      // Network/unknown failures must remain retryable by Telegram.
      if (!known && ![400, 413, 502].includes(error.status)) throw error;
      return telegramSend(settings.botToken, chatId,
        known || error.message, telegramInlineKeyboard(origin));
    }
  }

  async function configureTelegramEntryPoints(settings, origin) {
    const webhook = await setTelegramWebhook(settings, origin);
    const commands = await setTelegramCommands(settings);

    if (settings.botToken && settings.adminChatId) {
      await telegramSend(
        settings.botToken,
        settings.adminChatId,
        telegramStartText(settings.adminChatId),
        telegramReplyKeyboard(origin),
      );
    }

    return { webhook, commands };
  }

  async function setTelegramWebhook(settings, origin) {
    const webhookUrl =
      origin.replace(/\/$/, "") +
      "/telegram/webhook/" +
      encodeURIComponent(settings.webhookSecret);
    const response = await fetch(
      "https://api.telegram.org/bot" + settings.botToken + "/setWebhook",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: webhookUrl, drop_pending_updates: true }),
      },
    );
    return await response
      .json()
      .catch(() => ({ ok: false, description: t("پاسخ تلگرام نامعتبر بود.", "Invalid Telegram response.") }));
  }

  async function setTelegramMenuButton(settings, origin) {
    const miniAppUrl = origin.replace(/\/$/, "") + "/tg-app";
    const response = await fetch(
      "https://api.telegram.org/bot" + settings.botToken + "/setChatMenuButton",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: settings.adminChatId,
          menu_button: {
            type: "web_app",
            text: t("پنل مدیریت", "Admin panel"),
            web_app: { url: miniAppUrl },
          },
        }),
      },
    );
    return await response
      .json()
      .catch(() => ({ ok: false, description: t("پاسخ تلگرام نامعتبر بود.", "Invalid Telegram response.") }));
  }

  async function setTelegramCommands(settings) {
    const commands = [
      { command: "language", description: t("تغییر زبان فارسی / انگلیسی", "Change language: Persian / English") },
      { command: "start", description: t("شروع و نمایش منوی اصلی", "Start and show main menu") },
      { command: "id", description: t("نمایش شناسه عددی تلگرام ادمین", "Show the admin's numeric Telegram ID") },
      { command: "users", description: t("نمایش و مدیریت کاربران", "View and manage users") },
      { command: "newuser", description: t("ایجاد کاربر جدید", "Create a new user") },
      { command: "bulk", description: t("اعمال گروهی کانفیگ", "Bulk config update") },
      { command: "file", description: t("راهنمای ارسال کانفیگ با فایل", "Help with uploading config files") },
      { command: "commands", description: t("نمایش لیست کامل دستورها", "Show all commands") },
      { command: "help", description: t("راهنمای کامل ربات", "Bot help") },
      { command: "cancel", description: t("لغو عملیات جاری", "Cancel the current operation") },
      { command: "setconfigs", description: t("جایگزینی کانفیگ یک کاربر", "Replace a user's configs") },
      { command: "appendconfigs", description: t("افزودن کانفیگ به یک کاربر", "Append configs to a user") },
      { command: "apply_all", description: t("جایگزینی کانفیگ همه کاربران", "Replace all users' configs") },
      { command: "append_all", description: t("افزودن کانفیگ به همه کاربران", "Append configs to all users") },
      { command: "apply_users", description: t("جایگزینی کانفیگ چند کاربر", "Replace selected users' configs") },
      { command: "append_users", description: t("افزودن کانفیگ چند کاربر", "Append configs to selected users") },
      { command: "password", description: t("تغییر رمز عبور پنل", "Change panel password") },
      { command: "webhook", description: t("تنظیم مجدد وبهوک و دستورها", "Reset webhook and commands") },
    ];

    const scopes = [{ type: "default" }, { type: "all_private_chats" }];

    if (settings.adminChatId) {
      scopes.push({
        type: "chat",
        chat_id: Number(settings.adminChatId) || settings.adminChatId,
      });
    }

    const results = [];
    for (const scope of scopes) {
      const response = await fetch(
        "https://api.telegram.org/bot" + settings.botToken + "/setMyCommands",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commands, scope }),
        },
      );
      results.push(
        await response
          .json()
          .catch(() => ({ ok: false, description: t("پاسخ تلگرام نامعتبر بود.", "Invalid Telegram response.") })),
      );
    }

    return results;
  }

  async function telegramSend(botToken, chatId, text, replyMarkup = null) {
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };

    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    const response = await fetch(
      "https://api.telegram.org/bot" + botToken + "/sendMessage",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    return await response.json().catch(() => ({ ok: false }));
  }

  async function telegramEditMessage(
    botToken,
    chatId,
    messageId,
    text,
    replyMarkup = null,
  ) {
    if (!messageId) {
      return telegramSend(botToken, chatId, text, replyMarkup);
    }

    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };

    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    const response = await fetch(
      "https://api.telegram.org/bot" + botToken + "/editMessageText",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );

    const result = await response.json().catch(() => ({ ok: false }));

    if (
      !result.ok &&
      String(result.description || "").includes("message is not modified")
    ) {
      return { ok: true, unchanged: true };
    }

    return result;
  }

  async function telegramEditCallbackMessage(
    callbackQuery,
    settings,
    chatId,
    text,
    replyMarkup = null,
  ) {
    const messageId =
      callbackQuery && callbackQuery.message
        ? callbackQuery.message.message_id
        : null;
    const result = await telegramEditMessage(
      settings.botToken,
      chatId,
      messageId,
      text,
      replyMarkup,
    );

    if (!result || result.ok !== true) {
      return telegramSend(settings.botToken, chatId, text, replyMarkup);
    }

    return result;
  }

  async function telegramStateReply(
    botToken,
    chatId,
    state,
    text,
    replyMarkup = null,
  ) {
    if (state && state.messageId) {
      const result = await telegramEditMessage(
        botToken,
        chatId,
        state.messageId,
        text,
        replyMarkup,
      );
      if (result && result.ok === true) return result;
    }
    return telegramSend(botToken, chatId, text, replyMarkup);
  }

  async function telegramAnswerCallback(botToken, callbackQueryId, text = "") {
    const response = await fetch(
      "https://api.telegram.org/bot" + botToken + "/answerCallbackQuery",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
      },
    );
    return await response.json().catch(() => ({ ok: false }));
  }

  function telegramReplyKeyboard(origin) {
    return {
      keyboard: [
        [{ text: t("👥 کاربران", "👥 Users") }, { text: t("➕ افزودن کاربر", "➕ Add user") }],
        [{ text: t("📦 اعمال گروهی", "📦 Bulk update") }, { text: t("📄 ارسال فایل", "📄 Upload file") }],
        [{ text: t("🔐 تغییر رمز", "🔐 Change password") }, { text: t("📋 لیست دستورات", "📋 Command list") }],
        [{ text: t("❓ راهنما", "❓ Help") }, { text: t("❌ لغو", "❌ Cancel") }],
        [{ text: "🌐 زبان / Language" }],
      ],
      resize_keyboard: true,
      is_persistent: false,
    };
  }

  function telegramInlineKeyboard(origin) {
    return {
      inline_keyboard: [
        [
          { text: t("👥 مدیریت کاربران", "👥 Manage users"), callback_data: "tg:users" },
          { text: t("➕ افزودن کاربر", "➕ Add user"), callback_data: "tg:create_user" },
        ],
        [
          { text: t("📦 اعمال گروهی", "📦 Bulk update"), callback_data: "tg:bulk_menu" },
          { text: t("🔐 تغییر رمز", "🔐 Change password"), callback_data: "tg:password" },
        ],
        [
          { text: t("📄 ارسال فایل", "📄 Upload file"), callback_data: "tg:file_help" },
          { text: t("📋 دستورات", "📋 Commands"), callback_data: "tg:commands" },
        ],
        [{ text: t("❓ راهنما", "❓ Help"), callback_data: "tg:help" }],
        [{ text: "🌐 زبان / Language", callback_data: "tg:language" }],
      ],
    };
  }

  function telegramUsersKeyboard(users) {
    const rows = users.slice(0, 30).map((user) => [
      {
        text: (user.enabled !== false ? "🟢 " : "🔴 ") + user.name,
        callback_data: "tg:user:" + user.id,
      },
    ]);
    rows.push([{ text: t("➕ افزودن کاربر", "➕ Add user"), callback_data: "tg:create_user" }]);
    rows.push([{ text: t("بازگشت", "Back"), callback_data: "tg:home" }]);
    return { inline_keyboard: rows };
  }

  function telegramUserActionsKeyboard(user, origin) {
    return {
      inline_keyboard: [
        [
          {
            text: t("🔗 لینک‌های کانفیگ", "🔗 Config links"),
            callback_data: "tg:user_links:" + user.id,
          },
        ],
        [
          { text: t("📝 جایگزینی کانفیگ", "📝 Replace configs"), callback_data: "tg:user_set:" + user.id },
          {
            text: t("➕ افزودن کانفیگ", "➕ Append configs"),
            callback_data: "tg:user_append:" + user.id,
          },
        ],
        [
          {
            text: t("📊 خلاصه کانفیگ", "📊 Config summary"),
            callback_data: "tg:user_summary:" + user.id,
          },
          { text: t("✏️ تغییر نام", "✏️ Rename"), callback_data: "tg:user_rename:" + user.id },
        ],
        [
          {
            text: user.enabled !== false ? t("🔴 غیرفعال‌سازی", "🔴 Disable") : t("🟢 فعال‌سازی", "🟢 Enable"),
            callback_data: "tg:user_toggle:" + user.id,
          },
          {
            text: t("♻️ توکن جدید", "♻️ New token"),
            callback_data: "tg:user_regen_confirm:" + user.id,
          },
        ],
        [
          { text: t("🗑 حذف", "🗑 Delete"), callback_data: "tg:user_delete_confirm:" + user.id },
          { text: t("👥 کاربران", "👥 Users"), callback_data: "tg:users" },
        ],
      ],
    };
  }

  function telegramConfirmKeyboard(action, id, backData = "tg:users") {
    return {
      inline_keyboard: [
        [
          { text: t("✅ تأیید", "✅ Confirm"), callback_data: action + ":" + id },
          { text: t("انصراف", "Cancel"), callback_data: backData },
        ],
      ],
    };
  }

  function telegramBulkModeKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: t("جایگزینی برای همه", "Replace for all"), callback_data: "tg:bulk_all:replace" },
          { text: t("افزودن برای همه", "Append for all"), callback_data: "tg:bulk_all:append" },
        ],
        [
          {
            text: t("انتخاب کاربران برای جایگزینی", "Select users to replace"),
            callback_data: "tg:bulk_select:replace",
          },
          {
            text: t("انتخاب کاربران برای افزودن", "Select users to append"),
            callback_data: "tg:bulk_select:append",
          },
        ],
        [{ text: t("بازگشت", "Back"), callback_data: "tg:home" }],
      ],
    };
  }

  function telegramBulkSelectKeyboard(users, selectedIds = []) {
    const selected = new Set(selectedIds);
    const rows = users.slice(0, 30).map((user) => [
      {
        text: (selected.has(user.id) ? "✅ " : "✖️ ") + user.name,
        callback_data: "tg:bulk_toggle:" + user.id,
      },
    ]);
    rows.push([
      {
        text: t("ادامه و ارسال کانفیگ", "Continue and send configs"),
        callback_data: "tg:bulk_selected_continue",
      },
    ]);
    rows.push([{ text: t("انصراف", "Cancel"), callback_data: "tg:bulk_menu" }]);
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
      await env.CONFIGS_KV.put(
        telegramControlMessageKey(chatId),
        String(messageId),
        { expirationTtl: 172800 },
      );
    }
  }

  async function telegramControlMessage(
    botToken,
    chatId,
    text,
    replyMarkup,
    env,
  ) {
    const oldMessageId = env
      ? await getTelegramControlMessageId(env, chatId)
      : null;

    if (oldMessageId) {
      const edited = await telegramEditMessage(
        botToken,
        chatId,
        oldMessageId,
        text,
        replyMarkup,
      );
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

  async function processTelegramUpdate(update, env, settings, origin) {
    if (update.callback_query) {
      await handleTelegramCallback(update.callback_query, env, settings, origin);
      return;
    }

    const message = update.message || update.edited_message || null;
    if (!message || !message.chat) return;

    const chatId = String(message.chat.id);
    if (!constantTimeEqual(chatId, String(settings.adminChatId || ""))) {
      if (settings.botToken) {
        await telegramSend(settings.botToken, chatId, t("دسترسی شما مجاز نیست.", "Access denied."));
      }
      return;
    }

    const state = await getTelegramState(env, chatId);

    if (message.document) {
      const caption = normalizeTelegramText(String(message.caption || "").trim());
      const reply = await handleTelegramConfigDocument(
        message.document,
        caption,
        state,
        chatId,
        env,
        settings,
        origin,
      );
      await telegramStateReply(
        settings.botToken,
        chatId,
        state,
        reply,
        telegramInlineKeyboard(origin),
      );
      return;
    }

    if (typeof message.text !== "string") {
      await telegramSend(
        settings.botToken,
        chatId,
        t("این پیام قابل پردازش نیست. برای ارسال کانفیگ با فایل، دکمه «📄 ارسال فایل» را بزنید.", "This message cannot be processed. To send a config file, use the Upload file button."),
        telegramReplyKeyboard(origin),
      );
      return;
    }

    const text = normalizeTelegramText(message.text.trim());

    if (/^\/language(?:\s+(?:fa|en))?$/.test(text)) {
      const selected = text.split(/\s+/)[1];
      if (selected) await changeLanguage(selected, env, settings, chatId, origin);
      else await telegramSend(settings.botToken, chatId,
        "زبان ربات را انتخاب کنید / Choose the bot language:", telegramLanguageKeyboard());
      return;
    }

    if (text === "/cancel") {
      const activeState = await getTelegramState(env, chatId);
      await clearTelegramState(env, chatId);
      await telegramStateReply(
        settings.botToken,
        chatId,
        activeState,
        t("عملیات جاری لغو شد.", "Current operation cancelled."),
        telegramInlineKeyboard(origin),
      );
      return;
    }

    if (state && !text.startsWith("/")) {
      const reply = await handleTelegramStateInput(
        text,
        state,
        chatId,
        env,
        settings,
        origin,
      );
      await telegramStateReply(
        settings.botToken,
        chatId,
        state,
        reply,
        telegramInlineKeyboard(origin),
      );
      return;
    }

    if (text === "/users") {
      const users = await getUsers(env);
      await telegramControlMessage(
        settings.botToken,
        chatId,
        users.length
          ? t("کاربر مورد نظر را انتخاب کنید:", "Select a user:")
          : t("هنوز کاربری ایجاد نشده است.", "No users have been created yet."),
        users.length
          ? telegramUsersKeyboard(users)
          : telegramInlineKeyboard(origin),
        env,
      );
      return;
    }

    if (text === "/bulk") {
      await telegramControlMessage(
        settings.botToken,
        chatId,
        t("نوع اعمال گروهی را انتخاب کنید:", "Choose a bulk update mode:"),
        telegramBulkModeKeyboard(),
        env,
      );
      return;
    }

    if (text === "/newuser") {
      await setTelegramState(env, chatId, { action: "create_user" });
      const sentNewUser = await telegramControlMessage(
        settings.botToken,
        chatId,
        t("نام کاربر جدید را ارسال کنید.\nبرای لغو، /cancel را بزنید.", "Send the new user's name.\nUse /cancel to cancel."),
        telegramInlineKeyboard(origin),
        env,
      );
      if (sentNewUser && sentNewUser.result && sentNewUser.result.message_id)
        await setTelegramState(env, chatId, {
          action: "create_user",
          messageId: sentNewUser.result.message_id,
        });
      return;
    }

    if (text === "/password_change") {
      await setTelegramState(env, chatId, { action: "change_password" });
      const sentPass = await telegramControlMessage(
        settings.botToken,
        chatId,
        t("رمز عبور جدید پنل را ارسال کنید. حداقل ۸ کاراکتر.\nبرای لغو، /cancel را بزنید.", "Send the new panel password (at least 8 characters).\nUse /cancel to cancel."),
        telegramInlineKeyboard(origin),
        env,
      );
      if (sentPass && sentPass.result && sentPass.result.message_id)
        await setTelegramState(env, chatId, {
          action: "change_password",
          messageId: sentPass.result.message_id,
        });
      return;
    }

    const reply = await runTelegramCommand(text, env, origin, settings);
    const markup = shouldShowTelegramInlineKeyboard(text)
      ? telegramInlineKeyboard(origin)
      : telegramReplyKeyboard(origin);

    if (text === "/start") {
      const sentStart = await telegramSend(
        settings.botToken,
        chatId,
        reply,
        telegramInlineKeyboard(origin),
      );
      if (
        sentStart &&
        sentStart.ok &&
        sentStart.result &&
        sentStart.result.message_id
      ) {
        await setTelegramControlMessageId(
          env,
          chatId,
          sentStart.result.message_id,
        );
      }
      return;
    }

    await telegramControlMessage(
      settings.botToken,
      chatId,
      reply,
      markup.inline_keyboard ? markup : telegramInlineKeyboard(origin),
      env,
    );
  }

  async function handleTelegramConfigDocument(
    document,
    caption,
    state,
    chatId,
    env,
    settings,
    origin,
  ) {
    const fileText = await telegramDownloadDocumentText(
      settings.botToken,
      document,
    );
    if (!fileText.trim()) {
      return t("فایل ارسال‌شده خالی است یا متن قابل خواندن ندارد.", "The uploaded file is empty or contains no readable text.");
    }

    if (
      state &&
      ["set_configs", "append_configs", "bulk_configs"].includes(state.action)
    ) {
      return await handleTelegramStateInput(
        fileText,
        state,
        chatId,
        env,
        settings,
        origin,
        true,
      );
    }

    const commandLine = String(caption || "")
      .split("\n")[0]
      .trim();
    const command = (commandLine.split(/\s+/)[0] || "").toLowerCase();
    const allowed = new Set([
      "/setconfigs",
      "/appendconfigs",
      "/apply_all",
      "/append_all",
      "/apply_users",
      "/append_users",
    ]);

    if (!allowed.has(command)) {
      return telegramFileHelpText();
    }

    return await runTelegramCommand(
      commandLine + "\n" + fileText,
      env,
      origin,
      settings,
    );
  }

  async function telegramDownloadDocumentText(botToken, document) {
    if (!document || !document.file_id) {
      const error = new Error(t("فایل معتبر نیست.", "Invalid file."));
      error.status = 400;
      throw error;
    }

    if (document.file_size && document.file_size > MAX_CONFIG_BYTES) {
      const error = new Error(t("حجم فایل بیشتر از ۵ مگابایت است.", "The file is larger than 5 MB."));
      error.status = 413;
      throw error;
    }

    const metaResponse = await fetch(
      "https://api.telegram.org/bot" +
        botToken +
        "/getFile?file_id=" +
        encodeURIComponent(document.file_id),
    );
    const meta = await metaResponse.json().catch(() => null);

    if (!meta || !meta.ok || !meta.result || !meta.result.file_path) {
      const error = new Error(t("دریافت فایل از تلگرام ناموفق بود.", "Failed to retrieve the file from Telegram."));
      error.status = 502;
      throw error;
    }

    const fileResponse = await fetch(
      "https://api.telegram.org/file/bot" +
        botToken +
        "/" +
        meta.result.file_path,
    );
    if (!fileResponse.ok) {
      const error = new Error(t("دانلود فایل از تلگرام ناموفق بود.", "Failed to download the file from Telegram."));
      error.status = 502;
      throw error;
    }

    const buffer = await fileResponse.arrayBuffer();
    if (buffer.byteLength > MAX_CONFIG_BYTES) {
      const error = new Error(t("حجم فایل بیشتر از ۵ مگابایت است.", "The file is larger than 5 MB."));
      error.status = 413;
      throw error;
    }

    return new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, "");
  }

  async function handleTelegramCallback(callbackQuery, env, settings, origin) {
    const fromId = String(
      callbackQuery.from && callbackQuery.from.id ? callbackQuery.from.id : "",
    );

    if (!constantTimeEqual(fromId, String(settings.adminChatId || ""))) {
      await telegramAnswerCallback(
        settings.botToken,
        callbackQuery.id,
        t("دسترسی مجاز نیست.", "Access denied."),
      );
      return;
    }

    const chatId =
      callbackQuery.message && callbackQuery.message.chat
        ? String(callbackQuery.message.chat.id)
        : fromId;
    const messageId = callbackQuery.message
      ? callbackQuery.message.message_id
      : null;
    const data = callbackQuery.data || "";
    const users = await getUsers(env);

    const edit = async function (text, markup) {
      return telegramEditCallbackMessage(
        callbackQuery,
        settings,
        chatId,
        text,
        markup,
      );
    };

    await telegramAnswerCallback(settings.botToken, callbackQuery.id, "");

    if (data === "tg:language") {
      await edit("زبان ربات را انتخاب کنید / Choose the bot language:", telegramLanguageKeyboard());
      return;
    }
    if (data === "tg:language:fa" || data === "tg:language:en") {
      await changeLanguage(data.slice("tg:language:".length), env, settings, chatId, origin);
      await edit(telegramStartText(), telegramInlineKeyboard(origin));
      return;
    }

    if (data === "tg:home") {
      await clearTelegramState(env, chatId);
      await edit(telegramStartText(), telegramInlineKeyboard(origin));
      return;
    }

    if (data === "tg:users") {
      await edit(
        users.length
          ? t("کاربر مورد نظر را انتخاب کنید:", "Select a user:")
          : t("هنوز کاربری ایجاد نشده است.", "No users have been created yet."),
        users.length
          ? telegramUsersKeyboard(users)
          : telegramInlineKeyboard(origin),
      );
      return;
    }

    if (data.startsWith("tg:user:")) {
      const id = data.slice("tg:user:".length);
      const user = users.find((item) => item.id === id);
      if (!user) return edit(t("کاربر پیدا نشد.", "User not found."), telegramUsersKeyboard(users));
      await edit(
        telegramUserSummaryText(user),
        telegramUserActionsKeyboard(user, origin),
      );
      return;
    }

    if (data.startsWith("tg:user_links:")) {
      const id = data.slice("tg:user_links:".length);
      const user = users.find((item) => item.id === id);
      if (!user) return edit(t("کاربر پیدا نشد.", "User not found."), telegramUsersKeyboard(users));
      const p = publicUser(user, new URL(origin), env);
      await edit(
        t("لینک‌های کانفیگ ", "Config links for ") +
          escapeHtml(user.name) +
          "\n\nRaw:\n" +
          p.links.raw +
          "\n\nBase64:\n" +
          p.links.base64,
        telegramUserActionsKeyboard(user, origin),
      );
      return;
    }

    if (data.startsWith("tg:user_summary:")) {
      const id = data.slice("tg:user_summary:".length);
      const user = users.find((item) => item.id === id);
      if (!user) return edit(t("کاربر پیدا نشد.", "User not found."), telegramUsersKeyboard(users));
      const configs = (await env.CONFIGS_KV.get(configKey(user.id))) || "";
      const stats = analyzeConfigs(configs);
      await edit(
        t("خلاصه کانفیگ ", "Config summary for ") +
          escapeHtml(user.name) +
          t("\nتعداد: ", "\nCount: ") +
          stats.total +
          t("\nشناخته‌شده: ", "\nRecognized: ") +
          stats.valid +
          t("\nنامشخص: ", "\nUnknown: ") +
          stats.unknown +
          t("\nتکراری محتوایی: ", "\nContent duplicates: ") +
          stats.duplicatesByContent,
        telegramUserActionsKeyboard(user, origin),
      );
      return;
    }

    if (data.startsWith("tg:user_set:") || data.startsWith("tg:user_append:")) {
      const isAppend = data.startsWith("tg:user_append:");
      const id = data.slice(
        isAppend ? "tg:user_append:".length : "tg:user_set:".length,
      );
      const user = users.find((item) => item.id === id);
      if (!user) return edit(t("کاربر پیدا نشد.", "User not found."), telegramUsersKeyboard(users));
      await setTelegramState(env, chatId, {
        action: isAppend ? "append_configs" : "set_configs",
        userId: user.id,
        messageId,
      });
      await edit(
        (isAppend ? t("کانفیگ‌هایی که باید اضافه شوند", "Configs to append") : t("کانفیگ‌های جایگزین", "Replacement configs")) +
          t(" را برای ", " for ") +
          escapeHtml(user.name) +
          t(" به صورت متن یا فایل ارسال کنید.\nبرای لغو، /cancel را بزنید.", ": send them as text or a file.\nUse /cancel to cancel."),
        telegramUserActionsKeyboard(user, origin),
      );
      return;
    }

    if (data.startsWith("tg:user_rename:")) {
      const id = data.slice("tg:user_rename:".length);
      const user = users.find((item) => item.id === id);
      if (!user) return edit(t("کاربر پیدا نشد.", "User not found."), telegramUsersKeyboard(users));
      await setTelegramState(env, chatId, {
        action: "rename_user",
        userId: user.id,
        messageId,
      });
      await edit(
        t("نام جدید کاربر را ارسال کنید.\nبرای لغو، /cancel را بزنید.", "Send the user's new name.\nUse /cancel to cancel."),
        telegramUserActionsKeyboard(user, origin),
      );
      return;
    }

    if (data.startsWith("tg:user_toggle:")) {
      const id = data.slice("tg:user_toggle:".length);
      const user = users.find((item) => item.id === id);
      if (!user) return edit(t("کاربر پیدا نشد.", "User not found."), telegramUsersKeyboard(users));
      user.enabled = user.enabled === false;
      user.updatedAt = new Date().toISOString();
      await saveUsers(env, users);
      await edit(
        t("وضعیت کاربر تغییر کرد: ", "User status changed: ") +
          escapeHtml(user.name) +
          " - " +
          (user.enabled ? t("فعال", "Enabled") : t("غیرفعال", "Disabled")),
        telegramUserActionsKeyboard(user, origin),
      );
      return;
    }

    if (data.startsWith("tg:user_regen_confirm:")) {
      const id = data.slice("tg:user_regen_confirm:".length);
      await edit(
        t("توکن قبلی این کاربر از کار می‌افتد. تأیید می‌کنید؟", "This user's previous token will stop working. Confirm?"),
        telegramConfirmKeyboard("tg:user_regen", id, "tg:user:" + id),
      );
      return;
    }

    if (data.startsWith("tg:user_regen:")) {
      const id = data.slice("tg:user_regen:".length);
      const user = users.find((item) => item.id === id);
      if (!user) return edit(t("کاربر پیدا نشد.", "User not found."), telegramUsersKeyboard(users));
      await env.CONFIGS_KV.delete(tokenKey(user.token));
      user.token = generateToken();
      user.updatedAt = new Date().toISOString();
      await env.CONFIGS_KV.put(tokenKey(user.token), user.id);
      await saveUsers(env, users);
      await edit(
        t("توکن جدید ساخته شد.", "New token generated."),
        telegramUserActionsKeyboard(user, origin),
      );
      return;
    }

    if (data.startsWith("tg:user_delete_confirm:")) {
      const id = data.slice("tg:user_delete_confirm:".length);
      await edit(
        t("این کاربر و کانفیگ‌های او حذف شود؟", "Delete this user and their configs?"),
        telegramConfirmKeyboard("tg:user_delete", id, "tg:user:" + id),
      );
      return;
    }

    if (data.startsWith("tg:user_delete:")) {
      const id = data.slice("tg:user_delete:".length);
      const index = users.findIndex((item) => item.id === id);
      if (index === -1)
        return edit(t("کاربر پیدا نشد.", "User not found."), telegramUsersKeyboard(users));
      const [removed] = users.splice(index, 1);
      await saveUsers(env, users);
      await env.CONFIGS_KV.delete(tokenKey(removed.token));
      await env.CONFIGS_KV.delete(configKey(removed.id));
      await env.CONFIGS_KV.delete(backupConfigKey(removed.id));
      await env.CONFIGS_KV.delete(metaKey(removed.id));
      await env.CONFIGS_KV.delete(backupMetaKey(removed.id));
      await edit(
        t("کاربر حذف شد: ", "User deleted: ") + escapeHtml(removed.name),
        users.length
          ? telegramUsersKeyboard(users)
          : telegramInlineKeyboard(origin),
      );
      return;
    }

    if (data === "tg:create_user") {
      await setTelegramState(env, chatId, { action: "create_user", messageId });
      await edit(
        t("نام کاربر جدید را ارسال کنید.\nبرای لغو، /cancel را بزنید.", "Send the new user's name.\nUse /cancel to cancel."),
        telegramInlineKeyboard(origin),
      );
      return;
    }

    if (data === "tg:bulk_menu") {
      await clearTelegramState(env, chatId);
      await edit(t("نوع اعمال گروهی را انتخاب کنید:", "Choose a bulk update mode:"), telegramBulkModeKeyboard());
      return;
    }

    if (data.startsWith("tg:bulk_all:")) {
      const mode =
        data.slice("tg:bulk_all:".length) === "append" ? "append" : "replace";
      await setTelegramState(env, chatId, {
        action: "bulk_configs",
        mode,
        target: "all",
        userIds: [],
        messageId,
      });
      await edit(
        (mode === "append"
          ? t("کانفیگ‌هایی که باید به همه کاربران اضافه شوند", "Configs to append to all users")
          : t("کانفیگ‌های جایگزین برای همه کاربران", "Replacement configs for all users")) +
          t(" را به صورت متن یا فایل ارسال کنید.\nبرای لغو، /cancel را بزنید.", ": send them as text or a file.\nUse /cancel to cancel."),
        telegramBulkModeKeyboard(),
      );
      return;
    }

    if (data.startsWith("tg:bulk_select:")) {
      const mode =
        data.slice("tg:bulk_select:".length) === "append" ? "append" : "replace";
      await setTelegramState(env, chatId, {
        action: "bulk_select",
        mode,
        userIds: [],
        messageId,
      });
      await edit(
        t("کاربران مورد نظر را انتخاب کنید و سپس «ادامه و ارسال کانفیگ» را بزنید:", "Select users, then press Continue and send configs:"),
        telegramBulkSelectKeyboard(users, []),
      );
      return;
    }

    if (data.startsWith("tg:bulk_toggle:")) {
      const id = data.slice("tg:bulk_toggle:".length);
      const state = await getTelegramState(env, chatId);
      if (!state || state.action !== "bulk_select") {
        await setTelegramState(env, chatId, {
          action: "bulk_select",
          mode: "replace",
          userIds: [id],
          messageId,
        });
        await edit(
          t("کاربران انتخاب‌شده: 1", "Selected users: 1"),
          telegramBulkSelectKeyboard(users, [id]),
        );
        return;
      }
      const selected = new Set(state.userIds || []);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      state.userIds = Array.from(selected);
      state.messageId = state.messageId || messageId;
      await setTelegramState(env, chatId, state);
      await edit(
        t("کاربران انتخاب‌شده: ", "Selected users: ") + (state.userIds.length || 0),
        telegramBulkSelectKeyboard(users, state.userIds),
      );
      return;
    }

    if (data === "tg:bulk_selected_continue") {
      const state = await getTelegramState(env, chatId);
      if (
        !state ||
        state.action !== "bulk_select" ||
        !state.userIds ||
        !state.userIds.length
      ) {
        await edit(
          t("حداقل یک کاربر را انتخاب کنید.", "Select at least one user."),
          telegramBulkSelectKeyboard(users, []),
        );
        return;
      }
      await setTelegramState(env, chatId, {
        action: "bulk_configs",
        mode: state.mode || "replace",
        target: "selected",
        userIds: state.userIds,
        messageId: state.messageId || messageId,
      });
      await edit(
        t("اکنون کانفیگ‌ها را به صورت متن یا فایل ارسال کنید.\nبرای لغو، /cancel را بزنید.", "Now send configs as text or a file.\nUse /cancel to cancel."),
        telegramBulkSelectKeyboard(users, state.userIds),
      );
      return;
    }

    if (data === "tg:password") {
      await setTelegramState(env, chatId, {
        action: "change_password",
        messageId,
      });
      await edit(
        t("رمز عبور جدید پنل را ارسال کنید. حداقل ۸ کاراکتر.\nبرای لغو، /cancel را بزنید.", "Send the new panel password (at least 8 characters).\nUse /cancel to cancel."),
        telegramInlineKeyboard(origin),
      );
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
      "🌐 زبان / Language": "/language",
      "👥 کاربران": "/users",
      "👥 Users": "/users",
      "❓ راهنما": "/help",
      "❓ Help": "/help",
      "📋 لیست دستورات": "/commands",
      "📋 Command list": "/commands",
      "📄 ارسال فایل": "/file",
      "📄 Upload file": "/file",
      "➕ افزودن کاربر": "/newuser",
      "➕ Add user": "/newuser",
      "📦 اعمال گروهی": "/bulk",
      "📦 Bulk update": "/bulk",
      "🔐 تغییر رمز": "/password_change",
      "🔐 Change password": "/password_change",
      "❌ لغو": "/cancel",
      "❌ Cancel": "/cancel",
    };

    return map[text] || text;
  }

  function shouldShowTelegramInlineKeyboard(text) {
    return (
      text === "/start" ||
      text === "/help" ||
      text === "/commands" ||
      text === "/file" ||
      text === "/miniapp" ||
      text === "/newuser" ||
      text === "/bulk" ||
      text === "/password_change"
    );
  }

  async function getTelegramState(env, chatId) {
    return await getJson(env, telegramStateKey(chatId), null);
  }

  async function setTelegramState(env, chatId, state) {
    await env.CONFIGS_KV.put(
      telegramStateKey(chatId),
      JSON.stringify({ ...state, updatedAt: new Date().toISOString() }),
      { expirationTtl: 3600 },
    );
  }

  async function clearTelegramState(env, chatId) {
    await env.CONFIGS_KV.delete(telegramStateKey(chatId));
  }

  function telegramStateKey(chatId) {
    return TELEGRAM_STATE_PREFIX + chatId;
  }

  async function handleTelegramStateInput(
    inputText,
    state,
    chatId,
    env,
    settings,
    origin,
    fromFile = false,
  ) {
    const text = String(inputText || "").trim();
    if (!text) return t("متن دریافتی خالی است.", "The received text is empty.");

    if (state.action === "create_user") {
      const name = cleanName(text);
      if (!name) return t("نام کاربر معتبر نیست.", "Invalid user name.");
      const users = await getUsers(env);
      const user = {
        id: generateId(),
        name,
        token: generateToken(),
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastConfigUpdate: null,
      };
      users.push(user);
      await saveUsers(env, users);
      await env.CONFIGS_KV.put(tokenKey(user.token), user.id);
      await env.CONFIGS_KV.put(configKey(user.id), "");
      await clearTelegramState(env, chatId);
      const p = publicUser(user, new URL(origin), env);
      return (
        t("کاربر ایجاد شد.\nنام: ", "User created.\nName: ") +
        escapeHtml(user.name) +
        t("\nشناسه: ", "\nID: ") +
        user.id +
        t("\nلینک Raw:\n", "\nRaw link:\n") +
        p.links.raw
      );
    }

    if (state.action === "rename_user") {
      const users = await getUsers(env);
      const user = users.find((item) => item.id === state.userId);
      if (!user) {
        await clearTelegramState(env, chatId);
        return t("کاربر پیدا نشد.", "User not found.");
      }
      const name = cleanName(text);
      if (!name) return t("نام جدید معتبر نیست.", "Invalid new name.");
      user.name = name;
      user.updatedAt = new Date().toISOString();
      await saveUsers(env, users);
      await clearTelegramState(env, chatId);
      return t("نام کاربر تغییر کرد: ", "User renamed: ") + escapeHtml(user.name);
    }

    if (state.action === "change_password") {
      if (text.length < 8) return t("رمز عبور جدید باید حداقل ۸ کاراکتر باشد.", "The new password must contain at least 8 characters.");
      await env.CONFIGS_KV.put(ADMIN_PASSWORD_HASH_KEY, await sha256Hex(text));
      await env.CONFIGS_KV.put(
        ADMIN_PASSWORD_META_KEY,
        JSON.stringify({
          updatedAt: new Date().toISOString(),
          source: "telegram-button",
        }),
      );
      await clearTelegramState(env, chatId);
      return t("رمز عبور پنل تغییر کرد.", "Panel password changed.");
    }

    if (state.action === "set_configs" || state.action === "append_configs") {
      const users = await getUsers(env);
      const user = users.find((item) => item.id === state.userId);
      if (!user) {
        await clearTelegramState(env, chatId);
        return t("کاربر پیدا نشد.", "User not found.");
      }
      const current = (await env.CONFIGS_KV.get(configKey(user.id))) || "";
      const input =
        state.action === "append_configs" ? current + "\n" + text : text;
      const saved = await saveConfigsForUser(env, user, input, {
        normalize: true,
        dedupe: true,
      });
      user.lastConfigUpdate = saved.meta.updatedAt;
      user.updatedAt = saved.meta.updatedAt;
      await saveUsers(env, users);
      await clearTelegramState(env, chatId);
      return (
        t("کانفیگ‌های ", "Configs for ") +
        escapeHtml(user.name) +
        t(" ذخیره شد.", " saved.") +
        (fromFile ? t("\nمنبع: فایل", "\nSource: file") : "") +
        t("\nتعداد نهایی: ", "\nFinal count: ") +
        saved.stats.total +
        t("\nتکراری حذف‌شده: ", "\nDuplicates removed: ") +
        saved.stats.duplicatesByContent
      );
    }

    if (state.action === "bulk_configs") {
      const users = await getUsers(env);
      const selected =
        state.target === "all"
          ? users
          : users.filter((user) => (state.userIds || []).includes(user.id));
      if (!selected.length) {
        await clearTelegramState(env, chatId);
        return t("کاربری برای اعمال انتخاب نشده است.", "No users selected for this update.");
      }
      for (const user of selected) {
        const current = (await env.CONFIGS_KV.get(configKey(user.id))) || "";
        const input = state.mode === "append" ? current + "\n" + text : text;
        const saved = await saveConfigsForUser(env, user, input, {
          normalize: true,
          dedupe: true,
        });
        user.lastConfigUpdate = saved.meta.updatedAt;
        user.updatedAt = saved.meta.updatedAt;
      }
      await saveUsers(env, users);
      await clearTelegramState(env, chatId);
      return (
        t("کانفیگ‌ها اعمال شد.", "Configs applied.") +
        (fromFile ? t("\nمنبع: فایل", "\nSource: file") : "") +
        t("\nتعداد کاربران: ", "\nUser count: ") +
        selected.length
      );
    }

    return t("وضعیت عملیات مشخص نیست. /cancel را ارسال کنید.", "Unknown operation state. Send /cancel.");
  }

  function telegramUserSummaryText(user) {
    return (
      t("کاربر: ", "User: ") +
      escapeHtml(user.name) +
      t("\nشناسه: ", "\nID: ") +
      user.id +
      t("\nوضعیت: ", "\nStatus: ") +
      (user.enabled !== false ? t("فعال", "Enabled") : t("غیرفعال", "Disabled")) +
      t("\nآخرین تغییر: ", "\nLast updated: ") +
      (user.updatedAt || "-")
    );
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
      return (
        t("شناسه عددی تلگرام ادمین ثبت‌شده: ", "Registered admin Telegram ID: ") +
        escapeHtml(settings.adminChatId || t("ثبت نشده", "Not set")) +
        "\n\n" +
        t("توجه: USER_ID در دستورهای کانفیگ، شناسه داخلی کاربر پنل است، مثل u_xxxxx. آن را از /users یا دکمه «کاربران» بردارید.", "USER_ID in config commands is the panel's internal user ID, such as u_xxxxx. Get it from /users or the Users button.")
      );
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
      return t("عملیات جاری لغو شد.", "Current operation cancelled.");
    }

    if (command === "/newuser") {
      await setTelegramState(env, settings.adminChatId, {
        action: "create_user",
      });
      return t("نام کاربر جدید را ارسال کنید.\nبرای لغو، /cancel را بزنید.", "Send the new user's name.\nUse /cancel to cancel.");
    }

    if (command === "/bulk") {
      return t("از دکمه‌های اعمال گروهی استفاده کنید.", "Use the bulk update buttons.");
    }

    if (command === "/password_change") {
      await setTelegramState(env, settings.adminChatId, {
        action: "change_password",
      });
      return t("رمز عبور جدید پنل را ارسال کنید. حداقل ۸ کاراکتر.\nبرای لغو، /cancel را بزنید.", "Send the new panel password (at least 8 characters).\nUse /cancel to cancel.");
    }

    if (command === "/adduser_help") {
      return t("برای ایجاد کاربر جدید، دستور را به این شکل ارسال کنید:\n/adduser mobile", "To create a user, send:\n/adduser mobile");
    }

    if (command === "/bulk_help") {
      return t("برای جایگزینی کانفیگ همه کاربران:\n/apply_all\nvless://...\n\nبرای افزودن به کانفیگ فعلی همه کاربران:\n/append_all\nvless://...\n\nبرای چند کاربر مشخص:\n/apply_users id1,id2\nvless://...", "To replace all users' configs:\n/apply_all\nvless://...\n\nTo append to all users' configs:\n/append_all\nvless://...\n\nFor selected users:\n/apply_users id1,id2\nvless://...");
    }

    if (command === "/users") {
      const users = await getUsers(env);
      if (!users.length) return t("هنوز کاربری ایجاد نشده است.", "No users have been created yet.");
      return users
        .map((user) => {
          const p = publicUser(user, url, env);
          return (
            t("شناسه: ", "ID: ") +
            user.id +
            t("\nنام: ", "\nName: ") +
            escapeHtml(user.name) +
            t("\nوضعیت: ", "\nStatus: ") +
            (user.enabled !== false ? t("فعال", "Enabled") : t("غیرفعال", "Disabled")) +
            t("\nلینک Raw: ", "\nRaw link: ") +
            p.links.raw +
            t("\nلینک Base64: ", "\nBase64 link: ") +
            p.links.base64
          );
        })
        .join("\n\n");
    }

    if (command === "/adduser") {
      const name = cleanName(args.slice(1).join(" "));
      if (!name) return t("فرمت صحیح:\n/adduser mobile", "Correct format:\n/adduser mobile");
      const users = await getUsers(env);
      const user = {
        id: generateId(),
        name,
        token: generateToken(),
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastConfigUpdate: null,
      };
      users.push(user);
      await saveUsers(env, users);
      await env.CONFIGS_KV.put(tokenKey(user.token), user.id);
      await env.CONFIGS_KV.put(configKey(user.id), "");
      const p = publicUser(user, url, env);
      return (
        t("کاربر ایجاد شد.", "User created.") +
        t("\nشناسه: ", "\nID: ") +
        user.id +
        t("\nنام: ", "\nName: ") +
        escapeHtml(user.name) +
        t("\nلینک Raw: ", "\nRaw link: ") +
        p.links.raw
      );
    }

    if (command === "/deluser") {
      const id = args[1] || "";
      const users = await getUsers(env);
      const index = users.findIndex((user) => user.id === id);
      if (index === -1) return t("کاربر پیدا نشد.", "User not found.");
      const [removed] = users.splice(index, 1);
      await saveUsers(env, users);
      await env.CONFIGS_KV.delete(tokenKey(removed.token));
      await env.CONFIGS_KV.delete(configKey(removed.id));
      await env.CONFIGS_KV.delete(backupConfigKey(removed.id));
      await env.CONFIGS_KV.delete(metaKey(removed.id));
      await env.CONFIGS_KV.delete(backupMetaKey(removed.id));
      return t("کاربر حذف شد: ", "User deleted: ") + escapeHtml(removed.name);
    }

    if (command === "/enable" || command === "/disable") {
      const id = args[1] || "";
      const users = await getUsers(env);
      const user = users.find((item) => item.id === id);
      if (!user) return t("کاربر پیدا نشد.", "User not found.");
      user.enabled = command === "/enable";
      user.updatedAt = new Date().toISOString();
      await saveUsers(env, users);
      return (
        t("وضعیت کاربر تغییر کرد: ", "User status changed: ") +
        escapeHtml(user.name) +
        " - " +
        (user.enabled ? t("فعال", "Enabled") : t("غیرفعال", "Disabled"))
      );
    }

    if (command === "/configs") {
      const id = args[1] || "";
      const user = await getUserById(env, id);
      if (!user) return t("کاربر پیدا نشد.", "User not found.");
      const configs = (await env.CONFIGS_KV.get(configKey(user.id))) || "";
      const stats = analyzeConfigs(configs);
      const preview = configs.split("\n").filter(Boolean).slice(0, 8).join("\n");
      return (
        t("کاربر: ", "User: ") +
        escapeHtml(user.name) +
        t("\nتعداد: ", "\nCount: ") +
        stats.total +
        t("\nتکراری محتوایی: ", "\nContent duplicates: ") +
        stats.duplicatesByContent +
        "\n\n" +
        (preview ? escapeHtml(preview) : t("کانفیگی ثبت نشده است.", "No configs saved."))
      );
    }

    if (command === "/setconfigs" || command === "/appendconfigs") {
      const id = args[1] || "";
      const users = await getUsers(env);
      const user = users.find((item) => item.id === id);
      if (!user) return t("کاربر پیدا نشد.", "User not found.");
      if (!restText)
        return t("کانفیگ‌ها را از خط بعدی پیام وارد کنید، یا یک فایل متنی با کپشن همین دستور ارسال کنید.", "Enter configs on the next line, or send a text file with this command as its caption.");
      const current = (await env.CONFIGS_KV.get(configKey(user.id))) || "";
      const input =
        command === "/appendconfigs" ? current + "\n" + restText : restText;
      const saved = await saveConfigsForUser(env, user, input, {
        normalize: true,
        dedupe: true,
      });
      user.lastConfigUpdate = saved.meta.updatedAt;
      user.updatedAt = saved.meta.updatedAt;
      await saveUsers(env, users);
      return (
        t("کانفیگ‌های ", "Configs for ") +
        escapeHtml(user.name) +
        t(" ذخیره شد.", " saved.") +
        t("\nتعداد نهایی: ", "\nFinal count: ") +
        saved.stats.total +
        t("\nتکراری حذف‌شده: ", "\nDuplicates removed: ") +
        saved.stats.duplicatesByContent
      );
    }

    if (command === "/apply_all" || command === "/append_all") {
      if (!restText)
        return t("کانفیگ‌ها را از خط بعدی پیام وارد کنید، یا یک فایل متنی با کپشن همین دستور ارسال کنید.", "Enter configs on the next line, or send a text file with this command as its caption.");
      const users = await getUsers(env);
      if (!users.length) return t("کاربری وجود ندارد.", "No users exist.");
      for (const user of users) {
        const current = (await env.CONFIGS_KV.get(configKey(user.id))) || "";
        const input =
          command === "/append_all" ? current + "\n" + restText : restText;
        const saved = await saveConfigsForUser(env, user, input, {
          normalize: true,
          dedupe: true,
        });
        user.lastConfigUpdate = saved.meta.updatedAt;
        user.updatedAt = saved.meta.updatedAt;
      }
      await saveUsers(env, users);
      return (
        t("کانفیگ‌ها برای همه کاربران اعمال شد. تعداد کاربران: ", "Configs applied to all users. User count: ") + users.length
      );
    }

    if (command === "/apply_users" || command === "/append_users") {
      const ids = String(args[1] || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (!ids.length)
        return t("فرمت صحیح:\n/apply_users id1,id2\nسپس کانفیگ‌ها از خط بعدی یا فایل با همین کپشن", "Correct format:\n/apply_users id1,id2\nThen configs on the next line, or a file with this caption.");
      if (!restText)
        return t("کانفیگ‌ها را از خط بعدی پیام وارد کنید، یا یک فایل متنی با کپشن همین دستور ارسال کنید.", "Enter configs on the next line, or send a text file with this command as its caption.");
      const users = await getUsers(env);
      const selected = users.filter((user) => ids.includes(user.id));
      if (!selected.length) return t("هیچ کاربری با این شناسه‌ها پیدا نشد.", "No users found with these IDs.");
      for (const user of selected) {
        const current = (await env.CONFIGS_KV.get(configKey(user.id))) || "";
        const input =
          command === "/append_users" ? current + "\n" + restText : restText;
        const saved = await saveConfigsForUser(env, user, input, {
          normalize: true,
          dedupe: true,
        });
        user.lastConfigUpdate = saved.meta.updatedAt;
        user.updatedAt = saved.meta.updatedAt;
      }
      await saveUsers(env, users);
      return (
        t("کانفیگ‌ها برای کاربران انتخاب‌شده اعمال شد. تعداد: ", "Configs applied to selected users. Count: ") + selected.length
      );
    }

    if (command === "/password") {
      const newPassword = args.slice(1).join(" ");
      if (newPassword.length < 8)
        return t("رمز عبور جدید باید حداقل ۸ کاراکتر باشد.", "The new password must contain at least 8 characters.");
      await env.CONFIGS_KV.put(
        ADMIN_PASSWORD_HASH_KEY,
        await sha256Hex(newPassword),
      );
      await env.CONFIGS_KV.put(
        ADMIN_PASSWORD_META_KEY,
        JSON.stringify({
          updatedAt: new Date().toISOString(),
          source: "telegram",
        }),
      );
      return t("رمز عبور پنل تغییر کرد.", "Panel password changed.");
    }

    if (command === "/webhook") {
      const result = await configureTelegramEntryPoints(settings, origin);
      return (
        t("وبهوک، منوی ربات، دکمه مینی‌اپ و لیست دستورها دوباره تنظیم شد.\n", "Webhook and bot commands have been reset.\n") +
        escapeHtml(JSON.stringify(result))
      );
    }

    return t("دستور شناخته نشد. برای راهنما /help را ارسال کنید.", "Unknown command. Send /help for help.");
  }

  function telegramStartText() {
    return t("ربات مدیریت کانفیگ‌ها فعال است.\n\nاز دکمه‌های پایین می‌توانید کاربران، کانفیگ‌ها و تنظیمات گروهی را مدیریت کنید.\nبرای راهنمای کامل، دکمه «❓ راهنما» یا دستور /help را بزنید. لیست دستورها نیز با زدن / در تلگرام نمایش داده می‌شود.", "The config management bot is active.\n\nUse the buttons below to manage users, configs and bulk updates.\nFor help, press Help or send /help. Type / in Telegram to see commands.");
  }

  function telegramHelpText() {
    return (
      t("راهنمای مدیریت ربات\n\n", "Bot management help\n\n") +
      t("📝 ارسال کانفیگ متنی:\n", "📝 Send configs as text:\n") +
      "/setconfigs USER_ID\n" +
      "vless://...\n" +
      "trojan://...\n\n" +
      t("📄 ارسال کانفیگ با فایل:\n", "📄 Send configs as a file:\n") +
      t("یک فایل txt/conf ارسال کنید و در Caption آن دستور مورد نظر را بنویسید. مثال:\n", "Send a txt/conf file with the desired command as its caption. Example:\n") +
      "/setconfigs USER_ID\n\n" +
      t("📋 برای دیدن لیست کامل دستورها، /commands را ارسال کنید.", "📋 Send /commands to see all commands.")
    );
  }

  function telegramCommandsText() {
    return (
      t("لیست دستورهای ربات\n\n", "Bot commands\n\n") +
      t("/language - تغییر زبان ربات\n", "/language - Change bot language\n") +
      t("/start - نمایش منوی اصلی\n", "/start - Show main menu\n") +
      t("/help - راهنمای کامل استفاده\n", "/help - Full usage help\n") +
      t("/commands - توضیح دستورها\n", "/commands - Command descriptions\n") +
      t("/file - راهنمای ارسال فایل کانفیگ\n", "/file - Config file upload help\n") +
      t("/users - باز کردن مدیریت کاربران با دکمه\n", "/users - Open user management buttons\n") +
      t("/newuser - ایجاد کاربر به صورت مرحله‌ای\n", "/newuser - Create a user step by step\n") +
      t("/bulk - اعمال گروهی با دکمه\n", "/bulk - Bulk update buttons\n") +
      t("/cancel - لغو عملیات جاری\n", "/cancel - Cancel current operation\n") +
      t("/setconfigs ID - جایگزینی کانفیگ کاربر\n", "/setconfigs ID - Replace user configs\n") +
      t("/appendconfigs ID - افزودن کانفیگ به کاربر\n", "/appendconfigs ID - Append user configs\n") +
      t("/apply_all - جایگزینی کانفیگ همه کاربران\n", "/apply_all - Replace all users' configs\n") +
      t("/append_all - افزودن کانفیگ به همه کاربران\n", "/append_all - Append configs to all users\n") +
      t("/apply_users id1,id2 - جایگزینی برای چند کاربر\n", "/apply_users id1,id2 - Replace selected users' configs\n") +
      t("/append_users id1,id2 - افزودن برای چند کاربر\n", "/append_users id1,id2 - Append configs to selected users\n") +
      t("/password NEW_PASSWORD - تغییر رمز پنل\n", "/password NEW_PASSWORD - Change panel password\n") +
      t("/webhook - تنظیم مجدد وبهوک، منو و کامندها", "/webhook - Reset webhook and commands")
    );
  }

  function telegramFileHelpText() {
    return (
      t("راهنمای ارسال فایل کانفیگ\n\n", "Config file upload help\n\n") +
      t("۱. یک فایل متنی با پسوند txt یا conf آماده کنید.\n", "1. Prepare a text file with a txt or conf extension.\n") +
      t("۲. فایل را برای ربات ارسال کنید.\n", "2. Send the file to the bot.\n") +
      t("۳. در قسمت Caption فایل، یکی از دستورهای زیر را بنویسید:\n\n", "3. Set one of these commands as the file caption:\n\n") +
      t("برای جایگزینی کانفیگ یک کاربر:\n", "To replace a user's configs:\n") +
      "/setconfigs USER_ID\n\n" +
      t("برای افزودن به کانفیگ یک کاربر:\n", "To append configs to a user:\n") +
      "/appendconfigs USER_ID\n\n" +
      t("برای جایگزینی همه کاربران:\n", "To replace all users' configs:\n") +
      "/apply_all\n\n" +
      t("برای افزودن به همه کاربران:\n", "To append configs to all users:\n") +
      "/append_all\n\n" +
      t("برای چند کاربر مشخص:\n", "For selected users:\n") +
      "/apply_users id1,id2\n\n" +
      t("بعد از دریافت فایل، کانفیگ‌های تکراری حتی با نام متفاوت حذف می‌شوند.", "After receiving the file, duplicate configs are removed, including those with different names.")
    );
  }

  return { configureTelegramEntryPoints, handleTelegramUpdate, sendTest };
}

function configKey(userId) {
  return "user_configs:" + userId;
}
function backupConfigKey(userId) {
  return "user_configs_backup:" + userId;
}
function metaKey(userId) {
  return "user_configs_meta:" + userId;
}
function backupMetaKey(userId) {
  return "user_configs_backup_meta:" + userId;
}
function tokenKey(token) {
  return "user_token:" + token;
}

async function getJson(env, key, fallback) {
  const raw = await env.CONFIGS_KV.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function arrayOfStrings(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : [];
}

function cleanName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

function safeFilename(value) {
  return (
    String(value || "user")
      .replace(/[^a-zA-Z0-9-_\u0600-\u06FF]+/g, "-")
      .slice(0, 80) || "user"
  );
}

function generateId() {
  return (
    "u_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8)
  );
}

function generateToken(length = 56) {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => chars[byte % chars.length])
    .join("");
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
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
    let value = String(input || "")
      .replace(/-/g, "+")
      .replace(/_/g, "/");
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
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + stableJson(value[key]))
        .join(",") +
      "}"
    );
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
  return String(value || "").replace(
    /[&<>'"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        char
      ],
  );
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...securityHeaders(),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function htmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: {
      ...securityHeaders(),
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function securityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
}

const ADMIN_HTML = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title data-i18n="پنل مدیریت کانفیگ‌ها">پنل مدیریت کانفیگ‌ها</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/lucide@latest/dist/umd/lucide.min.js"></script>
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

    svg.lucide { flex-shrink: 0; width: 15px; height: 15px; }
    .tab svg.lucide { width: 17px; height: 17px; }
    .logo svg.lucide { width: 28px; height: 28px; color: #fff; }
    .btn.full svg.lucide { width: 16px; height: 16px; }

    @media (max-width: 1050px) {
      .layout, .grid2, .grid3 { grid-template-columns: 1fr; }
      .stats { grid-template-columns: repeat(2, 1fr); }
      .topbar { align-items: flex-start; flex-direction: column; }
      .linkrow { grid-template-columns: 1fr; }
    }

    :root { color-scheme: dark; }
    :root[data-theme="light"] {
      color-scheme: light;
      --bg: #f3f5fc; --surface: #fff; --surface2: #eef0f8;
      --border: #d5daea; --text: #1b2540; --muted: #53617b;
      --primary: #6847df; --primary2: #007eaa;
      --shadow: 0 24px 90px rgba(35,49,84,.12);
    }
    [data-theme="light"] body { background-image: radial-gradient(circle at 15% 10%, #e6dfff, transparent 40%), linear-gradient(135deg, #f3f5fc, #eaf2fa); }
    [data-theme="light"] .shell, [data-theme="light"] .card { background: rgba(255,255,255,.9) !important; }
    [data-theme="light"] .input, [data-theme="light"] .textarea,
    [data-theme="light"] .select, [data-theme="light"] .select option,
    [data-theme="light"] .code, [data-theme="light"] .stat,
    [data-theme="light"] .drop, [data-theme="light"] .tab,
    [data-theme="light"] .user-item, [data-theme="light"] .checks label,
    [data-theme="light"] .checks input[type="checkbox"] { background: #f5f7fc; border-color: var(--border); color: var(--text); }
    [data-theme="light"] .label { color: var(--text); }
    [data-theme="light"] .btn { background: #e9edf7; border-color: var(--border); }
    [data-theme="light"] .btn.primary { background: linear-gradient(135deg, #6847df, #386dd4); color: #fff; }
    [data-theme="light"] .btn.success { background: linear-gradient(135deg, #087954, #006c66); color: #fff; }
    [data-theme="light"] .btn.danger { background: #fff0f3; border-color: #e7b1be; color: #ac2344; }
    [data-theme="light"] .tab.active, [data-theme="light"] .user-item.active { background: #e9e3ff; border-color: var(--primary); }
    [data-theme="light"] .checks input[type="checkbox"]:checked { background: var(--primary); }
    [data-theme="light"] .toast-item { background: #fff; border-color: var(--border); }
    [data-theme="light"] .toast-item.ok { border-color: #087954; }
    [data-theme="light"] .toast-item.err { border-color: #ac2344; }
    .preferences { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 14px; }
    .preferences .btn { width: auto; min-width: 46px; min-height: 44px; }
    .btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
    .btn:focus-visible, .tab:focus-visible { outline: 3px solid var(--primary2); outline-offset: 3px; }
    .tab { text-align: start; }
    html[dir="ltr"] .input.rtl { direction: ltr; text-align: left; }
    @media (max-width: 520px) { html[dir="ltr"] .checks label { flex-direction: row; } }
  </style>
</head>
<body>
  <main class="app">
    <div class="preferences" aria-label="Panel preferences">
      <button id="languageToggle" class="btn" type="button"></button>
      <button id="themeToggle" class="btn" type="button"></button>
    </div>
    <section id="loginView" class="login-wrap">
      <div class="shell login-card">
        <div class="brand">
          <div class="logo"><i data-lucide="shield-check"></i></div>
          <div><h1 data-i18n="پنل مدیریت کانفیگ‌ها">پنل مدیریت کانفیگ‌ها</h1></div>
        </div>
        <form id="loginForm">
          <div class="field">
            <label class="label" for="passwordInput"><span data-i18n="رمز عبور">رمز عبور</span></label>
            <input id="passwordInput" class="input rtl" type="password" autocomplete="current-password" placeholder="رمز عبور" data-i18n-placeholder="رمز عبور" />
          </div>
          <button class="btn primary full" type="submit"><i data-lucide="log-in"></i> <span data-i18n="ورود به پنل">ورود به پنل</span></button>
        </form>
      </div>
    </section>

    <section id="dashboardView" class="hidden">
      <div class="topbar">
        <div class="brand">
          <div class="logo"><i data-lucide="shield-check"></i></div>
          <div>
            <h1><span data-i18n="مدیریت پیشرفته کانفیگ‌ها">مدیریت پیشرفته کانفیگ‌ها</span></h1>
            <p class="subtitle"><span data-i18n="کاربر ایجاد کنید، کانفیگ اختصاصی بدهید، تنظیمات گروهی اعمال کنید و ربات تلگرام را متصل کنید.">کاربر ایجاد کنید، کانفیگ اختصاصی بدهید، تنظیمات گروهی اعمال کنید و ربات تلگرام را متصل کنید.</span></p>
          </div>
        </div>
        <div class="toolbar">
          <button id="refreshBtn" class="btn"><i data-lucide="refresh-cw"></i> <span data-i18n="بارگذاری مجدد">بارگذاری مجدد</span></button>
          <button id="logoutBtn" class="btn ghost"><i data-lucide="log-out"></i> <span data-i18n="خروج">خروج</span></button>
        </div>
      </div>

      <div class="shell dashboard">
        <div class="layout">
          <aside class="card">
            <div class="card-title"><h2><span data-i18n="بخش‌ها">بخش‌ها</span></h2></div>
            <div class="tabs">
              <button class="tab active" data-tab="usersPanel"><i data-lucide="users"></i> <span data-i18n="کاربران">کاربران</span></button>
              <button class="tab" data-tab="configsPanel"><i data-lucide="file-cog"></i> <span data-i18n="کانفیگ اختصاصی کاربر">کانفیگ اختصاصی کاربر</span></button>
              <button class="tab" data-tab="bulkPanel"><i data-lucide="layers"></i> <span data-i18n="اعمال گروهی کانفیگ">اعمال گروهی کانفیگ</span></button>
              <button class="tab" data-tab="securityPanel"><i data-lucide="shield"></i> <span data-i18n="امنیت و رمز عبور">امنیت و رمز عبور</span></button>
              <button class="tab" data-tab="telegramPanel"><i data-lucide="bot"></i> <span data-i18n="ربات تلگرام">ربات تلگرام</span></button>
            </div>
          </aside>

          <section>
            <div id="usersPanel" class="panel active">
              <div class="grid2">
                <div class="card">
                  <div class="card-title"><h2><span data-i18n="ایجاد کاربر">ایجاد کاربر</span></h2></div>
                  <div class="field">
                    <label class="label"><span data-i18n="نام کاربر">نام کاربر</span></label>
                    <input id="newUserName" class="input rtl" placeholder="مثلاً موبایل، لپ‌تاپ، کاربر ۱" data-i18n-placeholder="مثلاً موبایل، لپ‌تاپ، کاربر ۱" />
                  </div>
                  <div class="field">
                    <label class="label" for="newUserSource"><span data-i18n="کپی کانفیگ از کاربر دیگر (اختیاری)">کپی کانفیگ از کاربر دیگر (اختیاری)</span></label>
                    <select id="newUserSource" class="select"></select>
                  </div>
                  <button id="createUserBtn" class="btn primary full"><i data-lucide="user-plus"></i> <span data-i18n="ایجاد کاربر">ایجاد کاربر</span></button>
                </div>
                <div class="card">
                  <div class="card-title"><h2><span data-i18n="کاربران">کاربران</span></h2></div>
                  <div id="usersList" class="user-list"></div>
                </div>
              </div>
            </div>

            <div id="configsPanel" class="panel">
              <div class="card">
                <div class="card-title">
                  <h2><span data-i18n="کانفیگ اختصاصی کاربر">کانفیگ اختصاصی کاربر</span></h2>
                  <div class="toolbar">
                    <button id="fileBtn" class="btn"><i data-lucide="upload"></i> <span data-i18n="آپلود فایل">آپلود فایل</span></button>
                    <button id="cleanBtn" class="btn"><i data-lucide="sparkles"></i> <span data-i18n="پاک‌سازی">پاک‌سازی</span></button>
                    <button id="downloadBtn" class="btn"><i data-lucide="download"></i> <span data-i18n="دانلود TXT">دانلود TXT</span></button>
                    <button id="restoreBtn" class="btn danger"><i data-lucide="history"></i> <span data-i18n="بازیابی بکاپ">بازیابی بکاپ</span></button>
                    <button id="saveConfigsBtn" class="btn success"><i data-lucide="save"></i> <span data-i18n="ذخیره کانفیگ‌ها">ذخیره کانفیگ‌ها</span></button>
                  </div>
                </div>

                <div class="grid2">
                  <div>
                    <div class="field">
                      <label class="label"><span data-i18n="انتخاب کاربر">انتخاب کاربر</span></label>
                      <select id="selectedUserSelect" class="select"></select>
                    </div>
                    <div class="field">
                      <label class="label"><span data-i18n="نام کاربر">نام کاربر</span></label>
                      <input id="editUserName" class="input rtl" />
                    </div>
                    <div class="checks">
                      <label><input id="editUserEnabled" type="checkbox" checked /> <span data-i18n="کاربر فعال باشد">کاربر فعال باشد</span></label>
                    </div>
                    <div class="toolbar">
                      <button id="updateUserBtn" class="btn"><i data-lucide="check-circle"></i> <span data-i18n="ذخیره مشخصات">ذخیره مشخصات</span></button>
                      <button id="regenTokenBtn" class="btn danger"><i data-lucide="key-round"></i> <span data-i18n="ساخت توکن جدید">ساخت توکن جدید</span></button>
                      <button id="deleteUserBtn" class="btn danger"><i data-lucide="trash-2"></i> <span data-i18n="حذف کاربر">حذف کاربر</span></button>
                    </div>
                  </div>
                  <div>
                    <div class="label"><span data-i18n="لینک Raw">لینک Raw</span></div>
                    <div class="linkrow"><div id="rawLink" class="code">-</div><button id="copyRawBtn" class="btn small"><i data-lucide="copy"></i> <span data-i18n="کپی">کپی</span></button></div>
                    <div style="height:8px"></div>
                    <div class="label"><span data-i18n="لینک Base64">لینک Base64</span></div>
                    <div class="linkrow"><div id="base64Link" class="code">-</div><button id="copyBase64Btn" class="btn small"><i data-lucide="copy"></i> <span data-i18n="کپی">کپی</span></button></div>
                    <button id="openRawBtn" class="btn full"><i data-lucide="external-link"></i> <span data-i18n="تست لینک Raw">تست لینک Raw</span></button>
                  </div>
                </div>

                <div class="field">
                  <label class="label" for="copySourceUser"><span data-i18n="کپی کانفیگ از کاربر دیگر">کپی کانفیگ از کاربر دیگر</span></label>
                  <select id="copySourceUser" class="select"></select>
                  <p class="muted"><span data-i18n="کانفیگ‌های کاربر منبع جایگزین می‌شوند. کانفیگ فعلی در بکاپ ذخیره می‌شود.">کانفیگ‌های کاربر منبع جایگزین می‌شوند. کانفیگ فعلی در بکاپ ذخیره می‌شود.</span></p>
                  <button id="copyUserConfigsBtn" class="btn"><i data-lucide="copy"></i> <span data-i18n="کپی کانفیگ‌ها">کپی کانفیگ‌ها</span></button>
                </div>
                <div style="height:16px"></div>
                <div class="stats">
                  <div class="stat"><span><span data-i18n="کل کانفیگ">کل کانفیگ</span></span><strong id="statTotal">0</strong></div>
                  <div class="stat"><span><span data-i18n="شناخته‌شده">شناخته‌شده</span></span><strong id="statValid">0</strong></div>
                  <div class="stat"><span><span data-i18n="نامشخص">نامشخص</span></span><strong id="statUnknown">0</strong></div>
                  <div class="stat"><span><span data-i18n="تکراری محتوایی">تکراری محتوایی</span></span><strong id="statDupContent">0</strong></div>
                </div>

                <input id="fileInput" class="hidden" type="file" accept=".txt,.conf,.json,.yaml,.yml,text/plain" />
                <div id="dropArea" class="drop"><span data-i18n="فایل را اینجا بکشید و رها کنید، یا روی «آپلود فایل» بزنید. متن فایل داخل باکس زیر نمایش داده می‌شود.">فایل را اینجا بکشید و رها کنید، یا روی «آپلود فایل» بزنید. متن فایل داخل باکس زیر نمایش داده می‌شود.</span></div>
                <div class="checks">
                  <label><input id="normalizeCheck" type="checkbox" checked /> <span data-i18n="حذف خطوط خالی و فاصله‌های اضافی">حذف خطوط خالی و فاصله‌های اضافی</span></label>
                  <label><input id="dedupeCheck" type="checkbox" checked /> <span data-i18n="حذف کانفیگ‌های تکراری حتی با نام متفاوت">حذف کانفیگ‌های تکراری حتی با نام متفاوت</span></label>
                </div>
                <textarea id="configsText" class="textarea" spellcheck="false"></textarea>
              </div>
            </div>

            <div id="bulkPanel" class="panel">
              <div class="card">
                <div class="card-title">
                  <h2><span data-i18n="اعمال گروهی کانفیگ">اعمال گروهی کانفیگ</span></h2>
                  <div class="toolbar" id="bulkTextToolbar">
                    <button id="bulkFileBtn" class="btn"><i data-lucide="upload"></i> <span data-i18n="آپلود فایل">آپلود فایل</span></button>
                    <button id="bulkCleanBtn" class="btn"><i data-lucide="sparkles"></i> <span data-i18n="پاک‌سازی">پاک‌سازی</span></button>
                  </div>
                </div>
                <p class="muted"><span data-i18n="در این بخش می‌توانید یک مجموعه کانفیگ را برای همه کاربران یا فقط کاربران انتخاب‌شده اعمال کنید. منبع کانفیگ می‌تواند متن، فایل یا کانفیگ‌های یک کاربر دیگر باشد.">در این بخش می‌توانید یک مجموعه کانفیگ را برای همه کاربران یا فقط کاربران انتخاب‌شده اعمال کنید. منبع کانفیگ می‌تواند متن، فایل یا کانفیگ‌های یک کاربر دیگر باشد.</span></p>
                <div class="grid2">
                  <div class="field">
                    <label class="label"><span data-i18n="نوع اعمال">نوع اعمال</span></label>
                    <select id="bulkMode" class="select">
                      <option value="replace" data-i18n="جایگزینی کامل کانفیگ کاربران">جایگزینی کامل کانفیگ کاربران</option>
                      <option value="append" data-i18n="افزودن به کانفیگ فعلی کاربران">افزودن به کانفیگ فعلی کاربران</option>
                    </select>
                  </div>
                  <div class="field">
                    <label class="label"><span data-i18n="محدوده اعمال">محدوده اعمال</span></label>
                    <select id="bulkTarget" class="select">
                      <option value="all" data-i18n="همه کاربران">همه کاربران</option>
                      <option value="selected" data-i18n="فقط کاربران انتخاب‌شده">فقط کاربران انتخاب‌شده</option>
                    </select>
                  </div>
                </div>
                <div id="bulkUsersBox" class="checks"></div>
                <div class="grid2" style="margin-top:4px;margin-bottom:12px">
                  <div class="field">
                    <label class="label"><span data-i18n="منبع کانفیگ">منبع کانفیگ</span></label>
                    <select id="bulkSourceType" class="select">
                      <option value="text" data-i18n="متن / فایل">متن / فایل</option>
                      <option value="user" data-i18n="از کانفیگ‌های کاربر دیگر">از کانفیگ‌های کاربر دیگر</option>
                    </select>
                  </div>
                  <div class="field" id="bulkSourceUserField" style="display:none">
                    <label class="label"><span data-i18n="کاربر منبع">کاربر منبع</span></label>
                    <select id="bulkSourceUser" class="select"></select>
                  </div>
                </div>
                <div id="bulkTextInputBox">
                  <input id="bulkFileInput" class="hidden" type="file" accept=".txt,.conf,.json,.yaml,.yml,text/plain" />
                  <div id="bulkDropArea" class="drop"><span data-i18n="فایل را اینجا بکشید و رها کنید، یا روی «آپلود فایل» بزنید. متن فایل داخل باکس زیر نمایش داده می‌شود.">فایل را اینجا بکشید و رها کنید، یا روی «آپلود فایل» بزنید. متن فایل داخل باکس زیر نمایش داده می‌شود.</span></div>
                  <textarea id="bulkConfigsText" class="textarea small" spellcheck="false"></textarea>
                </div>
                <button id="applyBulkBtn" class="btn success full"><i data-lucide="check-circle"></i> <span data-i18n="اعمال کانفیگ‌ها">اعمال کانفیگ‌ها</span></button>
              </div>
            </div>

            <div id="securityPanel" class="panel">
              <div class="card">
                <div class="card-title"><h2><span data-i18n="تغییر رمز عبور پنل">تغییر رمز عبور پنل</span></h2></div>
                <div class="grid2">
                  <div class="field">
                    <label class="label"><span data-i18n="رمز عبور فعلی">رمز عبور فعلی</span></label>
                    <input id="currentPassword" class="input rtl" type="password" />
                  </div>
                  <div class="field">
                    <label class="label"><span data-i18n="رمز عبور جدید">رمز عبور جدید</span></label>
                    <input id="newPassword" class="input rtl" type="password" />
                  </div>
                </div>
                <button id="changePasswordBtn" class="btn primary full"><i data-lucide="lock"></i> <span data-i18n="تغییر رمز عبور">تغییر رمز عبور</span></button>
                <p id="passwordMode" class="muted" style="margin-top:14px"></p>
              </div>
            </div>

            <div id="telegramPanel" class="panel">
              <div class="card">
                <div class="card-title"><h2><span data-i18n="اتصال ربات تلگرام">اتصال ربات تلگرام</span></h2></div>
                <p class="muted"><span data-i18n="توکن بات و شناسه عددی ادمین را وارد کنید. بعد از ذخیره، وبهوک، دکمه‌های ربات و لیست کامندها تنظیم می‌شوند. برای دکمه آبی Open کنار پروفایل ربات، همین آدرس مینی‌اپ را در BotFather بخش /myapps ثبت کنید.">توکن بات و شناسه عددی ادمین را وارد کنید. بعد از ذخیره، وبهوک، دکمه‌های ربات و لیست کامندها تنظیم می‌شوند. برای دکمه آبی Open کنار پروفایل ربات، همین آدرس مینی‌اپ را در BotFather بخش /myapps ثبت کنید.</span></p>
                <div class="grid2">
                  <div class="field">
                    <label class="label"><span data-i18n="توکن بات تلگرام">توکن بات تلگرام</span></label>
                    <input id="telegramBotToken" class="input ltr" placeholder="123456:ABC..." />
                  </div>
                  <div class="field">
                    <label class="label"><span data-i18n="شناسه عددی ادمین">شناسه عددی ادمین</span></label>
                    <input id="telegramAdminId" class="input ltr" placeholder="مثلاً 123456789" data-i18n-placeholder="مثلاً 123456789" />
                  </div>
                </div>
                <div class="checks"><label><input id="telegramEnabled" type="checkbox" /> <span data-i18n="ربات فعال باشد">ربات فعال باشد</span></label></div>
                <div class="toolbar">
                  <button id="saveTelegramBtn" class="btn primary"><i data-lucide="zap"></i> <span data-i18n="ذخیره و فعال‌سازی وبهوک">ذخیره و فعال‌سازی وبهوک</span></button>
                  <button id="testTelegramBtn" class="btn"><i data-lucide="send"></i> <span data-i18n="ارسال پیام تست">ارسال پیام تست</span></button>
                </div>
                <div style="height:14px"></div>
                <div class="label"><span data-i18n="آدرس وبهوک">آدرس وبهوک</span></div>
                <div id="telegramWebhook" class="code">-</div>
                <div style="height:14px"></div>
                <div class="label"><span data-i18n="آدرس مینی‌اپ">آدرس مینی‌اپ</span></div>
                <div class="linkrow">
                  <div id="telegramMiniApp" class="code">-</div>
                  <button id="copyMiniAppBtn" class="btn small"><i data-lucide="copy"></i> <span data-i18n="کپی">کپی</span></button>
                </div>
                <div style="height:14px"></div>
                <div class="card" style="background:rgba(3,8,20,.32)">
                  <h3><span data-i18n="نمونه دستورهای ربات">نمونه دستورهای ربات</span></h3>
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

    var translations = {
      "پنل مدیریت کانفیگ‌ها": "Config management panel",
      "رمز عبور": "Password",
      "ورود به پنل": "Sign in",
      "مدیریت پیشرفته کانفیگ‌ها": "Advanced config management",
      "کاربر ایجاد کنید، کانفیگ اختصاصی بدهید، تنظیمات گروهی اعمال کنید و ربات تلگرام را متصل کنید.": "Create users, manage their configs, apply bulk changes, and connect your Telegram bot.",
      "بارگذاری مجدد": "Refresh",
      "خروج": "Sign out",
      "بخش‌ها": "Sections",
      "کاربران": "Users",
      "کانفیگ اختصاصی کاربر": "User configs",
      "اعمال گروهی کانفیگ": "Bulk config update",
      "امنیت و رمز عبور": "Security and password",
      "ربات تلگرام": "Telegram bot",
      "ایجاد کاربر": "Create user",
      "نام کاربر": "User name",
      "مثلاً موبایل، لپ‌تاپ، کاربر ۱": "e.g. Mobile, Laptop, User 1",
      "کپی کانفیگ از کاربر دیگر (اختیاری)": "Copy configs from another user (optional)",
      "آپلود فایل": "Upload file",
      "پاک‌سازی": "Clean up",
      "دانلود TXT": "Download TXT",
      "بازیابی بکاپ": "Restore backup",
      "ذخیره کانفیگ‌ها": "Save configs",
      "انتخاب کاربر": "Select user",
      "کاربر فعال باشد": "Enable user",
      "ذخیره مشخصات": "Save details",
      "ساخت توکن جدید": "Regenerate token",
      "حذف کاربر": "Delete user",
      "لینک Raw": "Raw link",
      "کپی": "Copy",
      "لینک Base64": "Base64 link",
      "تست لینک Raw": "Test Raw link",
      "کپی کانفیگ از کاربر دیگر": "Copy configs from another user",
      "کانفیگ‌های کاربر منبع جایگزین می‌شوند. کانفیگ فعلی در بکاپ ذخیره می‌شود.": "The source user's configs will replace this user's configs. Current configs will be backed up.",
      "کپی کانفیگ‌ها": "Copy configs",
      "کل کانفیگ": "Total configs",
      "شناخته‌شده": "Recognized",
      "نامشخص": "Unknown",
      "تکراری محتوایی": "Content duplicates",
      "فایل را اینجا بکشید و رها کنید، یا روی «آپلود فایل» بزنید. متن فایل داخل باکس زیر نمایش داده می‌شود.": "Drop a file here or click Upload file. Its contents will appear in the box below.",
      "حذف خطوط خالی و فاصله‌های اضافی": "Remove empty lines and extra whitespace",
      "حذف کانفیگ‌های تکراری حتی با نام متفاوت": "Remove duplicate configs, including those with different names",
      "در این بخش می‌توانید یک مجموعه کانفیگ را برای همه کاربران یا فقط کاربران انتخاب‌شده اعمال کنید. منبع کانفیگ می‌تواند متن، فایل یا کانفیگ‌های یک کاربر دیگر باشد.": "Apply configs to all users or selected users. Use text, a file, or another user's configs as the source.",
      "نوع اعمال": "Update mode",
      "جایگزینی کامل کانفیگ کاربران": "Replace all configs",
      "افزودن به کانفیگ فعلی کاربران": "Append to existing configs",
      "محدوده اعمال": "Apply to",
      "همه کاربران": "All users",
      "فقط کاربران انتخاب‌شده": "Selected users only",
      "منبع کانفیگ": "Config source",
      "متن / فایل": "Text / file",
      "از کانفیگ‌های کاربر دیگر": "Another user's configs",
      "کاربر منبع": "Source user",
      "اعمال کانفیگ‌ها": "Apply configs",
      "تغییر رمز عبور پنل": "Change panel password",
      "رمز عبور فعلی": "Current password",
      "رمز عبور جدید": "New password",
      "تغییر رمز عبور": "Change password",
      "اتصال ربات تلگرام": "Connect Telegram bot",
      "توکن بات و شناسه عددی ادمین را وارد کنید. بعد از ذخیره، وبهوک، دکمه‌های ربات و لیست کامندها تنظیم می‌شوند. برای دکمه آبی Open کنار پروفایل ربات، همین آدرس مینی‌اپ را در BotFather بخش /myapps ثبت کنید.": "Enter the bot token and numeric admin ID. Saving configures the webhook, bot buttons, and commands. For the blue Open button on the bot profile, register this Mini App URL in BotFather under /myapps.",
      "توکن بات تلگرام": "Telegram bot token",
      "شناسه عددی ادمین": "Numeric admin ID",
      "مثلاً 123456789": "e.g. 123456789",
      "ربات فعال باشد": "Enable bot",
      "ذخیره و فعال‌سازی وبهوک": "Save and activate webhook",
      "ارسال پیام تست": "Send test message",
      "آدرس وبهوک": "Webhook URL",
      "آدرس مینی‌اپ": "Mini App URL",
      "نمونه دستورهای ربات": "Example bot commands",
      "ورود خودکار تلگرام انجام نشد.": "Telegram automatic sign-in failed.",
      "پاسخ سرور نامعتبر است.": "Invalid server response.",
      "درخواست ناموفق بود.": "Request failed.",
      "رمز عبور اختصاصی برای پنل ثبت شده است.": "A custom panel password is set.",
      "رمز اولیه از Secret با نام ADMIN_PASSWORD تنظیم می‌شود.": "The initial password is configured with the ADMIN_PASSWORD secret.",
      "هنوز کاربری ایجاد نشده است.": "No users have been created yet.",
      "فعال": "Enabled",
      "غیرفعال": "Disabled",
      "بدون کپی کانفیگ": "Do not copy configs",
      "انتخاب کاربر منبع": "Select source user",
      "کانفیگ فعلی و تغییرات ذخیره‌نشده با کانفیگ کاربر منبع جایگزین شوند؟": "Replace current configs and unsaved changes with the source user's configs?",
      "رمز عبور را وارد کنید.": "Enter your password.",
      "از پنل خارج شدید.": "You have signed out.",
      "برای این کاربر توکن جدید ساخته شود؟ لینک قبلی از کار می‌افتد.": "Regenerate this user's token? The previous link will stop working.",
      "این کاربر و کانفیگ‌های او حذف شود؟": "Delete this user and their configs?",
      "متن پاک‌سازی شد.": "Text cleaned up.",
      "آخرین بکاپ این کاربر بازیابی شود؟": "Restore this user's latest backup?",
      "دانلود ناموفق بود.": "Download failed.",
      "لینکی برای کپی وجود ندارد.": "There is no link to copy.",
      "کپی شد.": "Copied.",
      "حجم فایل بیشتر از ۵ مگابایت است.": "The file is larger than 5 MB.",
      "محتوای فایل داخل باکس قرار گرفت.": "File contents loaded into the text box.",
      "رمز عبور نادرست است.": "Incorrect password.",
      "رمز عبور فعلی نادرست است.": "Incorrect current password.",
      "رمز عبور جدید باید حداقل ۸ کاراکتر باشد.": "The new password must contain at least 8 characters.",
      "رمز عبور با موفقیت تغییر کرد.": "Password changed successfully.",
      "نام کاربر را وارد کنید.": "Enter a user name.",
      "کاربر ایجاد شد.": "User created.",
      "کاربر پیدا نشد.": "User not found.",
      "نام کاربر نمی‌تواند خالی باشد.": "The user name cannot be empty.",
      "اطلاعات کاربر ذخیره شد.": "User details saved.",
      "کاربر حذف شد.": "User deleted.",
      "کانفیگ‌های کاربر ذخیره شد.": "User configs saved.",
      "کاربر منبع باید متفاوت باشد.": "The source user must be different.",
      "کانفیگ‌ها از کاربر منبع کپی شدند.": "Configs copied from the source user.",
      "برای این کاربر بکاپی وجود ندارد.": "No backup exists for this user.",
      "آخرین بکاپ این کاربر بازیابی شد.": "This user's latest backup was restored.",
      "حداقل یک کاربر را انتخاب کنید.": "Select at least one user.",
      "کاربر منبع یافت نشد.": "Source user not found.",
      "کاربر منبع فاقد کانفیگ است.": "The source user has no configs.",
      "کانفیگ قابل اعمال وارد نشده است.": "Enter configs to apply.",
      "کانفیگ‌ها برای کاربران انتخاب‌شده اعمال شد.": "Configs applied to the selected users.",
      "توکن بات و شناسه عددی ادمین را وارد کنید.": "Enter the bot token and numeric admin ID.",
      "تنظیمات تلگرام کامل یا فعال نیست.": "Telegram settings are incomplete or disabled.",
      "پیام تست ارسال شد.": "Test message sent.",
      "دسترسی غیرمجاز است.": "Unauthorized access.",
      "خطای داخلی Worker": "Internal Worker error",
      "حجم کانفیگ‌ها برای این پنل بیش از ۵ مگابایت است.": "Configs exceed the panel's 5 MB limit.",
      "لیست کانفیگ خالی است.": "The config list is empty.",
      "فایل معتبر نیست.": "Invalid file.",
      "دریافت فایل از تلگرام ناموفق بود.": "Failed to retrieve the file from Telegram.",
      "دانلود فایل از تلگرام ناموفق بود.": "Failed to download the file from Telegram.",
      "توکن ذخیره شده": "Saved token",
      "تغییر به تم روشن": "Switch to light theme",
      "تغییر به تم تاریک": "Switch to dark theme",
      "تنظیمات تلگرام ذخیره و وبهوک فعال شد.": "Telegram settings saved and webhook activated.",
      "تنظیمات تلگرام ذخیره شد.": "Telegram settings saved."
};
    function readPreference(key, fallback) {
      try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
    }
    function savePreference(key, value) {
      try { localStorage.setItem(key, value); } catch (e) {}
    }
    var language = readPreference("config_pilot_language", "fa") === "en" ? "en" : "fa";
    var theme = readPreference("config_pilot_theme", "dark") === "light" ? "light" : "dark";
    function t(text) { return language === "en" ? (translations[text] || text) : text; }
    function applyPreferences() {
      document.documentElement.lang = language;
      document.documentElement.dir = language === "fa" ? "rtl" : "ltr";
      document.documentElement.dataset.theme = theme;
      document.querySelectorAll("[data-i18n]").forEach(function(el) { el.textContent = t(el.dataset.i18n); });
      document.querySelectorAll("[data-i18n-placeholder]").forEach(function(el) { el.placeholder = t(el.dataset.i18nPlaceholder); });
      var languageBtn = $("languageToggle");
      languageBtn.textContent = language === "fa" ? "🌐 EN" : "🌐 فا";
      languageBtn.title = language === "fa" ? "Switch to English" : "تغییر زبان به فارسی";
      languageBtn.setAttribute("aria-label", languageBtn.title);
      var themeBtn = $("themeToggle");
      themeBtn.innerHTML = '<i data-lucide="' + (theme === "light" ? "moon" : "sun") + '"></i>';
      themeBtn.title = t(theme === "light" ? "تغییر به تم تاریک" : "تغییر به تم روشن");
      themeBtn.setAttribute("aria-label", themeBtn.title);
      if (typeof lucide !== "undefined") lucide.createIcons();
      if (users) {
        renderUsers();
        renderCopySources();
        $("passwordMode").textContent = t(adminPasswordChanged ? "رمز عبور اختصاصی برای پنل ثبت شده است." : "رمز اولیه از Secret با نام ADMIN_PASSWORD تنظیم می‌شود.");
      }
      if (telegramWebApp) {
        try {
          telegramWebApp.setHeaderColor(theme === "light" ? "#f3f5fc" : "#070a12");
          telegramWebApp.setBackgroundColor(theme === "light" ? "#f3f5fc" : "#070a12");
        } catch (e) {}
      }
    }
    $("languageToggle").addEventListener("click", function() {
      language = language === "fa" ? "en" : "fa";
      savePreference("config_pilot_language", language);
      applyPreferences();
    });
    $("themeToggle").addEventListener("click", function() {
      theme = theme === "dark" ? "light" : "dark";
      savePreference("config_pilot_theme", theme);
      applyPreferences();
    });

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
      $("passwordInput").placeholder = t("رمز عبور");
      toast(message || t("ورود خودکار تلگرام انجام نشد."), "err");
    }

    var adminPasswordChanged = false;
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
      try { data = await res.json(); } catch (e) { data = { ok: false, error: t("پاسخ سرور نامعتبر است.") }; }
      if (!res.ok || !data.ok) throw new Error(data.error || t("درخواست ناموفق بود."));
      return data;
    }

    function showLogin() { $("loginView").classList.remove("hidden"); $("dashboardView").classList.add("hidden"); $("passwordInput").focus(); }
    function showDashboard() { $("loginView").classList.add("hidden"); $("dashboardView").classList.remove("hidden"); }

    function toast(message, type) {
      var box = document.createElement("div");
      box.className = "toast-item " + (type === "err" ? "err" : "ok");
      box.textContent = t(message);
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
      if (!users.some(function(user) { return user.id === currentUserId; })) currentUserId = users.length ? users[0].id : "";
      if (!currentUserId) {
        $("configsText").value = "";
        $("editUserName").value = "";
        setLinks(null);
        updateStats();
      }
      renderUsers();
      renderSelects();
      renderBulkUsers();
      renderTelegram(data.telegram || {});
      adminPasswordChanged = data.adminPasswordChanged;
      $("passwordMode").textContent = adminPasswordChanged ? t("رمز عبور اختصاصی برای پنل ثبت شده است.") : t("رمز اولیه از Secret با نام ADMIN_PASSWORD تنظیم می‌شود.");
      if (!currentUserId && users.length) currentUserId = users[0].id;
      if (currentUserId) await loadUserConfigs(currentUserId);
    }

    function renderUsers() {
      var box = $("usersList");
      box.innerHTML = "";
      if (!users.length) {
        box.innerHTML = '<p class="muted">' + t("هنوز کاربری ایجاد نشده است.") + '</p>';
        return;
      }
      users.forEach(function(user) {
        var item = document.createElement("div");
        item.className = "user-item" + (user.id === currentUserId ? " active" : "");
        item.innerHTML = "<strong>" + escapeHtml(user.name) + "</strong><span>" + (user.enabled ? t("فعال") : t("غیرفعال")) + " · " + user.id + "</span>";
        item.addEventListener("click", async function() { currentUserId = user.id; switchTab("configsPanel"); await loadUserConfigs(user.id); renderUsers(); renderSelects(); });
        box.appendChild(item);
      });
    }

    function renderCopySources() {
      ["newUserSource", "copySourceUser"].forEach(function(id) {
        var select = $(id);
        var previous = select.value;
        select.replaceChildren(new Option(t(id === "newUserSource" ? "بدون کپی کانفیگ" : "انتخاب کاربر منبع"), ""));
        users.forEach(function(user) {
          if (id === "copySourceUser" && user.id === currentUserId) return;
          select.add(new Option(user.name, user.id));
        });
        if (Array.from(select.options).some(function(opt) { return opt.value === previous; })) select.value = previous;
        select.disabled = select.options.length === 1;
      });
      $("copyUserConfigsBtn").disabled = !currentUserId || !$("copySourceUser").value;
    }

    $("copySourceUser").addEventListener("change", function() {
      $("copyUserConfigsBtn").disabled = !currentUserId || !this.value;
    });
    $("copyUserConfigsBtn").addEventListener("click", async function() {
      var id = currentUserId;
      var sourceUserId = $("copySourceUser").value;
      if (!id || !sourceUserId) return;
      if (!confirm(t("کانفیگ فعلی و تغییرات ذخیره‌نشده با کانفیگ کاربر منبع جایگزین شوند؟"))) return;
      this.disabled = true;
      try {
        var data = await api("/api/admin/users/configs/copy", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: id, sourceUserId: sourceUserId })
        });
        await refreshState();
        toast(data.message);
      } catch (err) { toast(err.message, "err"); }
      finally { renderCopySources(); }
    });

    function renderSelects() {
      renderCopySources();
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
      var sourceSelect = $("bulkSourceUser");
      sourceSelect.innerHTML = "";
      users.forEach(function(user) {
        var label = document.createElement("label");
        label.innerHTML = '<input type="checkbox" class="bulk-user" value="' + user.id + '" /> ' + escapeHtml(user.name);
        box.appendChild(label);
        var opt = document.createElement("option");
        opt.value = user.id;
        opt.textContent = user.name;
        sourceSelect.appendChild(opt);
      });
    }

    function renderTelegram(tg) {
      $("telegramEnabled").checked = tg.enabled === true;
      $("telegramAdminId").value = tg.adminChatId || "";
      $("telegramBotToken").dataset.i18nPlaceholder = tg.botTokenSaved ? "توکن ذخیره شده" : "123456:ABC...";
      $("telegramBotToken").placeholder = t($("telegramBotToken").dataset.i18nPlaceholder);
      $("telegramWebhook").textContent = tg.webhookUrl || "-";
      $("telegramMiniApp").textContent = tg.miniAppUrl || (location.origin + "/tg-app");
    }

    async function loadUserConfigs(id) {
      if (!id) return;
      currentUserId = id;
      renderCopySources();
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
      if (!password) return toast(t("رمز عبور را وارد کنید."), "err");
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
        var data = await api("/api/admin/users/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name, sourceUserId: $("newUserSource").value }) });
        $("newUserName").value = "";
        $("newUserSource").value = "";
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
      if (!confirm(t("برای این کاربر توکن جدید ساخته شود؟ لینک قبلی از کار می‌افتد."))) return;
      try {
        var data = await api("/api/admin/users/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: currentUserId, regenerateToken: true }) });
        await refreshState();
        toast(data.message);
      } catch (err) { toast(err.message, "err"); }
    });

    $("deleteUserBtn").addEventListener("click", async function() {
      if (!currentUserId) return;
      if (!confirm(t("این کاربر و کانفیگ‌های او حذف شود؟"))) return;
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
      if (!confirm(t("آخرین بکاپ این کاربر بازیابی شود؟"))) return;
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
        if (!res.ok) throw new Error(t("دانلود ناموفق بود."));
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
      if (!text) return toast(t("لینکی برای کپی وجود ندارد."), "err");
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
      if (file.size > 5 * 1024 * 1024) return toast(t("حجم فایل بیشتر از ۵ مگابایت است."), "err");
      textarea.value = await file.text();
      updateStats();
      toast("محتوای فایل داخل باکس قرار گرفت.");
    }

    var dropArea = $("dropArea");
    ["dragenter", "dragover"].forEach(function(name) { dropArea.addEventListener(name, function(e) { e.preventDefault(); dropArea.classList.add("drag"); }); });
    ["dragleave", "drop"].forEach(function(name) { dropArea.addEventListener(name, function(e) { e.preventDefault(); dropArea.classList.remove("drag"); }); });
    dropArea.addEventListener("drop", async function(e) { var file = e.dataTransfer.files && e.dataTransfer.files[0]; if (file) await readFileIntoTextarea(file, $("configsText")); });
    dropArea.addEventListener("click", function() { $("fileInput").click(); });

    $("bulkSourceType").addEventListener("change", function() {
      var isUser = this.value === "user";
      $("bulkSourceUserField").style.display = isUser ? "" : "none";
      $("bulkTextInputBox").style.display = isUser ? "none" : "";
      $("bulkTextToolbar").style.display = isUser ? "none" : "";
    });

    $("bulkFileBtn").addEventListener("click", function() { $("bulkFileInput").click(); });
    $("bulkFileInput").addEventListener("change", async function(e) {
      var file = e.target.files && e.target.files[0];
      if (file) await readFileIntoTextarea(file, $("bulkConfigsText"));
      e.target.value = "";
    });

    $("bulkCleanBtn").addEventListener("click", function() { $("bulkConfigsText").value = normalizeText($("bulkConfigsText").value, true); toast("متن پاک‌سازی شد."); });

    var bulkDropArea = $("bulkDropArea");
    ["dragenter", "dragover"].forEach(function(name) { bulkDropArea.addEventListener(name, function(e) { e.preventDefault(); bulkDropArea.classList.add("drag"); }); });
    ["dragleave", "drop"].forEach(function(name) { bulkDropArea.addEventListener(name, function(e) { e.preventDefault(); bulkDropArea.classList.remove("drag"); }); });
    bulkDropArea.addEventListener("drop", async function(e) { var file = e.dataTransfer.files && e.dataTransfer.files[0]; if (file) await readFileIntoTextarea(file, $("bulkConfigsText")); });
    bulkDropArea.addEventListener("click", function() { $("bulkFileInput").click(); });

    $("applyBulkBtn").addEventListener("click", async function() {
      try {
        var checked = Array.from(document.querySelectorAll(".bulk-user:checked")).map(function(x) { return x.value; });
        var isUserSource = $("bulkSourceType").value === "user";
        var body = { target: $("bulkTarget").value, userIds: checked, mode: $("bulkMode").value };
        if (isUserSource) {
          body.sourceUserId = $("bulkSourceUser").value;
        } else {
          body.configs = $("bulkConfigsText").value;
        }
        var data = await api("/api/admin/bulk/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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

    applyPreferences();

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

    if (typeof lucide !== "undefined") lucide.createIcons();
  </script>
</body>
</html>`;
