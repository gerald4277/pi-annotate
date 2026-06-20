# claude-annotate-mcp

Claude Code MCP server for [claude-annotate](https://github.com/nicobailon/claude-annotate)'s browser
visual-annotation workflow. Drop-in replacement for the Pi extension layer: it speaks the same
Unix-socket protocol to the unchanged Chrome extension + native host, and exposes a single
`annotate` MCP tool to Claude Code.

```
Chrome extension ──native msg──> host.cjs ──unix socket──> [this] MCP server ──stdio──> Claude Code
   (unchanged)                   (unchanged)   /tmp/claude-annotate.sock      annotate tool
```

## How it works

Calling the `annotate` tool opens the browser picker. You click elements, add comment cards, and
finish; the tool returns structured markdown (selectors, box model, accessibility, your comments)
plus screenshots — returned both as inline image blocks (seen immediately) and as PNG files in the
OS temp dir.

## Install

1. **Build the server**
   ```bash
   cd server
   npm install
   npm run build
   ```
2. **Load the extension** — open `chrome://extensions`, enable Developer Mode, "Load unpacked" →
   select the repo's `chrome-extension/` folder. Note the extension ID.
3. **Register the native host**
   ```bash
   cd ../chrome-extension/native
   ./install.sh <extension-id>
   ```
   Restart the browser.
4. **Register with Claude Code**
   ```bash
   claude mcp add claude-annotate -- node /absolute/path/to/server/dist/index.js
   ```
5. Restart Claude Code. The `annotate` tool is now available.

## Tool: `annotate`

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `url` | string (optional) | current tab | Page to annotate. |
| `timeout` | number (optional) | `600` | Max seconds to wait while you annotate. |

The call blocks until you finish annotating, cancel, or the timeout elapses. Claude Code's own
tool timeout, if shorter, aborts the call cleanly (a `CANCEL` is sent to the host).

## Config

Override socket/token paths via env (mainly for testing):

- `PI_ANNOTATE_SOCKET` (default `/tmp/claude-annotate.sock`)
- `PI_ANNOTATE_TOKEN` (default `/tmp/claude-annotate.token`)

## Develop / test

```bash
npm test          # vitest run (unit + integration + e2e)
npm run test:watch
```

- `src/format.ts` — pure result → markdown + image list (ported verbatim from `index.ts`).
- `src/socket.ts` — Unix-socket client: AUTH, newline-JSON framing, per-requestId resolvers.
- `src/handler.ts` — `runAnnotate`: connect → START_ANNOTATION → await, with timeout/abort → CANCEL.
- `src/index.ts` — MCP server wiring (stdio transport, `annotate` tool).

Tests drive a stub Unix-socket host (`test/stub-host.ts`); the e2e test spawns the built binary and
runs a full MCP handshake. The only leg that cannot be automated is the human click in the browser.
