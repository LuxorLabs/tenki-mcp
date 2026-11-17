# luxor - Claude Code plugin

Installs the Luxor Sandbox MCP server into Claude Code. On install you are prompted for your Luxor API key (`lx_…` or `tk_…`); it is stored in your OS keychain and passed to the server as `LUXOR_API_KEY` (and as `TENKI_API_KEY`, so releases that predate `LUXOR_*` support still start).

```
/plugin marketplace add LuxorLabs/tenki-mcp
/plugin install luxor@luxor
```

The server runs from [`@luxorai/mcp`](https://www.npmjs.com/package/@luxorai/mcp). The plugin sets `LUXOR_MCP_TOOL_PREFIX=luxor`, so its tools are named `luxor_*` (`luxor_create_sandbox`, `luxor_exec`, …).

Requires Node.js 22+ (`npx` fetches the server on first start).
