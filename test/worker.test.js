import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import worker from "../worker.js";

function fixture() {
  const store = new Map();
  const env = { CONFIGS_KV: {
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
  } };
  async function api(path, body, password = "admin") {
    const response = await worker.fetch(new Request("https://panel.test" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + password, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    return { status: response.status, data: await response.json() };
  }
  const create = async (name, sourceUserId) => {
    const result = await api("/api/admin/users/create", { name, sourceUserId });
    assert.equal(result.status, 200);
    return result.data.user;
  };
  const save = (id, configs) => api("/api/admin/users/configs/save", {
    id, configs, normalize: false, dedupe: false,
  });
  const configs = (id) => api("/api/admin/users/configs?id=" + id);
  return { store, env, api, create, save, configs };
}

test("creating a user without a source retains the existing empty-config behavior", async () => {
  const f = fixture();
  const user = await f.create("Plain");
  assert.equal((await f.configs(user.id)).data.configs, "");
  assert.equal(user.lastConfigUpdate, null);
});

test("creation copies exact configs and metadata while keeping identity and future edits independent", async () => {
  const f = fixture();
  const source = await f.create("Source");
  const text = "vless://id@host:443#اول\r\n\nvless://id@host:443#duplicate\n";
  await f.save(source.id, text);
  const target = await f.create("Target", source.id);
  assert.notEqual(target.token, source.token);
  assert.notEqual(target.id, source.id);
  assert.ok(target.lastConfigUpdate);
  const copied = (await f.configs(target.id)).data;
  assert.equal(copied.configs, text);
  assert.equal(copied.meta.byteSize, new TextEncoder().encode(text).length);
  assert.ok(copied.meta.sha256);
  await f.save(source.id, "trojan://new@host:443");
  assert.equal((await f.configs(target.id)).data.configs, text);
  await f.save(target.id, "ss://target@host:443");
  assert.equal((await f.configs(source.id)).data.configs, "trojan://new@host:443");
});

test("copying onto an existing user backs up the destination and supports restore", async () => {
  const f = fixture();
  const source = await f.create("Source");
  const target = await f.create("Target");
  await f.save(source.id, "vless://source@host:443");
  await f.save(target.id, "trojan://previous@host:443");
  const before = (await f.configs(target.id)).data;
  const copy = await f.api("/api/admin/users/configs/copy", { id: target.id, sourceUserId: source.id });
  assert.equal(copy.status, 200);
  assert.equal(copy.data.configs, "vless://source@host:443");
  assert.equal(copy.data.user.token, target.token);
  assert.equal(f.store.get("user_configs_backup:" + target.id), before.configs);
  assert.deepEqual(JSON.parse(f.store.get("user_configs_backup_meta:" + target.id)), before.meta);
  const restored = await f.api("/api/admin/users/configs/restore", { id: target.id });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.configs, before.configs);
});

test("missing, empty, oversized and same-user sources fail without changing destination or creating users", async () => {
  const f = fixture();
  const target = await f.create("Target");
  const empty = await f.create("Empty");
  await f.save(target.id, "vless://original@host:443");
  for (const sourceUserId of [undefined, "missing", empty.id, target.id]) {
    const before = new Map(f.store);
    const result = await f.api("/api/admin/users/configs/copy", { id: target.id, sourceUserId });
    assert.equal(result.status, 400);
    assert.deepEqual(f.store, before);
  }
  for (const sourceUserId of ["missing", empty.id]) {
    const before = new Map(f.store);
    assert.equal((await f.api("/api/admin/users/create", { name: "Invalid", sourceUserId })).status, 400);
    assert.deepEqual(f.store, before);
  }
  f.store.set("user_configs:" + empty.id, "x".repeat(5 * 1024 * 1024 + 1));
  const before = new Map(f.store);
  assert.equal((await f.api("/api/admin/users/create", { name: "Too big", sourceUserId: empty.id })).status, 400);
  assert.equal((await f.api("/api/admin/users/configs/copy", { id: target.id, sourceUserId: empty.id })).status, 400);
  assert.deepEqual(f.store, before);
  assert.equal((await f.api("/api/admin/users/configs/copy", { id: "missing", sourceUserId: target.id })).status, 404);
});

test("both copy entry points require admin authentication", async () => {
  const f = fixture();
  assert.equal((await f.api("/api/admin/users/create", { name: "Denied", sourceUserId: "source" }, "wrong")).status, 401);
  assert.equal((await f.api("/api/admin/users/configs/copy", { id: "target", sourceUserId: "source" }, "wrong")).status, 401);
  assert.equal(f.store.has("users_v2"), false);
});

test("admin and Mini App HTML contain parseable browser scripts", async () => {
  const f = fixture();
  for (const path of ["/admin", "/tg-app"]) {
    const response = await worker.fetch(new Request("https://panel.test" + path), f.env);
    assert.equal(response.status, 200);
    const html = await response.text();
    for (const [, code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(code);
    assert.match(html, /id="languageToggle"/);
    assert.match(html, /id="themeToggle"/);
    assert.match(html, /id="newUserSource"/);
    assert.match(html, /id="copySourceUser"/);
  }
});
