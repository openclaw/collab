// Local verification helper: never prints or writes the Gateway credential.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const [tool, sessionKey, args = "{}"] = process.argv.slice(2);
const config = JSON.parse(
  fs.readFileSync(
    process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), ".openclaw/openclaw.json"),
    "utf8",
  ),
);
const token = config.gateway?.auth?.token;
if (typeof token !== "string")
  throw new Error("Use the configured secret resolver for this Gateway.");
const response = await fetch(`http://127.0.0.1:${config.gateway?.port ?? 18789}/tools/invoke`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ tool, sessionKey, args: JSON.parse(args) }),
});
const result = await response.json();
if (!response.ok || result.ok === false) throw new Error(JSON.stringify(result));
console.log(JSON.stringify(result, null, 2));
