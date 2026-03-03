import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const srcRoot = path.resolve(projectRoot, "wecom");
const entryFile = path.resolve(projectRoot, "wecom/index.ts");

function walkTsFiles(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".ts")) {
      out.push(path.normalize(fullPath));
    }
  }
  return out;
}

const files = walkTsFiles(srcRoot);
const fileSet = new Set(files);

function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    base.endsWith(".js") ? `${base.slice(0, -3)}.ts` : "",
    path.join(base, "index.ts"),
  ].filter(Boolean).map((item) => path.normalize(item));
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

const missing = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const re = /from\s+["']([^"']+)["']/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const spec = match[1];
    if (!spec.startsWith(".")) continue;
    if (!resolveImport(file, spec)) {
      missing.push({
        file: path.relative(projectRoot, file),
        spec,
      });
    }
  }
}

if (!fs.existsSync(entryFile)) {
  console.error("Missing entry file: wecom/index.ts");
  process.exit(1);
}

if (missing.length > 0) {
  console.error(`Found ${missing.length} unresolved relative imports:`);
  for (const item of missing) {
    console.error(`- ${item.file} -> ${item.spec}`);
  }
  process.exit(1);
}

console.log(`Import check passed (${files.length} TypeScript files).`);
