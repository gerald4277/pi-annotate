#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HostSocket } from "./socket.js";
import { runAnnotate } from "./handler.js";

const SOCKET_PATH = process.env.PI_ANNOTATE_SOCKET ?? "/tmp/pi-annotate.sock";
const TOKEN_PATH = process.env.PI_ANNOTATE_TOKEN ?? "/tmp/pi-annotate.token";

const socket = new HostSocket({ socketPath: SOCKET_PATH, tokenPath: TOKEN_PATH });

const server = new McpServer({ name: "pi-annotate", version: "0.1.0" });

server.tool(
  "annotate",
  "Open visual annotation mode in the browser so the user can click/select elements and add " +
    "comments. Only use when the user explicitly asks to annotate, visually point something out, " +
    "or show you UI issues. Returns structured annotations with CSS selectors, box model, " +
    "accessibility info, the user's comments, and screenshots. If no URL is provided, uses the " +
    "current active browser tab.",
  {
    url: z
      .string()
      .optional()
      .describe("URL to annotate. If omitted, uses the current browser tab."),
    timeout: z
      .number()
      .optional()
      .describe("Max seconds to wait for annotations. Default: 600 (10 min)."),
  },
  async (args, extra) => {
    const out = await runAnnotate(socket, args, extra.signal, { now: () => Date.now() });
    const content = out.content.map((c) =>
      c.type === "text"
        ? ({ type: "text" as const, text: c.text ?? "" })
        : ({ type: "image" as const, data: c.data ?? "", mimeType: c.mimeType ?? "image/png" }),
    );
    return { content, isError: out.isError };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[pi-annotate] MCP server ready on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`[pi-annotate] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
