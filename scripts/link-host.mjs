// Link a built development host without writing a machine-specific dependency to package.json.
import { mkdir, readFile, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const input = process.argv[2];
if (!input) throw new Error("Usage: npm run link:host -- /absolute/path/to/openclaw");
const host = await realpath(path.resolve(input));
const pkg = JSON.parse(await readFile(path.join(host, "package.json"), "utf8"));
if (pkg.name !== "openclaw") throw new Error("The target must be an OpenClaw checkout.");
const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.openclaw;
if (!bin) throw new Error("The target does not declare an OpenClaw CLI.");
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, "node_modules/.bin"), { recursive: true });
async function link(target, destination, type) {
  try {
    await symlink(target, destination, type);
  } catch (error) {
    if (error.code !== "EEXIST" || (await realpath(destination)) !== (await realpath(target)))
      throw error;
  }
}
await link(host, path.join(root, "node_modules/openclaw"), "dir");
await link(path.join(host, bin), path.join(root, "node_modules/.bin/openclaw"), "file");
console.log(`Linked OpenClaw ${pkg.version}. Run npm run check to verify SDK compatibility.`);
