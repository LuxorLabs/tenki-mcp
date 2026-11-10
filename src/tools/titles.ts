/**
 * Human-readable tool titles, applied centrally by the registration guard in
 * server.ts so every tool advertises one (MCP `Tool.title` and
 * `annotations.title`). Connector directories require a title on every tool;
 * test/offline.test.mjs fails if a registered tool has no entry here or an
 * entry names a tool that is not registered.
 */
export const TOOL_TITLES: Readonly<Record<string, string>> = {
	// Identity / auth
	tenki_whoami: "Show Current Identity",
	tenki_auth_status: "Check Credential Status",

	// Sandboxes
	tenki_run_code: "Run Code in a Throwaway Sandbox",
	tenki_create_sandbox: "Create Sandbox",
	tenki_get_sandbox: "Get Sandbox",
	tenki_get_sandbox_metrics: "Get Sandbox Metrics",
	tenki_list_sandboxes: "List Sandboxes",
	tenki_list_workspace_sandboxes: "List Workspace Sandboxes",
	tenki_terminate_sandbox: "Terminate Sandbox",
	tenki_terminate_sandboxes: "Terminate Multiple Sandboxes",
	tenki_pause_sandbox: "Pause Sandbox",
	tenki_resume_sandbox: "Resume Sandbox",
	tenki_fork_sandbox: "Fork Sandbox",
	tenki_extend_sandbox: "Extend Sandbox Lifetime",
	tenki_update_sandbox: "Update Sandbox",
	tenki_report_sandbox_activity: "Report Sandbox Activity",

	// Commands and files
	tenki_exec: "Run Command in Sandbox",
	tenki_read_file: "Read File",
	tenki_write_file: "Write File",
	tenki_list_files: "List Directory",
	tenki_stat_path: "Get Path Info",
	tenki_make_dir: "Create Directory",
	tenki_remove_path: "Delete File or Directory",
	tenki_move_path: "Move or Rename Path",
	tenki_get_upload_url: "Get File Upload URL",
	tenki_get_download_url: "Get Artifact Download URL",

	// Git
	tenki_git_clone: "Clone Git Repository",
	tenki_git_checkout: "Check Out Git Ref",
	tenki_git_diff: "Show Git Diff",
	tenki_git_log: "Show Git Log",

	// Ports and previews
	tenki_expose_port: "Expose Port",
	tenki_list_exposed_ports: "List Exposed Ports",
	tenki_unexpose_port: "Unexpose Port",
	tenki_create_preview_url: "Create Preview URL",
	tenki_open_preview: "Open Authenticated Preview",
	tenki_list_preview_urls: "List Preview URLs",
	tenki_get_preview_url: "Get Preview URL",
	tenki_delete_preview_url: "Delete Preview URL",
	tenki_touch_preview: "Keep Preview Alive",
	tenki_bind_preview_url: "Bind Preview URL",
	tenki_unbind_preview_url: "Unbind Preview URL",
	tenki_resolve_preview_token: "Resolve Preview Token",

	// Snapshots
	tenki_create_snapshot: "Create Snapshot",
	tenki_get_snapshot: "Get Snapshot",
	tenki_list_snapshots: "List Snapshots",
	tenki_list_session_snapshots: "List Sandbox Snapshots",
	tenki_list_dangling_snapshots: "List Dangling Snapshots",
	tenki_list_workspace_snapshots: "List Workspace Snapshots",
	tenki_update_snapshot: "Update Snapshot",
	tenki_delete_snapshot: "Delete Snapshot",
	tenki_get_snapshot_download_url: "Get Snapshot Download URL",

	// Volumes
	tenki_create_volume: "Create Volume",
	tenki_get_volume: "Get Volume",
	tenki_list_volumes: "List Volumes",
	tenki_update_volume: "Update Volume",
	tenki_delete_volume: "Delete Volume",
	tenki_resize_volume: "Resize Volume",
	tenki_attach_volume: "Attach Volume",
	tenki_detach_volume: "Detach Volume",

	// Egress policies
	tenki_create_egress_policy: "Create Egress Policy",
	tenki_get_egress_policy: "Get Egress Policy",
	tenki_list_egress_policies: "List Egress Policies",
	tenki_update_egress_policy: "Replace Egress Policy",
	tenki_delete_egress_policy: "Delete Egress Policy",

	// Templates
	tenki_create_template: "Create Template",
	tenki_get_template: "Get Template",
	tenki_list_templates: "List Templates",
	tenki_update_template: "Update Template",
	tenki_delete_template: "Delete Template",
	tenki_build_template: "Build Template",
	tenki_cancel_template_build: "Cancel Template Build",
	tenki_get_template_build: "Get Template Build",
	tenki_list_active_template_builds: "List Active Template Builds",
	tenki_list_template_builds: "List Template Builds",
	tenki_delete_template_build: "Delete Template Build",

	// Workspace
	tenki_get_workspace_usage: "Get Workspace Usage",
	tenki_list_ci_runner_sizes: "List CI Runner Sizes",
	tenki_get_workspace_preview_domains: "Get Wildcard Preview Domains",
	tenki_update_workspace_preview_domains: "Update Wildcard Preview Domains",

	// SSH
	tenki_update_ssh_keys: "Set SSH Authorized Keys",
	tenki_issue_ssh_cert: "Issue SSH Certificate",
	tenki_list_ssh_gateways: "List SSH Gateways",
};
