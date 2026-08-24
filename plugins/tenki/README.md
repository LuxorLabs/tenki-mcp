# tenki — Claude Code plugin

Installs the [`@tenkicloud/mcp`](https://www.npmjs.com/package/@tenkicloud/mcp) MCP server into Claude Code. On install you are prompted for your Tenki API key (`tk_…`); it is stored in your OS keychain and passed to the server as `TENKI_API_KEY`.

```
/plugin marketplace add LuxorLabs/tenki-mcp
/plugin install tenki@tenki
```

Requires Node.js 22+ (`npx` fetches the server on first start).
