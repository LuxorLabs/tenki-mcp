/**
 * Offline pre-flight for server.json + package.json before an MCP Registry publish.
 *
 * Every rule here mirrors a constraint the registry enforces server-side, so a
 * violation that this script catches locally would otherwise be a 422 from
 * POST /v0/publish after the npm publish has already happened (i.e. after the
 * irreversible half of the release).
 *
 * Sources (modelcontextprotocol/registry @ v1.8.0):
 *   - internal/validators/schemas/2025-12-11.json  (JSON Schema)
 *   - pkg/api/v0/types.go:37-47                    (huma request-body tags)
 *   - internal/validators/registries/npm.go        (mcpName ownership check)
 *   - pkg/model/constants.go:18                    (RegistryURLNPM)
 */
import { readFileSync } from "node:fs";

const read = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
const pkg = read("package.json");
// Read from source rather than dist/ so this stays a fast fail that needs no build.
const serverTs = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const SCHEMA_RE = /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/[A-Za-z0-9_~.-]+\/server\.schema\.json$/;
const NAME_RE = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;

const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };
const len = (s) => [...(s ?? "")].length;

// The Luxor AI listing ships the same tarball republished as @luxorai/mcp with
// package.json name and mcpName rewritten to these values (see npm-publish.yml).
const targets = [
  { file: "server.json", name: pkg.name, mcpName: pkg.mcpName },
  { file: "server.luxor.json", name: "@luxorai/mcp", mcpName: "io.github.LuxorLabs/luxor-mcp" },
];

for (const target of targets) {
  const { file } = target;
  const srv = read(file);
  // $schema is required and must be a recognizable versioned schema URL.
  check(SCHEMA_RE.test(srv.$schema ?? ""), `${file} $schema is missing or malformed: ${srv.$schema}`);

  // name: required, 3-200 chars, exactly one slash, restricted charset.
  check(NAME_RE.test(srv.name ?? ""), `${file} name does not match ${NAME_RE}: ${srv.name}`);
  check(len(srv.name) >= 3 && len(srv.name) <= 200, `${file} name must be 3-200 chars (is ${len(srv.name)})`);

  // description: required, 1-100 chars. This is the limit that is easy to blow
  // past, because package.json.description has no such cap.
  check(
    len(srv.description) >= 1 && len(srv.description) <= 100,
    `${file} description must be 1-100 chars (is ${len(srv.description)})`,
  );

  // title: optional, but capped at 100 when present.
  if (srv.title !== undefined) {
    check(len(srv.title) >= 1 && len(srv.title) <= 100, `${file} title must be 1-100 chars (is ${len(srv.title)})`);
  }

  // version: required, <= 255, and must not be a range.
  check(len(srv.version) >= 1 && len(srv.version) <= 255, `${file} version must be 1-255 chars`);
  check(!/^[~^><=]|[*x]$/i.test(srv.version ?? ""), `${file} version looks like a range, not a version: ${srv.version}`);

  // The registry proves npm ownership by comparing the published package's
  // mcpName to server.json name with an exact, case-sensitive string compare.
  check(
    target.mcpName === srv.name,
    `${file}: package.json mcpName (${target.mcpName}) must exactly equal ${file} name (${srv.name})`,
  );

  // Versions must be in lockstep or the registry validates the wrong npm version.
  check(pkg.version === srv.version, `package.json version ${pkg.version} != ${file} version ${srv.version}`);
  for (const [i, p] of (srv.packages ?? []).entries()) {
    check(p.version === pkg.version, `${file} packages[${i}].version ${p.version} != package.json version ${pkg.version}`);
    check(!!p.registryType, `${file} packages[${i}] is missing registryType`);
    check(!!p.identifier, `${file} packages[${i}] is missing identifier`);
    check(!!p.transport?.type, `${file} packages[${i}] is missing transport.type`);
    if (p.registryType === "npm") {
      // ValidateNPM requires an exact base-URL match, and the identifier must be
      // the real npm package name (that is what gets fetched for the mcpName check).
      check(
        (p.registryBaseUrl ?? NPM_REGISTRY_URL) === NPM_REGISTRY_URL,
        `${file} packages[${i}].registryBaseUrl must be exactly ${NPM_REGISTRY_URL}`,
      );
      check(
        p.identifier === target.name,
        `${file} packages[${i}].identifier (${p.identifier}) != npm name (${target.name})`,
      );
    }
  }
}

// src/server.ts's VERSION is hand-maintained and reported to clients as
// serverInfo.version. The offline suite pins it to package.json too, but that
// needs a build; checking it here fails a release in seconds instead of minutes,
// and covers the fourth place a release bump has to touch.
{
  const m = serverTs.match(/export const VERSION = "([^"]+)"/);
  check(m !== null, "src/server.ts does not export a VERSION string literal");
  if (m) {
    check(
      m[1] === pkg.version,
      `src/server.ts VERSION (${m[1]}) != package.json version (${pkg.version})`,
    );
  }
}

if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  console.error(`\n✗ ${problems.length} problem(s) would be rejected by the MCP Registry.`);
  process.exit(1);
}
for (const t of targets) console.log(`✓ ${t.file} is publish-ready: ${t.mcpName}@${pkg.version} -> npm ${t.name}@${pkg.version}`);
