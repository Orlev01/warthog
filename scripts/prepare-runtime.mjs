import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve, relative, basename } from "node:path";
import { pathToFileURL } from "node:url";

const unsafeName = /^(?:\.env(?:\..*)?|\.git|\.data|\.aws|\.azure|\.ssh)$/;

async function filesIn(dir, boundary = dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (unsafeName.test(entry.name)) throw new Error("Unsafe file in standalone/runtime inputs");
    if (entry.isSymbolicLink()) {
      const target = relative(resolve(boundary), await realpath(path));
      if (target === ".." || target.startsWith("../")) throw new Error("Unsafe symlink in standalone/runtime inputs");
    } else if (entry.isDirectory()) files.push(...await filesIn(path, boundary));
    else files.push(path);
  }
  return files.sort();
}

async function hashes(dir, extension) {
  let files;
  try { files = (await filesIn(dir)).filter((path) => path.endsWith(extension)); }
  catch { throw new Error(`Missing or unsafe ${extension === ".sql" ? "migration" : "catalogue"} assets`); }
  if (!files.length) throw new Error(`Missing ${extension === ".sql" ? "migration" : "catalogue"} assets`);
  return Promise.all(files.map(async (path) => ({ file: basename(path), sha256: createHash("sha256").update(await readFile(path)).digest("hex") })));
}

export async function prepareRuntime(root = process.cwd()) {
  const standalone = join(root, ".next/standalone");
  await filesIn(standalone);
  const migrations = await hashes(join(root, "db/migrations"), ".sql");
  const catalogue = await hashes(join(root, "catalogue/connectors"), ".json");
  await readFile(join(standalone, "server.js"));
  if (!(await filesIn(join(root, ".next/static"))).length) throw new Error("Missing static assets");
  await filesIn(join(root, "public"));
  const manifest = {
    nodeMajor: 22,
    buildId: (await readFile(join(root, ".next/BUILD_ID"), "utf8")).trim(),
    lockfileSha256: createHash("sha256").update(await readFile(join(root, "package-lock.json"))).digest("hex"),
    migrations, catalogue,
  };
  const output = join(root, ".runtime");
  // Only replace our own generated output, never an unrecognised existing folder.
  try {
    await readFile(join(output, "release-manifest.json"));
    await rm(output, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(output);
  await cp(standalone, output, { recursive: true });
  for (const path of [".next/static", "public", "db/migrations", "catalogue/connectors"]) {
    await mkdir(join(output, path, ".."), { recursive: true });
    await cp(join(root, path), join(output, path), { recursive: true });
  }
  await writeFile(join(output, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const manifest = await prepareRuntime();
    console.log(`Runtime staged: ${manifest.migrations.length} migrations; ${manifest.catalogue.length} connectors`);
  } catch {
    console.error("Runtime staging failed; check the build and required runtime assets. No image is approved.");
    process.exitCode = 1;
  }
}
