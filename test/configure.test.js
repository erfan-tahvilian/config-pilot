import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { configFromEnv } from "../scripts/configure.mjs";

const template = await readFile(new URL("../wrangler.example.toml", import.meta.url), "utf8");
const id = "0123456789abcdef0123456789abcdef";
test("CI configuration uses only explicit deployment values and excludes credentials", () => {
  const config = configFromEnv(template, {
    CONFIG_PILOT_KV_NAMESPACE_ID: id,
    CONFIG_PILOT_WORKER_NAME: "my-config-panel",
    CONFIG_PILOT_WORKERS_DEV: "false",
    PUBLIC_BASE_URL: "https://configs.example.com/",
    ADMIN_PASSWORD: "never-write-this-password",
    CLOUDFLARE_API_TOKEN: "never-write-this-token",
  });
  assert.ok(config.includes('name = "my-config-panel"'));
  assert.ok(config.includes('id = "' + id + '"'));
  assert.ok(config.includes('PUBLIC_BASE_URL = "https://configs.example.com"'));
  assert.ok(config.includes('binding = "CONFIGS_KV"'));
  assert.ok(config.includes("workers_dev = false"));
  assert.equal(config.includes("never-write-this"), false);
  assert.equal(config.includes("REPLACE_WITH"), false);
});
test("invalid or missing deployment settings fail before config generation", () => {
  for (const badId of ["", "personal-namespace", '"\n[vars]\nSECRET="injected']) {
    assert.throws(() => configFromEnv(template, { CONFIG_PILOT_KV_NAMESPACE_ID: badId }), /namespace ID/);
  }
  assert.throws(() => configFromEnv(template, { CONFIG_PILOT_KV_NAMESPACE_ID: id, CONFIG_PILOT_WORKER_NAME: 'bad"name' }), /WORKER_NAME/);
  assert.throws(() => configFromEnv(template, { CONFIG_PILOT_KV_NAMESPACE_ID: id, CONFIG_PILOT_WORKERS_DEV: "invalid" }), /WORKERS_DEV/);
  for (const origin of ["not-a-url", "http://example.com", "https://example.com/path", "https://user:pass@example.com", "https://example.com/?q=x"]) {
    assert.throws(() => configFromEnv(template, { CONFIG_PILOT_KV_NAMESPACE_ID: id, PUBLIC_BASE_URL: origin }), /HTTPS origin/);
  }
});
