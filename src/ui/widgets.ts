/**
 * MCP Apps UI resources (https://apps.extensions.modelcontextprotocol.io).
 *
 * Three self-contained HTML widgets that MCP Apps hosts (assistant-ui's
 * McpAppRenderer, Claude, ChatGPT, …) render in a sandboxed iframe next to a
 * tool call:
 *
 *   ui://luxor/terminal  ← tenki_run_code, tenki_exec          (stdout/stderr/exit code)
 *   ui://luxor/preview   ← tenki_expose_port, tenki_create_preview_url (live iframe of the URL)
 *   ui://luxor/files     ← tenki_list_files, tenki_read_file    (browsable listing / file viewer)
 *
 * A tool opts in through `_meta.ui.resourceUri` (plus the legacy flat
 * `_meta["ui/resourceUri"]` key some hosts still read), attached centrally by
 * the registration guard in server.ts from UI_RESOURCE_FOR_TOOL below. Hosts
 * that don't speak MCP Apps ignore the key and keep using the text content, so
 * nothing changes for them.
 *
 * Every widget is one HTML document with inline CSS/JS and no external
 * fetches: the host's default CSP (`default-src 'none'`, inline allowed) is
 * enough. The preview widget additionally declares `frameDomains` for the
 * sandbox preview hosts it embeds.
 *
 * Sandbox output is untrusted (SECURITY.md): widgets only ever insert it with
 * textContent, never innerHTML, and only open http(s) URLs.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { toolName } from "../toolNames.js";

export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

export const UI_TERMINAL = "ui://luxor/terminal";
export const UI_PREVIEW = "ui://luxor/preview";
export const UI_FILES = "ui://luxor/files";

/** Which tools render with which widget (canonical tenki_* names). */
export const UI_RESOURCE_FOR_TOOL: Readonly<Record<string, string>> = {
	tenki_run_code: UI_TERMINAL,
	tenki_exec: UI_TERMINAL,
	tenki_expose_port: UI_PREVIEW,
	tenki_create_preview_url: UI_PREVIEW,
	tenki_list_files: UI_FILES,
	tenki_read_file: UI_FILES,
};

/** `_meta` for a tool that renders with a widget, or undefined. */
export function uiMetaFor(name: string): Record<string, unknown> | undefined {
	const resourceUri = UI_RESOURCE_FOR_TOOL[name];
	if (!resourceUri) return undefined;
	return { ui: { resourceUri }, "ui/resourceUri": resourceUri };
}

/**
 * Origins sandbox preview URLs are served from
 * (https://<slug>--<workspace>.<region>.sb.tenki.sh). A CSP host wildcard
 * matches any depth of subdomain, so one entry covers every region.
 */
export const PREVIEW_FRAME_DOMAINS = ["https://*.sb.tenki.sh"];

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const BASE_CSS = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1c1d21;--muted:#6b6f7a;--border:#e3e4e8;--panel:#f6f7f9;--accent:#3d5afe;--ok:#16a34a;--err:#dc2626;--warn:#b45309;--code-bg:#0f1115;--code-fg:#e6e8ee;--code-err:#ff8a80;
font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:13px}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#16171b;--fg:#e8e9ed;--muted:#9a9eaa;--border:#2c2e35;--panel:#1d1f24;--accent:#8c9eff;--ok:#4ade80;--err:#f87171;--warn:#fbbf24}}
:root[data-theme=dark]{--bg:#16171b;--fg:#e8e9ed;--muted:#9a9eaa;--border:#2c2e35;--panel:#1d1f24;--accent:#8c9eff;--ok:#4ade80;--err:#f87171;--warn:#fbbf24}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg)}
.card{border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--bg)}
.bar{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--panel);border-bottom:1px solid var(--border);min-height:34px}
.title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.muted{color:var(--muted)}
.badge{font-size:11px;font-weight:600;padding:2px 7px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.badge.ok{color:var(--ok)}.badge.err{color:var(--err)}.badge.warn{color:var(--warn)}
button{font:inherit;font-size:12px;color:var(--fg);background:transparent;border:1px solid var(--border);border-radius:6px;padding:3px 8px;cursor:pointer;white-space:nowrap}
button:hover{border-color:var(--accent);color:var(--accent)}button:disabled{opacity:.5;cursor:default}
.empty{padding:18px 12px;color:var(--muted);text-align:center}
.note{padding:6px 10px;font-size:12px;color:var(--warn);border-top:1px solid var(--border);background:var(--panel)}
.error{padding:10px 12px;color:var(--err);white-space:pre-wrap;word-break:break-word}
`;

/**
 * Minimal MCP Apps guest bridge: JSON-RPC 2.0 over postMessage to the host.
 * Exposes window.mcpApp = { onInput(fn), onResult(fn), callTool(name,args), openLink(url) }.
 * Handshake: ui/initialize → ui/notifications/initialized; the host then sends
 * ui/notifications/tool-input and ui/notifications/tool-result. Content size
 * is reported with ui/notifications/size-changed so the host can fit the frame.
 */
const BRIDGE_JS = `
(function(){
  var nextId=1,pending={},inputFns=[],resultFns=[],lastInput=null,lastResult=null;
  var host=window.parent; // captured before any widget code can shadow the global
  function post(m){try{host.postMessage(m,"*")}catch(e){}}
  function request(method,params){var id=nextId++;post({jsonrpc:"2.0",id:id,method:method,params:params||{}});
    return new Promise(function(res,rej){pending[id]={res:res,rej:rej};setTimeout(function(){if(pending[id]){delete pending[id];rej(new Error(method+" timed out"))}},30000)})}
  function notify(method,params){post({jsonrpc:"2.0",method:method,params:params||{}})}
  function applyContext(ctx){if(!ctx)return;if(ctx.theme==="dark"||ctx.theme==="light")document.documentElement.setAttribute("data-theme",ctx.theme)}
  window.addEventListener("message",function(ev){
    if(ev.source!==host)return;var m=ev.data;if(!m||m.jsonrpc!=="2.0")return;
    if(m.id!=null&&!m.method){var p=pending[m.id];if(!p)return;delete pending[m.id];
      if(m.error)p.rej(new Error(m.error.message||"request failed"));else p.res(m.result);return}
    if(m.id!=null&&m.method){ // host → app request: answer teardown, reject the rest
      if(m.method==="ui/resource-teardown")post({jsonrpc:"2.0",id:m.id,result:{}});
      else post({jsonrpc:"2.0",id:m.id,error:{code:-32601,message:"method not found"}});return}
    var params=m.params||{};
    if(m.method==="ui/notifications/tool-input"){lastInput=params.arguments||{};inputFns.forEach(function(f){f(lastInput)})}
    else if(m.method==="ui/notifications/tool-result"){lastResult=params;resultFns.forEach(function(f){f(lastResult)})}
    else if(m.method==="ui/notifications/host-context-changed"){applyContext(params)}
  });
  var lastH=0;function reportSize(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);
    if(h&&h!==lastH){lastH=h;notify("ui/notifications/size-changed",{height:h})}}
  if(window.ResizeObserver)new ResizeObserver(reportSize).observe(document.documentElement);
  window.mcpApp={
    onInput:function(f){inputFns.push(f);if(lastInput)f(lastInput)},
    onResult:function(f){resultFns.push(f);if(lastResult)f(lastResult)},
    input:function(){return lastInput||{}},
    callTool:function(name,args){return request("tools/call",{name:name,arguments:args||{}})},
    openLink:function(url){return request("ui/open-link",{url:url})},
    /** Structured payload of a CallToolResult: structuredContent, else the first text block parsed as JSON. */
    payload:function(r){if(!r)return null;if(r.structuredContent&&typeof r.structuredContent==="object")return r.structuredContent;
      var c=(r.content||[]).filter(function(b){return b&&b.type==="text"});if(!c.length)return null;
      try{return JSON.parse(c[0].text)}catch(e){return {__text:c.map(function(b){return b.text}).join("\\n")}}},
    errorText:function(r){if(!r||!r.isError)return null;return (r.content||[]).filter(function(b){return b&&b.type==="text"}).map(function(b){return b.text}).join("\\n")||"Tool call failed"},
    reportSize:reportSize
  };
  request("ui/initialize",{protocolVersion:"2026-01-26",appInfo:{name:"luxor-widgets",version:"1"},appCapabilities:{availableDisplayModes:["inline"]}})
    .then(function(r){applyContext(r&&r.hostContext);notify("ui/notifications/initialized",{});reportSize()})
    .catch(function(){notify("ui/notifications/initialized",{})});
})();
// tiny DOM helper: el("div",{class:"x"},[children|strings]) — text is always set via textContent.
function el(tag,attrs,kids){var n=document.createElement(tag);if(attrs)for(var k in attrs){if(k==="text")n.textContent=attrs[k];else if(k.slice(0,2)==="on")n.addEventListener(k.slice(2),attrs[k]);else n.setAttribute(k,attrs[k])}
  (kids||[]).forEach(function(c){if(c!=null)n.appendChild(typeof c==="string"?document.createTextNode(c):c)});return n}
function stripAnsi(s){return String(s||"").replace(/\\u001b\\[[0-9;?]*[ -\\/]*[@-~]/g,"").replace(/\\u001b\\][^\\u0007]*(\\u0007|\\u001b\\\\)/g,"")}
function fmtBytes(n){n=Number(n);if(!isFinite(n))return "";if(n<1024)return n+" B";var u=["KB","MB","GB"],i=-1;do{n/=1024;i++}while(n>=1024&&i<2);return n.toFixed(n<10?1:0)+" "+u[i]}
`;

function page(title: string, css: string, body: string, js: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${BASE_CSS}${css}</style></head>
<body>${body}<script>${BRIDGE_JS}
(function(){"use strict";${js}})();</script></body></html>`;
}

// ---------------------------------------------------------------------------
// Terminal widget
// ---------------------------------------------------------------------------

function terminalHtml(): string {
	return page(
		"Luxor terminal",
		`
pre.out{margin:0;padding:10px 12px;background:var(--code-bg);color:var(--code-fg);white-space:pre-wrap;word-break:break-word;max-height:420px;overflow:auto;line-height:1.45}
pre.out .e{color:var(--code-err)}pre.out .cmd{color:#9fa8da}
`,
		`<div class="card"><div class="bar"><span class="title mono" id="cmd">Waiting for command…</span><span id="status" class="badge warn">running</span></div>
<pre class="out mono" id="out"></pre><div id="notes"></div></div>`,
		`
var cmdEl=document.getElementById("cmd"),statusEl=document.getElementById("status"),out=document.getElementById("out"),notes=document.getElementById("notes");
function shellQuote(a){return /^[\\w@%+=:,./-]+$/.test(a)?a:"'"+String(a).replace(/'/g,"'\\\\''")+"'"}
function commandLine(o){if(!o)return "";if(o.code!=null)return (o.language||"code")+" snippet";return [o.command].concat(o.args||[]).filter(function(x){return x!=null}).map(shellQuote).join(" ")}
mcpApp.onInput(function(a){
  cmdEl.textContent=a.code!=null?"run "+(a.language||"code"):"$ "+commandLine(a);
  if(a.code!=null){out.textContent="";out.appendChild(el("span",{class:"cmd",text:a.code.replace(/\\s+$/,"")+"\\n"}))}
});
mcpApp.onResult(function(r){
  var err=mcpApp.errorText(r);out.textContent="";notes.textContent="";
  if(err){statusEl.className="badge err";statusEl.textContent="error";out.appendChild(el("span",{class:"e",text:err}));return}
  var p=mcpApp.payload(r)||{};
  if(p.__text){out.textContent=p.__text;statusEl.className="badge ok";statusEl.textContent="done";return}
  var input=mcpApp.input();
  cmdEl.textContent=input.code!=null||p.language?"run "+(p.language||input.language||"code"):"$ "+commandLine(p.command?p:input);
  if(p.stdout)out.appendChild(document.createTextNode(stripAnsi(p.stdout)));
  if(p.stderr)out.appendChild(el("span",{class:"e",text:stripAnsi(p.stderr)}));
  if(!p.stdout&&!p.stderr)out.appendChild(el("span",{class:"muted",text:"(no output)"}));
  var code=p.exitCode==null?0:p.exitCode;
  statusEl.className="badge "+(p.ok===false||code!==0?"err":"ok");statusEl.textContent="exit "+code;
  if(p.captureError)notes.appendChild(el("div",{class:"note",text:"Output could not be read back: "+p.captureError}));
  if(p.stdoutTruncated)notes.appendChild(el("div",{class:"note",text:"stdout truncated"+(p.stdoutPath?" — full output at "+p.stdoutPath:"")}));
  if(p.stderrTruncated)notes.appendChild(el("div",{class:"note",text:"stderr truncated"+(p.stderrPath?" — full output at "+p.stderrPath:"")}));
  out.scrollTop=out.scrollHeight;
});
`,
	);
}

// ---------------------------------------------------------------------------
// Preview widget
// ---------------------------------------------------------------------------

function previewHtml(): string {
	return page(
		"Luxor preview",
		`
.url{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.frame{display:block;width:100%;height:420px;border:0;background:#fff}
`,
		`<div class="card"><div class="bar"><span class="badge warn" id="port">port</span><span class="url mono" id="url">Waiting for preview URL…</span>
<button id="reload" disabled title="Reload">Reload</button><button id="open" disabled title="Open in a new tab">Open ↗</button></div>
<div id="body"><div class="empty">The preview appears here once the port is exposed.</div></div></div>`,
		`
var urlEl=document.getElementById("url"),portEl=document.getElementById("port"),body=document.getElementById("body"),openBtn=document.getElementById("open"),reloadBtn=document.getElementById("reload"),current=null,frame=null;
function isHttp(u){try{var p=new URL(u).protocol;return p==="https:"||p==="http:"}catch(e){return false}}
function findUrl(p){if(!p||typeof p!=="object")return null;
  var keys=["previewUrl","preview_url","url","publicUrl"];for(var i=0;i<keys.length;i++)if(typeof p[keys[i]]==="string"&&isHttp(p[keys[i]]))return p[keys[i]];
  for(var k in p){var v=p[k];if(typeof v==="string"&&isHttp(v))return v;if(v&&typeof v==="object"){var n=findUrl(v);if(n)return n}}return null}
function findPort(p){if(!p||typeof p!=="object")return null;if(typeof p.port==="number")return p.port;for(var k in p){var v=p[k];if(v&&typeof v==="object"){var n=findPort(v);if(n)return n}}return null}
mcpApp.onInput(function(a){if(a.port)portEl.textContent=":"+a.port});
mcpApp.onResult(function(r){
  var err=mcpApp.errorText(r);
  if(err){portEl.className="badge err";portEl.textContent="error";urlEl.textContent="Could not expose the port";body.textContent="";body.appendChild(el("div",{class:"error",text:err}));return}
  var p=mcpApp.payload(r),u=findUrl(p),port=findPort(p)||mcpApp.input().port;
  if(port)portEl.textContent=":"+port;
  if(!u){urlEl.textContent="No URL in the result";return}
  current=u;urlEl.textContent=u;urlEl.title=u;portEl.className="badge ok";openBtn.disabled=false;reloadBtn.disabled=false;
  body.textContent="";frame=el("iframe",{class:"frame",src:u,title:"Sandbox preview",sandbox:"allow-scripts allow-same-origin allow-forms allow-popups",referrerpolicy:"no-referrer"});
  body.appendChild(frame);
});
openBtn.addEventListener("click",function(){if(current)mcpApp.openLink(current).catch(function(){window.open(current,"_blank","noopener")})});
reloadBtn.addEventListener("click",function(){if(frame&&current){frame.src="about:blank";setTimeout(function(){frame.src=current},30)}});
`,
	);
}

// ---------------------------------------------------------------------------
// Files widget
// ---------------------------------------------------------------------------

function filesHtml(tools: { list: string; read: string }): string {
	return page(
		"Luxor files",
		`
.crumbs{display:flex;flex-wrap:wrap;gap:2px;align-items:center;flex:1;min-width:0}
.crumbs a{color:var(--accent);cursor:pointer;text-decoration:none}.crumbs a:hover{text-decoration:underline}
table{width:100%;border-collapse:collapse}td{padding:5px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
tr:last-child td{border-bottom:0}tr.row{cursor:pointer}tr.row:hover td{background:var(--panel)}
td.name{width:100%;overflow:hidden;text-overflow:ellipsis;max-width:0}td.num{text-align:right;color:var(--muted)}
.icon{display:inline-block;width:18px}
.scroll{max-height:420px;overflow:auto}
.code{display:grid;grid-template-columns:auto 1fr;margin:0;padding:8px 0;line-height:1.45}
.code .ln{color:var(--muted);text-align:right;padding:0 10px;user-select:none}.code .tx{white-space:pre-wrap;word-break:break-word;padding-right:12px}
`,
		`<div class="card"><div class="bar"><span class="crumbs mono" id="crumbs">Waiting for path…</span><span class="muted" id="meta"></span><button id="up" disabled>Up</button></div>
<div class="scroll" id="body"><div class="empty">Loading…</div></div><div id="foot"></div></div>`,
		`
var TOOLS=${JSON.stringify(tools)};
var crumbs=document.getElementById("crumbs"),meta=document.getElementById("meta"),body=document.getElementById("body"),foot=document.getElementById("foot"),upBtn=document.getElementById("up");
var sessionId=null,curPath=null,busy=false;
function join(dir,name){return dir.replace(/\\/+$/,"")+"/"+name}
function parentDir(p){var s=p.replace(/\\/+$/,"");var i=s.lastIndexOf("/");return i<=0?"/":s.slice(0,i)}
function setCrumbs(path){crumbs.textContent="";var parts=path.split("/").filter(Boolean),acc="";
  crumbs.appendChild(el("a",{text:"/",onclick:function(){go("/")}}));
  parts.forEach(function(p,i){acc+="/"+p;var target=acc;if(i>0)crumbs.appendChild(document.createTextNode("/"));
    crumbs.appendChild(i===parts.length-1?el("span",{text:p}):el("a",{text:p,onclick:function(){go(target)}}))});
  upBtn.disabled=!sessionId||path==="/"}
function showError(msg){body.textContent="";body.appendChild(el("div",{class:"error",text:msg}))}
function call(name,args){if(!sessionId)return Promise.reject(new Error("no session id"));busy=true;
  return mcpApp.callTool(name,Object.assign({session_id:sessionId},args)).then(function(r){busy=false;var e=mcpApp.errorText(r);if(e)throw new Error(e);return mcpApp.payload(r)},function(e){busy=false;throw e})}
function go(path){if(busy||!sessionId)return;meta.textContent="loading…";call(TOOLS.list,{path:path}).then(renderList,function(e){meta.textContent="";showError(e.message)})}
function openFile(path){if(busy||!sessionId)return;meta.textContent="loading…";call(TOOLS.read,{path:path}).then(function(p){renderFile(p,false)},function(e){meta.textContent="";showError(e.message)})}
function renderList(p){
  curPath=p.path;setCrumbs(curPath);foot.textContent="";body.textContent="";
  var entries=(p.entries||[]).slice().sort(function(a,b){return (b.isDir?1:0)-(a.isDir?1:0)||String(a.name).localeCompare(String(b.name))});
  meta.textContent=entries.length+" item"+(entries.length===1?"":"s");
  if(!entries.length){body.appendChild(el("div",{class:"empty",text:"Empty directory"}));return}
  var t=el("table");entries.forEach(function(e){var full=join(curPath,e.name);
    var mod=e.modifiedUnixNs?new Date(Number(String(e.modifiedUnixNs).slice(0,-6))).toLocaleString():"";
    t.appendChild(el("tr",{class:sessionId?"row":"",title:full,onclick:function(){if(!sessionId)return;e.isDir?go(full):openFile(full)}},[
      el("td",{class:"name mono"},[el("span",{class:"icon",text:e.isDir?"📁":"📄"}),String(e.name)+(e.isDir?"/":"")]),
      el("td",{class:"num",text:e.isDir?"":fmtBytes(e.size||0)}),el("td",{class:"num",text:mod})]))});
  body.appendChild(t);
}
function renderFile(p,append){
  curPath=p.path;setCrumbs(curPath);
  var text=String(p.content||"");var startLine=1;var grid;
  if(append&&(grid=body.querySelector(".code"))){startLine=Number(grid.getAttribute("data-next"))||1}
  else{body.textContent="";grid=el("div",{class:"code mono"});body.appendChild(grid)}
  var lines=text.split("\\n");if(lines.length>1&&lines[lines.length-1]==="")lines.pop();
  lines.forEach(function(l,i){grid.appendChild(el("span",{class:"ln",text:String(startLine+i)}));grid.appendChild(el("span",{class:"tx",text:l}))});
  grid.setAttribute("data-next",String(startLine+lines.length));
  meta.textContent=fmtBytes(p.totalBytes!=null?p.totalBytes:text.length);foot.textContent="";
  if(p.truncated&&p.nextOffset!=null){
    var more=el("button",{text:"Load more",onclick:function(){if(!sessionId)return;more.disabled=true;
      call(TOOLS.read,{path:p.path,offset:p.nextOffset}).then(function(n){renderFile(n,true)},function(e){more.disabled=false;showError(e.message)})}});
    if(!sessionId)more.disabled=true;
    foot.appendChild(el("div",{class:"note"},["Showing "+fmtBytes(p.nextOffset)+" of "+fmtBytes(p.totalBytes)+" ",more]))}
}
upBtn.addEventListener("click",function(){if(curPath)go(parentDir(curPath))});
mcpApp.onInput(function(a){if(a.session_id)sessionId=a.session_id;if(a.path&&!curPath)setCrumbs(a.path)});
mcpApp.onResult(function(r){var e=mcpApp.errorText(r);if(e){showError(e);return}
  var p=mcpApp.payload(r)||{};if(p.__text){body.textContent="";body.appendChild(el("pre",{class:"mono",text:p.__text}));return}
  if(Array.isArray(p.entries))renderList(p);else if(typeof p.content==="string")renderFile(p,false);else showError("Unrecognized result")});
`,
	);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** The widget HTML for each ui:// URI. Tool names are baked in with the advertised prefix. */
export function widgetHtml(uri: string): string | undefined {
	switch (uri) {
		case UI_TERMINAL:
			return terminalHtml();
		case UI_PREVIEW:
			return previewHtml();
		case UI_FILES:
			return filesHtml({ list: toolName("tenki_list_files"), read: toolName("tenki_read_file") });
		default:
			return undefined;
	}
}

const WIDGETS: { uri: string; name: string; title: string; description: string; meta: Record<string, unknown> }[] = [
	{
		uri: UI_TERMINAL,
		name: "luxor-terminal",
		title: "Luxor terminal",
		description: "Renders a sandbox command's stdout, stderr and exit code (tenki_run_code, tenki_exec).",
		meta: { ui: { prefersBorder: false } },
	},
	{
		uri: UI_PREVIEW,
		name: "luxor-preview",
		title: "Luxor preview",
		description: "Embeds a sandbox's public preview URL (tenki_expose_port, tenki_create_preview_url).",
		meta: { ui: { prefersBorder: false, csp: { frameDomains: PREVIEW_FRAME_DOMAINS } } },
	},
	{
		uri: UI_FILES,
		name: "luxor-files",
		title: "Luxor files",
		description: "Browses a sandbox directory and views files (tenki_list_files, tenki_read_file).",
		meta: { ui: { prefersBorder: false } },
	},
];

/** Register the three ui:// resources on the (unguarded) server. */
export function registerUiResources(server: McpServer): void {
	for (const w of WIDGETS) {
		server.registerResource(
			w.name,
			w.uri,
			{ title: w.title, description: w.description, mimeType: MCP_APP_MIME_TYPE, _meta: w.meta },
			async (uri) => ({
				contents: [{ uri: uri.href, mimeType: MCP_APP_MIME_TYPE, text: widgetHtml(w.uri) ?? "", _meta: w.meta }],
			}),
		);
	}
}
