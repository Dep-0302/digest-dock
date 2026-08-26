const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const registry = JSON.parse(
  fs.readFileSync(path.join(root, "provider-registry.json"), "utf8"),
);
const contract = require("./provider-contract.js");

if (registry.schemaVersion !== 1 || registry.singleProviderPerRun !== true) {
  throw new Error("Provider registry must freeze schema v1 and single-provider runs.");
}
if (!Array.isArray(registry.providers) || registry.providers.length !== 7) {
  throw new Error("Provider registry must contain exactly seven providers.");
}

const ids = registry.providers.map((provider) => provider.id);
if (new Set(ids).size !== ids.length) {
  throw new Error("Provider registry contains duplicate IDs.");
}
assertSameValues(ids, contract.PROVIDER_IDS, "provider IDs");

for (const provider of registry.providers) {
  const entrypoint = path.resolve(root, provider.entrypoint);
  if (!fs.existsSync(entrypoint)) {
    throw new Error(
      `Missing entrypoint for ${provider.id}: ${provider.entrypoint}`,
    );
  }
  const adapter = path.resolve(root, provider.adapter);
  if (!fs.existsSync(adapter)) {
    throw new Error(`Missing adapter for ${provider.id}: ${provider.adapter}`);
  }
  contract.normalizeProviderVariant(provider.defaultVariant);
}

for (const file of walkFiles(root)) {
  const extension = path.extname(file);
  if (extension === ".json") {
    JSON.parse(fs.readFileSync(file, "utf8"));
    if (path.basename(file) === "manifest.json") validateExperimentManifest(file);
  }
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    runCheck(process.execPath, ["--check", file], `JavaScript syntax: ${file}`);
  }
  if (extension === ".py") {
    runCheck(
      "python3",
      [
        "-c",
        "import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'), filename=sys.argv[1])",
        file,
      ],
      `Python syntax: ${file}`,
    );
  }
  if (extension === ".sh") {
    runCheck("bash", ["-n", file], `shell syntax: ${file}`);
  }
}

const repositoryRoot = path.resolve(root, "..", "..");
const releaseCheck = fs.readFileSync(
  path.join(repositoryRoot, "scripts", "check-release.sh"),
  "utf8",
);
const publicAllowlist = releaseCheck.match(
  /public_allowlist=\(([\s\S]*?)\n\)/,
)?.[1];
if (!publicAllowlist || /experiments\//.test(publicAllowlist)) {
  throw new Error("Public release allowlist must exclude experiments/.");
}
const rootPackage = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
);
if (rootPackage.dependencies || rootPackage.devDependencies) {
  throw new Error("Root extension package must not absorb experiment dependencies.");
}
const manifest = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "manifest.json"), "utf8"),
);
const permissions = [...(manifest.permissions || [])].sort();
const expectedPermissions = ["sidePanel", "storage", "tabs", "scripting"].sort();
if (JSON.stringify(permissions) !== JSON.stringify(expectedPermissions)) {
  throw new Error("Public extension permissions drifted during the experiment.");
}
for (const forbidden of [
  "nativeMessaging",
  "webRequest",
  "debugger",
  "cookies",
]) {
  if (permissions.includes(forbidden)) {
    throw new Error(`Public extension gained forbidden experiment permission: ${forbidden}`);
  }
}
if (
  (manifest.host_permissions || []).some((value) =>
    /(?:127\.0\.0\.1|localhost|api\.example\.test)/i.test(value),
  )
) {
  throw new Error("Public extension gained an experiment-only host permission.");
}

const forbidden = ["node_modules", ".venv", ".venv312", ".npm-cache"];
for (const name of forbidden) {
  const generated = findDirectory(root, name);
  if (generated) {
    const ignored = spawnSync("git", ["check-ignore", "-q", generated], {
      cwd: repositoryRoot,
    });
    if (ignored.status !== 0) {
      throw new Error(`Generated dependency directory is not ignored: ${generated}`);
    }
  }
}

console.log("Seven-provider experiment registry check passed.");

function assertSameValues(left, right, label) {
  if (
    left.length !== right.length ||
    left.some((value, index) => value !== right[index])
  ) {
    throw new Error(`Registry and contract disagree on ${label}.`);
  }
}

function findDirectory(start, target) {
  const pending = [start];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === target) return path.join(current, entry.name);
      if (entry.name.startsWith(".")) continue;
      pending.push(path.join(current, entry.name));
    }
  }
  return null;
}

function walkFiles(start) {
  const files = [];
  const pending = [start];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", ".venv", ".venv312", ".npm-cache"].includes(entry.name)) {
          continue;
        }
        pending.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function runCheck(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  }
}

function validateExperimentManifest(file) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const base = path.dirname(file);
  const references = [];
  if (manifest.background?.service_worker) {
    references.push(manifest.background.service_worker);
  }
  if (manifest.action?.default_popup) references.push(manifest.action.default_popup);
  for (const contentScript of manifest.content_scripts || []) {
    references.push(...(contentScript.js || []), ...(contentScript.css || []));
  }
  for (const reference of references) {
    const resolved = path.resolve(base, reference);
    if (!resolved.startsWith(`${base}${path.sep}`) || !fs.existsSync(resolved)) {
      throw new Error(`Experiment manifest has a missing/unsafe reference: ${file}: ${reference}`);
    }
  }
  for (const permission of manifest.permissions || []) {
    if (["cookies", "debugger", "nativeMessaging", "webRequest"].includes(permission)) {
      throw new Error(`Experiment manifest gained forbidden permission ${permission}: ${file}`);
    }
  }
  if ((manifest.host_permissions || []).includes("<all_urls>")) {
    throw new Error(`Experiment manifest may not use <all_urls>: ${file}`);
  }
  for (const reference of references.filter((value) => value.endsWith(".html"))) {
    const htmlPath = path.resolve(base, reference);
    const html = fs.readFileSync(htmlPath, "utf8");
    for (const match of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
      const value = match[1];
      if (/^(?:https?:|#|\/\/)/i.test(value)) continue;
      const resolved = path.resolve(path.dirname(htmlPath), value);
      if (!resolved.startsWith(`${base}${path.sep}`) || !fs.existsSync(resolved)) {
        throw new Error(`Experiment HTML has a missing/unsafe reference: ${htmlPath}: ${value}`);
      }
    }
  }
}
