#!/usr/bin/env node
/**
 * Builds the AgentCore Runtime deployment package (NODE_22, direct code deploy):
 *
 *   dist/agentcore/
 *     runtime.mjs            the /ping + /invocations server (src/aws/runtime.ts)
 *     kits/kitNN.mjs         each kit, bundled
 *     ui/                    console page (the runtime serves no HTML, kept for recordings)
 *     node_modules/          playwright(-core) and the metal-agent CLI, pure JavaScript
 *     chromium/              serverless Chromium for linux/arm64 (kits 9 and 10)
 *
 * AgentCore runs arm64 only and rejects packages with x86 native binaries, so
 * everything here is JavaScript except the Chromium pack, which is the arm64 build.
 *
 *   npm run aws:build
 */
import { build } from "esbuild";
import { cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const root = process.cwd();
const out = join(root, "dist", "agentcore");
const CHROMIUM_VERSION = "153.0.0"; // matches @sparticuz/chromium-min in package.json
const PACK_URL = `https://github.com/Sparticuz/chromium/releases/download/v${CHROMIUM_VERSION}/chromium-v${CHROMIUM_VERSION}-pack.arm64.tar`;

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "kits"), { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["playwright", "playwright-core", "chromium-bidi", "electron"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
  legalComments: "none",
};

const kits = readdirSync(join(root, "kits")).filter((d) => /^\d\d-/.test(d)).sort();
await build({ ...common, entryPoints: { runtime: "src/aws/runtime.ts" }, outdir: out, outExtension: { ".js": ".mjs" } });
await build({
  ...common,
  entryPoints: Object.fromEntries(kits.map((d) => [`kit${d.slice(0, 2)}`, `kits/${d}/run.ts`])),
  outdir: join(out, "kits"),
  outExtension: { ".js": ".mjs" },
});
console.log(`bundled runtime and ${kits.length} kits`);

// The console page, so recordings and links resolve the same way as locally.
cpSync(join(root, "ui"), join(out, "ui"), { recursive: true });

// Pure-JS modules loaded at run time.
for (const p of ["playwright", "playwright-core"]) cpSync(join(root, "node_modules", p), join(out, "node_modules", p), { recursive: true, dereference: true });

// The Metal CLI that live clearing shells out to (node_modules/.bin/metal-agent).
mkdirSync(join(out, "node_modules", ".bin"), { recursive: true });
const metalCli = join(out, "node_modules", ".bin", "metal-agent");
await build({ ...common, entryPoints: ["node_modules/@metalntwx/metal-agent/dist/index.js"], outfile: metalCli, banner: { js: "#!/usr/bin/env node\n" + common.banner.js } });
chmodSync(metalCli, 0o755);

// Chromium for linux/arm64, cached between builds.
const cache = join(root, ".cache", `chromium-${CHROMIUM_VERSION}-arm64.tar`);
if (!existsSync(cache)) {
  mkdirSync(join(root, ".cache"), { recursive: true });
  console.log(`downloading ${PACK_URL}`);
  const res = await fetch(PACK_URL);
  if (!res.ok) throw new Error(`Chromium pack download failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(cache));
}
mkdirSync(join(out, "chromium"));
execFileSync("tar", ["-xf", cache, "-C", join(out, "chromium")]);

writeFileSync(join(out, "package.json"), JSON.stringify({ name: "airwallex-agent-desk-runtime", private: true, type: "module", engines: { node: ">=22" } }, null, 2));

// AgentCore needs 644 files and 755 directories/executables.
const fix = (p) => {
  const st = statSync(p);
  if (st.isDirectory()) {
    chmodSync(p, 0o755);
    for (const f of readdirSync(p)) fix(join(p, f));
  } else if (p !== metalCli) chmodSync(p, 0o644);
};
fix(out);

const size = execFileSync("du", ["-sh", out]).toString().split("\t")[0];
console.log(`AgentCore package ready: dist/agentcore (${size}); entrypoint runtime.mjs`);
