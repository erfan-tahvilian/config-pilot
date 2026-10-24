import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

const adminId = "12345";
function fixture(context) {
  const settings = { enabled: true, botToken: "test-bot", adminChatId: adminId, webhookSecret: "test-secret" };
  const store = new Map([["telegram_settings_v1", JSON.stringify(settings)]]);
  const calls = [];
  const env = { ADMIN_PASSWORD: "test-admin-password", CONFIGS_KV: {
    get: async key => store.get(key) ?? null,
    put: async (key, value) => { store.set(key, value); },
    delete: async key => { store.delete(key); },
  } };
  context.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
    if (String(url).includes("/getFile?")) return Response.json({ ok: true, result: { file_path: "configs/test.txt" } });
    if (String(url).includes("/file/bot")) return new Response("vless://file@host:443#نام کانفیگ");
    return Response.json({ ok: true, result: { message_id: 42 } });
  });
  async function update(body, secret = "test-secret") {
    const response = await worker.fetch(new Request("https://panel.test/telegram/webhook/" + secret, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), env);
    assert.equal(response.status, 200);
  }
  const message = (text, id = adminId) => update({ message: { chat: { id }, text } });
  const callback = (data, id = adminId) => update({ callback_query: { id: "callback", from: { id }, message: { message_id: 42, chat: { id } }, data } });
  const outgoing = () => calls.filter(call => /\/(sendMessage|editMessageText)$/.test(call.url));
  const last = () => outgoing().at(-1).body;
  const api = async (path, body) => {
    const response = await worker.fetch(new Request("https://panel.test" + path, {
      method: "POST", headers: { authorization: "Bearer test-admin-password", "content-type": "application/json" }, body: JSON.stringify(body),
    }), env);
    assert.equal(response.status, 200);
    return response.json();
  };
  return { store, calls, env, update, message, callback, outgoing, last, api };
}

test("bot defaults to Persian and offers an accessible bilingual language selector", async context => {
  const f = fixture(context);
  await f.message("/start");
  assert.match(f.last().text, /ربات مدیریت/);
  assert.ok(f.last().reply_markup.inline_keyboard.flat().some(button => button.callback_data === "tg:language"));
  await f.message("/language");
  assert.match(f.last().text, /Choose the bot language/);
  assert.deepEqual(f.last().reply_markup.inline_keyboard[0].map(button => button.callback_data), ["tg:language:fa", "tg:language:en"]);
  assert.equal(f.store.has("telegram_language:" + adminId), false);
});

test("language callbacks persist selection, refresh commands and keyboards, and survive subsequent webhooks", async context => {
  const f = fixture(context);
  await f.callback("tg:language:en");
  assert.equal(f.store.get("telegram_language:" + adminId), "en");
  assert.match(f.last().text, /config management bot is active/);
  assert.ok(f.outgoing().some(call => call.body.reply_markup?.keyboard?.flat().some(button => button.text === "👥 Users")));
  const commandCalls = f.calls.filter(call => call.url.endsWith("/setMyCommands"));
  assert.equal(commandCalls.length, 3);
  for (const call of commandCalls) {
    assert.ok(call.body.commands.some(command => command.command === "language"));
    assert.equal(/[\u0600-\u06ff]/.test(JSON.stringify(call.body.commands)), false);
  }
  await f.message("/help");
  assert.match(f.last().text, /Bot management help/);
  await f.message("/commands");
  assert.match(f.last().text, /\/language - Change bot language/);
  assert.equal(/[\u0600-\u06ff]/.test(f.last().text), false);
  await f.message("/file");
  assert.match(f.last().text, /Config file upload help/);
  assert.equal(/[\u0600-\u06ff]/.test(f.last().text), false);
  await f.message("👥 Users");
  assert.equal(f.last().text, "No users have been created yet.");
  await f.message("👥 کاربران");
  assert.equal(f.last().text, "No users have been created yet.");
  await f.callback("tg:language:fa");
  await f.message("/help");
  assert.match(f.last().text, /راهنمای مدیریت ربات/);
});

test("switching languages preserves pending operations and never translates user names or config contents", async context => {
  const f = fixture(context);
  await f.message("/newuser");
  const stateBefore = f.store.get("telegram_state:" + adminId);
  await f.message("/language en");
  assert.equal(f.store.get("telegram_state:" + adminId), stateBefore);
  await f.message("کاربر: نام فارسی");
  assert.match(f.last().text, /User created\.\nName: کاربر: نام فارسی/);
  const user = JSON.parse(f.store.get("users_v2"))[0];
  await f.callback("tg:user:" + user.id);
  assert.match(f.last().text, /User: کاربر: نام فارسی/);
  assert.ok(f.last().reply_markup.inline_keyboard.flat().some(button => button.text === "✏️ Rename"));
  await f.message("/setconfigs " + user.id + "\nvless://id@host:443#نام فارسی");
  assert.match(f.last().text, /Configs for کاربر: نام فارسی saved\./);
  await f.message("/configs " + user.id);
  assert.match(f.last().text, /vless:\/\/id@host:443#نام فارسی/);
  await f.callback("tg:user_rename:" + user.id);
  await f.message("New name");
  assert.equal(f.last().text, "User renamed: New name");
  await f.message("/newuser");
  await f.message("❌ Cancel");
  assert.equal(f.last().text, "Current operation cancelled.");
  assert.equal(f.store.has("telegram_state:" + adminId), false);
});

test("file uploads, bulk prompts, validation errors and test messages use the stored bot language", async context => {
  const f = fixture(context);
  await f.message("/language en");
  const { user } = await f.api("/api/admin/users/create", { name: "Test" });
  await f.update({ message: { chat: { id: adminId }, document: { file_id: "file", file_size: 100 }, caption: "/setconfigs " + user.id } });
  assert.match(f.last().text, /Configs for Test saved\./);
  assert.equal(f.store.get("user_configs:" + user.id), "vless://file@host:443#نام کانفیگ");
  await f.update({ message: { chat: { id: adminId }, document: { file_id: "large", file_size: 6 * 1024 * 1024 } } });
  assert.equal(f.last().text, "The file is larger than 5 MB.");
  await f.callback("tg:bulk_menu");
  assert.equal(f.last().text, "Choose a bulk update mode:");
  assert.ok(f.last().reply_markup.inline_keyboard.flat().some(button => button.text === "Append for all"));
  await f.callback("tg:bulk_all:append");
  assert.match(f.last().text, /Configs to append to all users/);
  await f.message("/cancel");
  await f.api("/api/admin/telegram/test", {});
  assert.match(f.last().text, /Telegram bot connected successfully/);
  await f.api("/api/admin/telegram/save", { enabled: true, adminChatId: adminId });
  assert.match(f.last().text, /config management bot is active/);
  assert.equal(f.store.get("telegram_language:" + adminId), "en");
  assert.equal(f.calls.filter(call => call.url.endsWith("/setMyCommands")).at(-1).body.commands[0].description, "Change language: Persian / English");
  await f.message("/language fa");
  await f.api("/api/admin/telegram/test", {});
  assert.match(f.last().text, /اتصال ربات تلگرام/);
});

test("unauthorized senders cannot change the language and independent concurrent webhooks do not leak language", async context => {
  const f = fixture(context);
  await f.message("/language en", "intruder");
  await f.callback("tg:language:en", "intruder");
  assert.equal(f.store.has("telegram_language:" + adminId), false);
  assert.equal(f.calls.filter(call => call.url.endsWith("/setMyCommands")).length, 0);
  const otherSettings = { enabled: true, botToken: "other-bot", adminChatId: "67890", webhookSecret: "other-secret" };
  const otherStore = new Map([["telegram_settings_v1", JSON.stringify(otherSettings)], ["telegram_language:67890", "en"]]);
  const otherEnv = { CONFIGS_KV: { get: async key => otherStore.get(key) ?? null, put: async (key, value) => otherStore.set(key, value), delete: async key => otherStore.delete(key) } };
  await Promise.all([
    f.message("/help"),
    worker.fetch(new Request("https://panel.test/telegram/webhook/other-secret", {
      method: "POST", body: JSON.stringify({ message: { chat: { id: "67890" }, text: "/help" } }),
    }), otherEnv),
  ]);
  const first = f.outgoing().find(call => String(call.body.chat_id) === adminId);
  const other = f.outgoing().find(call => String(call.body.chat_id) === "67890");
  assert.match(first.body.text, /راهنمای مدیریت ربات/);
  assert.match(other.body.text, /Bot management help/);
});
