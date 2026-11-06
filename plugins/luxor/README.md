# luxor - Claude Code plugin

Installs the Luxor Sandbox MCP server into Claude Code. On install you are prompted for your Luxor API key (`lx_…` or `tk_…`); it is stored in your OS keychain and passed to the server as `LUXORAI_API_KEY`.

```
/plugin marketplace add LuxorLabs/tenki-mcp
/plugin install luxor@tenki
```

The server runs from `@tenkicloud/mcp` until `@luxorai/mcp` is published; the package switch is a one-line change to `args` in `.claude-plugin/plugin.json`. Tool names keep the `tenki_` prefix.

Requires Node.js 22+ (`npx` fetches the server on first start).
