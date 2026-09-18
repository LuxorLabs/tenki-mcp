/**
 * ssh.ts — SSH access tools for tenki-mcp.
 *
 * UpdateSSHAuthorizedKeys sets the authorized_keys on a running sandbox (on
 * SandboxService). IssueSandboxSSHCert and ListActiveSSHGateways live on a
 * SEPARATE ConnectRPC service (SSHGatewayClientService), reached by passing the
 * service path to client.control.
 *
 * Request shapes follow proto/tenki/sandbox/v1/ssh_gateway_client.proto:
 * IssueSandboxSSHCertRequest { session_id, public_key (32-8192 chars), requested_ttl, source_addresses[] }
 * ListActiveSSHGatewaysRequest { region, session_id } — there is NO workspace_id field.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok, sessionIdSchema } from "./common.js";

const SSH_GATEWAY_SERVICE = "tenki.sandbox.v1.SSHGatewayClientService";

export function registerSsh(server: McpServer, client: TenkiClient): void {
	server.tool(
		"tenki_update_ssh_keys",
		"Set the SSH authorized public keys on a running sandbox, enabling direct SSH access for the given keys. Replaces the current set (at least one key is required — the API has no 'clear' operation).",
		{
			session_id: sessionIdSchema,
			public_keys: z
				.array(z.string().min(1))
				.min(1)
				.describe("SSH public keys (ssh-ed25519 …, ssh-rsa …) to authorize. Replaces the current set."),
		},
		async ({ session_id, public_keys }) =>
			ok(await client.control("UpdateSSHAuthorizedKeys", { sessionId: session_id, sshAuthorizedKeys: public_keys })),
	);

	server.tool(
		"tenki_issue_ssh_cert",
		"Issue a short-lived SSH certificate for a public key, authorizing SSH access to a sandbox via the SSH gateway. Returns the certificate, the CA public key for known_hosts pinning, expiry, and a renewal hint.",
		{
			session_id: sessionIdSchema,
			public_key: z
				.string()
				.min(32)
				.max(8192)
				.describe("OpenSSH-format public key to sign into a certificate (e.g. 'ssh-ed25519 AAAA…')."),
			requested_ttl_seconds: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Requested certificate lifetime in seconds; the server caps it to policy."),
			source_addresses: z
				.array(z.string())
				.max(16)
				.optional()
				.describe("CIDRs bound into the cert's source-address critical option; SSH refuses the cert from any other source IP."),
		},
		async ({ session_id, public_key, requested_ttl_seconds, source_addresses }) =>
			ok(
				await client.control(
					"IssueSandboxSSHCert",
					{
						sessionId: session_id,
						publicKey: public_key,
						...(requested_ttl_seconds ? { requestedTtl: `${requested_ttl_seconds}s` } : {}),
						...(source_addresses && source_addresses.length ? { sourceAddresses: source_addresses } : {}),
					},
					SSH_GATEWAY_SERVICE,
				),
			),
	);

	server.tool(
		"tenki_list_ssh_gateways",
		"List the currently active SSH gateways (id, region, public endpoint, health). Filter by region, or pass session_id to get only the gateways that can reach that sandbox's host. Gateways are fleet-wide, not per workspace.",
		{
			region: z.string().optional().describe("Only gateways in this region (e.g. 'us', 'eu'). Omit for all regions."),
			session_id: sessionIdSchema.optional().describe("Only gateways that can reach this sandbox's host."),
		},
		async ({ region, session_id }) =>
			ok(
				await client.control(
					"ListActiveSSHGateways",
					{
						...(region ? { region } : {}),
						...(session_id ? { sessionId: session_id } : {}),
					},
					SSH_GATEWAY_SERVICE,
				),
			),
	);
}
