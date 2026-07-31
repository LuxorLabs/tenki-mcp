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
const srv = read("server.json");

const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const SCHEMA_RE = /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/[A-Za-z0-9_~.-]+\/server\.schema\.json$/;
const NAME_RE = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;

const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };
const len = (s) => [...(s ?? "")].length;

// $schema is required and must be a recognizable versioned schema URL.
check(SCHEMA_RE.test(srv.$schema ?? ""), `server.json $schema is missing or malformed: ${srv.$schema}`);

// name: required, 3-200 chars, exactly one slash, restricted charset.
check(NAME_RE.test(srv.name ?? ""), `server.json name does not match ${NAME_RE}: ${srv.name}`);
check(len(srv.name) >= 3 && len(srv.name) <= 200, `server.json name must be 3-200 chars (is ${len(srv.name)})`);

// description: required, 1-100 chars. This is the limit that is easy to blow
// past, because package.json.description has no such cap.
check(
  len(srv.description) >= 1 && len(srv.description) <= 100,
  `server.json description must be 1-100 chars (is ${len(srv.description)})`,
);

// title: optional, but capped at 100 when present.
if (srv.title !== undefined) {
  check(len(srv.title) >= 1 && len(srv.title) <= 100, `server.json title must be 1-100 chars (is ${len(srv.title)})`);
}

// version: required, <= 255, and must not be a range.
check(len(srv.version) >= 1 && len(srv.version) <= 255, `server.json version must be 1-255 chars`);
check(!/^[~^><=]|[*x]$/i.test(srv.version ?? ""), `server.json version looks like a range, not a version: ${srv.version}`);

// The registry proves npm ownership by comparing the published package's
// mcpName to server.json name with an exact, case-sensitive string compare.
check(
  pkg.mcpName === srv.name,
  `package.json mcpName (${pkg.mcpName}) must exactly equal server.json name (${srv.name})`,
);

// Versions must be in lockstep or the registry validates the wrong npm version.
check(pkg.version === srv.version, `package.json version ${pkg.version} != server.json version ${srv.version}`);
for (const [i, p] of (srv.packages ?? []).entries()) {
  check(p.version === pkg.version, `server.json packages[${i}].version ${p.version} != package.json version ${pkg.version}`);
  check(!!p.registryType, `server.json packages[${i}] is missing registryType`);
  check(!!p.identifier, `server.json packages[${i}] is missing identifier`);
  check(!!p.transport?.type, `server.json packages[${i}] is missing transport.type`);
  if (p.registryType === "npm") {
    // ValidateNPM requires an exact base-URL match, and the identifier must be
    // the real npm package name (that is what gets fetched for the mcpName check).
    check(
      (p.registryBaseUrl ?? NPM_REGISTRY_URL) === NPM_REGISTRY_URL,
      `server.json packages[${i}].registryBaseUrl must be exactly ${NPM_REGISTRY_URL}`,
    );
    check(
      p.identifier === pkg.name,
      `server.json packages[${i}].identifier (${p.identifier}) != package.json name (${pkg.name})`,
    );
  }
}

if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  console.error(`\n✗ ${problems.length} problem(s) would be rejected by the MCP Registry.`);
  process.exit(1);
}
console.log(`✓ server.json is publish-ready: ${srv.name}@${srv.version} -> npm ${pkg.name}@${pkg.version}`);
