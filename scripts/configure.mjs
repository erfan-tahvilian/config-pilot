import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function configFromEnv(template, env) {
  const id = (env.CONFIG_PILOT_KV_NAMESPACE_ID || "").trim();
  const name = (env.CONFIG_PILOT_WORKER_NAME || "config-pilot").trim();
  if (!/^[a-f0-9]{32}$/i.test(id)) {
    throw new Error("Set CONFIG_PILOT_KV_NAMESPACE_ID to your 32-character KV namespace ID.");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new Error("CONFIG_PILOT_WORKER_NAME must be 1–63 lowercase letters, numbers or hyphens, starting and ending with a letter or number.");
  }
  let config = template
    .replace('name = "config-pilot"', "name = " + JSON.stringify(name))
    .replace("REPLACE_WITH_YOUR_KV_NAMESPACE_ID", id);
  if (env.CONFIG_PILOT_WORKERS_DEV) {
    if (!["true", "false"].includes(env.CONFIG_PILOT_WORKERS_DEV)) {
      throw new Error("CONFIG_PILOT_WORKERS_DEV must be true or false.");
    }
    config = config.replace("workers_dev = true", "workers_dev = " + env.CONFIG_PILOT_WORKERS_DEV);
  }
  if (env.PUBLIC_BASE_URL) {
    let url;
    try { url = new URL(env.PUBLIC_BASE_URL); } catch { throw new Error("PUBLIC_BASE_URL must be an HTTPS origin."); }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("PUBLIC_BASE_URL must be an HTTPS origin without credentials, path, query or fragment.");
    }
    config += "\n[vars]\nPUBLIC_BASE_URL = " + JSON.stringify(url.origin) + "\n";
  }
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const template = await readFile(new URL("../wrangler.example.toml", import.meta.url), "utf8");
    const config = configFromEnv(template, process.env);
    await writeFile(new URL("../wrangler.toml", import.meta.url), config);
    console.log("Generated local wrangler.toml from deployment variables. No passwords or API tokens were written.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
