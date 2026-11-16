# tenki — Claude Code plugin (legacy)

Legacy name for the [`luxor`](../luxor/README.md) plugin, kept so existing `tenki@tenki` installs keep working. New installs should use `luxor`:

```
/plugin marketplace add LuxorLabs/tenki-mcp
/plugin install luxor@luxor
```

Installs the [`@tenkicloud/mcp`](https://www.npmjs.com/package/@tenkicloud/mcp) MCP server into Claude Code. On install you are prompted for your API key (`lx_…` or `tk_…`); it is stored in your OS keychain and passed to the server as `TENKI_API_KEY`.

Requires Node.js 22+ (`npx` fetches the server on first start).
