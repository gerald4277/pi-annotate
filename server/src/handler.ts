import type { HostSocket } from "./socket.js";
import { formatResult } from "./format.js";

export interface AnnotateParams {
  url?: string;
  timeout?: number;
}

export interface AnnotateDeps {
  /** Source of the request id (Date.now in production; injected for tests). */
  now: () => number;
  /** Directory screenshots are written to. Defaults to the OS temp dir. */
  tmpDir?: string;
}

export interface McpContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface AnnotateOutput {
  content: McpContent[];
  isError?: boolean;
}

const NOT_CONNECTED =
  "Browser extension not connected. Load the chrome-extension/ folder in Chrome, run " +
  "chrome-extension/native/install.sh <extension-id>, click the Claude Annotate icon to wake the " +
  "service worker, then retry.";

/**
 * Drive one annotation round. Mirrors the original Pi tool `execute`:
 * connect → send START_ANNOTATION → await the result, honoring timeout and
 * abort by sending CANCEL to the host. Returns MCP tool content (text plus
 * inline image blocks for any screenshots).
 */
export async function runAnnotate(
  socket: HostSocket,
  params: AnnotateParams,
  signal: AbortSignal | undefined,
  deps: AnnotateDeps,
): Promise<AnnotateOutput> {
  const { url, timeout = 600 } = params;
  const requestId = deps.now();

  try {
    await socket.connect();
  } catch {
    return { content: [{ type: "text", text: NOT_CONNECTED }], isError: true };
  }

  if (signal?.aborted) {
    return { content: [{ type: "text", text: "Annotation was aborted." }] };
  }

  return new Promise<AnnotateOutput>((resolve) => {
    let timeoutId: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      socket.clearPending(requestId);
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (out: AnnotateOutput) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(out);
    };

    function onAbort() {
      socket.send({ type: "CANCEL", requestId, reason: "aborted" });
      finish({ content: [{ type: "text", text: "Annotation was aborted." }] });
    }

    signal?.addEventListener("abort", onAbort);

    socket.onResult(requestId, async (result) => {
      const { text, images } = await formatResult(result, {
        timestamp: deps.now(),
        tmpDir: deps.tmpDir,
      });
      const content: McpContent[] = [{ type: "text", text }];
      for (const img of images) {
        content.push({ type: "image", data: img.base64, mimeType: img.mime });
      }
      finish({ content });
    });

    timeoutId = setTimeout(() => {
      socket.send({ type: "CANCEL", requestId, reason: "timeout" });
      finish({ content: [{ type: "text", text: `Annotation timed out after ${timeout}s` }] });
    }, timeout * 1000);

    socket.send({ type: "START_ANNOTATION", requestId, url });
  });
}
