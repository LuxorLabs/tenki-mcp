/**
 * ssh.ts — SSH access tools for tenki-mcp.
 *
 * UpdateSSHAuthorizedKeys sets the authorized_keys on a running sandbox (on
 * SandboxService). IssueSandboxSSHCert and ListActiveSSHGateways live on a
 * SEPARATE ConnectRPC service (SSHGatewayClientService), reached by passing the
 * service path to client.control.
 *
 * Request shapes are grounded in the published Tenki API surface (CreateSession's
 * ssh_authorized_keys field → sshAuthorizedKeys). The cert-issuance and gateway
 * shapes are SDK-name-verified but not exercised end-to-end here.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok, sessionIdSchema } from "./common.js";

const SSH_GATEWAY_SERVICE = "tenki.sandbox.v1.SSHGatewayClientService";

export function registerSsh(server: McpServer, client: TenkiClient): void {
	server.registerTool(
		"tenki_update_ssh_keys",
		{
			description:
				"Set the SSH authorized public keys on a running sandbox, enabling direct SSH access for the given keys.",
			inputSchema: z.object({
				session_id: sessionIdSchema,
				public_keys: z
					.array(z.string())
					.describe(
						"SSH public keys (ssh-ed25519 …, ssh-rsa …) to authorize. Replaces the current set.",
					),
			}),
		},
		async ({ session_id, public_keys }) =>
			ok(
				await client.control("UpdateSSHAuthorizedKeys", {
					sessionId: session_id,
					sshAuthorizedKeys: public_keys,
				}),
			),
	);

	server.registerTool(
		"tenki_issue_ssh_cert",
		{
			description:
				"Issue a short-lived SSH certificate for a public key, authorizing SSH access to a sandbox via the SSH gateway.",
			inputSchema: z.object({
				session_id: sessionIdSchema,
				public_key: z
					.string()
					.describe("The SSH public key to sign into a certificate."),
			}),
		},
		async ({ session_id, public_key }) =>
			ok(
				await client.control(
					"IssueSandboxSSHCert",
					{ sessionId: session_id, publicKey: public_key },
					SSH_GATEWAY_SERVICE,
				),
			),
	);

	server.registerTool(
		"tenki_list_ssh_gateways",
		{
			description: "List the currently active SSH gateways for the workspace.",
			inputSchema: z.object({
				workspace_id: z
					.string()
					.optional()
					.describe(
						"Workspace to list (defaults to the key's first workspace).",
					),
			}),
		},
		async ({ workspace_id }) => {
			const workspaceId =
				workspace_id ?? (await client.resolveOwner()).workspaceId;
			return ok(
				await client.control(
					"ListActiveSSHGateways",
					{ ...(workspaceId ? { workspaceId } : {}) },
					SSH_GATEWAY_SERVICE,
				),
			);
		},
	);
}
