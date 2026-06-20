# pi-annotate → Claude Code MCP Port — Design

**Date:** 2026-06-19
**Status:** Approved (design), pending spec review
**Goal:** Make pi-annotate's browser visual-annotation workflow usable from Claude Code by replacing the Pi extension layer with an MCP server, reusing the Chrome extension and native host unchanged.

## Background

[pi-annotate](https://github.com/nicobailon/pi-annotate) lets a user click elements in a web page, drop comment cards, and capture screenshots; structured element data (selectors, box model, a11y, CSS) plus comments are delivered to an AI agent for UI fixes. It targets **Pi** (`@mariozechner/pi-coding-agent`).

Architecture is a three-layer Unix-socket bridge:

```
Chrome extension ──native messaging──> host.cjs ──unix socket──> Pi layer (index.ts)
  content.js picker UI       (length-prefixed)   /tmp/pi-annotate.sock   /annotate command + tool
  background.js screenshots                       token auth
```

**Key finding from source review:** `host.cjs` is Pi-agnostic. It generates a token at `/tmp/pi-annotate.token`, listens on `/tmp/pi-annotate.sock` (mode `0o600`), authenticates clients via `{"type":"AUTH","token":...}`, then blindly relays newline-delimited JSON between the socket and Chrome native messaging. It knows nothing about Pi. Therefore the **Chrome extension and native host are reused verbatim** — the only Pi coupling lives in `index.ts`.

## Scope (decided)

- **Faithful MCP port.** Keep extension + native host as-is. Replace only the Pi command/tool layer with an MCP server exposing an `annotate` tool.
- **Reuse the Unix socket transport.** The MCP server is a drop-in replacement for the Pi *client* side of the socket protocol.
- **Packaging:** fork this repo; add a `server/` directory containing the MCP server alongside the unchanged `chrome-extension/`.
- **Screenshots:** return to Claude Code BOTH as inline image content blocks (seen immediately) AND as files written to the OS temp dir with paths in the markdown (durable). This is the one intentional deviation from the original, which returns paths only.

Out of scope: rewriting the picker UI, changing the socket/native-messaging protocol, multi-session coordination changes, Windows native-messaging path differences.

## Architecture (after port)

```
Chrome extension (UNCHANGED) ──native msg──> host.cjs (UNCHANGED) ──unix socket──> [NEW] server/ MCP ──stdio──> Claude Code
                                                                  /tmp/pi-annotate.sock      annotate tool
```

The only new artifact is `server/` — a standalone Node MCP server (stdio transport) registered with Claude Code via `claude mcp add`.

## The MCP server (single new component)

Built on `@modelcontextprotocol/sdk`, stdio transport. Internally three concerns, each independently testable:

### 1. Socket client (`socket.ts`)
Ports the connection logic from `index.ts` lines 70–148 verbatim in behavior:
- Read token from `/tmp/pi-annotate.token`; on failure return a clear "host not running" error.
- `net.createConnection("/tmp/pi-annotate.sock")`; on `connect` send `{"type":"AUTH","token":<token>}`.
- Newline-delimited JSON framing; 32 MB buffer cap (`MAX_SOCKET_BUFFER`); overflow destroys the socket.
- Buffer/split on `\n`, parse each complete line, dispatch to a message handler.
- On `close`: resolve all pending requests as `{success:false, cancelled:true, reason:"connection_lost", ...}`.
- **Lazy connect:** the socket only exists once Chrome + extension + host are live. Connect on first `annotate` call; if it fails, return an actionable error: *"Browser extension not connected. Load the extension, run `chrome-extension/native/install.sh <ext-id>`, click the Pi Annotate icon to wake the worker, then retry."*

Message handler mirrors `handleMessage` (lines 160–222):
- `SESSION_REPLACED` → resolve pending as cancelled with the given reason; null the socket.
- `ANNOTATIONS_COMPLETE` → if `requestId` matches a pending request, resolve it with `msg.result`.
- `CANCEL` → resolve matching pending request as cancelled.

### 2. Result formatter (`format.ts`)
Port `formatResult` + `formatEditCapture` (lines 228–480) **verbatim** — they are pure functions over `AnnotationResult` with no Pi dependencies. They already write screenshots to `os.tmpdir()` as `pi-annotate-<ts>-{full,elN,before,after}.png` and embed those paths in the markdown.

**One refactor for the "inline images" requirement:** change the return type from `string` to `{ text: string; images: Array<{ path: string; base64: string; mime: string }> }`. As each screenshot is decoded and written, also push its base64 + path into `images`. The markdown text is unchanged (still lists the file paths). `types.ts` is copied verbatim.

### 3. Tool registration (`index.ts` of server)
Replaces `pi.registerTool` (lines 486–579) with an MCP tool:
- Name `annotate`; same description/promptSnippet text.
- Params via **zod** (MCP SDK convention) instead of typebox: `{ url?: string, timeout?: number = 300 }`.
- Handler:
  1. `await connect()` (lazy). On failure → MCP error result with the actionable message above.
  2. `requestId = Date.now()` (standalone Node — no workflow `Date.now()` restriction applies).
  3. Register a pending resolver keyed by `requestId`.
  4. Wire the MCP-provided `AbortSignal` (from request `extra.signal`) → on abort send `{"type":"CANCEL",requestId,reason:"aborted"}` and resolve.
  5. `setTimeout(timeout*1000)` → send `{"type":"CANCEL",requestId,reason:"timeout"}`, resolve with timeout message.
  6. Send `{"type":"START_ANNOTATION",requestId,url}`.
  7. On resolve: call the formatter, return MCP content = `[{type:"text", text}, ...images.map(i => ({type:"image", data:i.base64, mimeType:i.mime}))]`.

`pi.registerCommand`, `pi.sendUserMessage`, and `ctx.ui.notify` are dropped — MCP has no slash-command or push-message channel; the single tool is the whole interface. Status/log lines that used `setStatus`/`notify` go to `stderr` (safe for stdio MCP; never stdout).

## Data flow (happy path)

1. User: "open annotation on localhost:3000 and fix what I point at."
2. Claude Code calls `annotate({url:"localhost:3000"})`.
3. MCP server connects to socket, AUTHs, sends `START_ANNOTATION`.
4. host relays → extension opens the tab, shows the picker.
5. User clicks elements, adds comments, finishes.
6. Extension sends `ANNOTATIONS_COMPLETE` with `AnnotationResult` → host → MCP server.
7. Formatter builds markdown + writes PNGs + collects base64.
8. Tool returns text + inline image blocks.
9. Claude Code reads annotations + screenshots and edits the code.

## Error handling

| Case | Behavior |
|------|----------|
| Token file missing / socket absent | Lazy-connect fails → actionable "host not running" error result. |
| Socket buffer overflow (>32 MB) | Destroy socket; pending → `connection_lost`. |
| Timeout (default 300 s) | Send `CANCEL{reason:timeout}`; return "timed out after Ns". |
| Client/tool abort | Send `CANCEL{reason:aborted}`; return "aborted". |
| User cancels in browser | `CANCEL` → "Annotation cancelled by user." |
| Another terminal takes over | `SESSION_REPLACED` → "Annotation session ended: <reason>". |
| Screenshot > 15 MB or malformed | Per-image try/catch; markdown notes "capture failed"; image omitted from inline blocks. |

## Testing

- **format.ts** — unit tests over hand-built `AnnotationResult` fixtures (success with elements, box model, a11y, debug data, edit capture, cancelled, failed, oversized screenshot). Pure functions → fully deterministic. Assert markdown shape and that `images[]` is populated for valid screenshots only.
- **socket.ts** — integration test against a stub Unix-socket server that performs the AUTH handshake and emits scripted `ANNOTATIONS_COMPLETE` / `CANCEL` / `SESSION_REPLACED` lines; assert pending-request resolution, buffer splitting across chunk boundaries, and overflow handling.
- **tool handler** — drive `annotate` against the stub socket; assert START_ANNOTATION is sent, timeout/abort send CANCEL, and the MCP result contains text + image blocks.
- **Manual end-to-end** — load the extension, run `install.sh`, `claude mcp add pi-annotate -- node server/dist/index.js`, restart Claude Code, call the tool, annotate a real page, confirm I receive markdown + images.

## Install (end state)

1. `cd server && npm install && npm run build`
2. Load `chrome-extension/` in Chrome (Developer Mode) → note extension ID.
3. `cd chrome-extension/native && ./install.sh <extension-id>`; restart browser.
4. `claude mcp add pi-annotate -- node /abs/path/server/dist/index.js`
5. Restart Claude Code; the `annotate` tool is available.

## Risks / open notes

- **Blocking tool call.** `annotate` blocks up to `timeout` seconds while the user annotates — inherent to the design; original behaves identically.
- **Single in-flight session.** Like the original, one annotation at a time; `SESSION_REPLACED` covers contention.
- **Image payload size.** Inline image blocks add tokens. The 15 MB per-file cap is preserved; large pages still write files and may be omitted from inline blocks on failure.
- **stdio hygiene.** All diagnostics MUST go to stderr; stdout is reserved for MCP framing.
