import { describe, test, expect, beforeAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";
import { startStubHost, type Harness } from "./stub-host.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BIN = path.join(ROOT, "dist", "index.js");

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** Minimal newline-delimited JSON-RPC client over a child process's stdio. */
class RpcClient {
  private buf = "";
  private waiters: Array<{ id: number; res: (v: any) => void }> = [];
  constructor(private child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (d) => {
      this.buf += d.toString();
      const lines = this.buf.split("\n");
      this.buf = lines.pop() || "";
      for (const l of lines) {
        if (!l.trim()) continue;
        const msg = JSON.parse(l);
        if (msg.id !== undefined) {
          const i = this.waiters.findIndex((w) => w.id === msg.id);
          if (i >= 0) {
            this.waiters[i].res(msg);
            this.waiters.splice(i, 1);
          }
        }
      }
    });
  }
  notify(method: string, params?: unknown) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  request(id: number, method: string, params?: unknown): Promise<any> {
    const p = new Promise<any>((res) => this.waiters.push({ id, res }));
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  }
}

describe("end-to-end: built binary over stdio", () => {
  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
  });

  test("initialize → tools/list shows annotate → tools/call returns annotation + image", async () => {
    const h: Harness = await startStubHost();
    const child = spawn("node", [BIN], {
      env: {
        ...process.env,
        PI_ANNOTATE_SOCKET: h.socketPath,
        PI_ANNOTATE_TOKEN: h.tokenPath,
      },
    }) as ChildProcessWithoutNullStreams;

    try {
      const rpc = new RpcClient(child);

      const init = await rpc.request(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0" },
      });
      expect(init.result.serverInfo.name).toBe("pi-annotate");

      rpc.notify("notifications/initialized");

      const list = await rpc.request(2, "tools/list");
      const names = list.result.tools.map((t: any) => t.name);
      expect(names).toContain("annotate");

      // Fire the tool call; respond from the stub host once START_ANNOTATION lands.
      const callP = rpc.request(3, "tools/call", {
        name: "annotate",
        arguments: { url: "http://localhost:3000/" },
      });
      const start = await h.waitFor((m) => m.type === "START_ANNOTATION", 3000);
      h.emit({
        type: "ANNOTATIONS_COMPLETE",
        requestId: start.requestId,
        result: {
          success: true,
          url: "http://localhost:3000/",
          viewport: { width: 1280, height: 720 },
          elements: [
            { selector: ".btn", tag: "button", id: null, classes: ["btn"], text: "Buy", rect: { x: 0, y: 0, width: 80, height: 30 }, attributes: {}, comment: "too small" },
          ],
          screenshots: [{ index: 1, dataUrl: `data:image/png;base64,${PNG_B64}` }],
        },
      });

      const call = await callP;
      const content = call.result.content;
      const textBlock = content.find((c: any) => c.type === "text");
      const imageBlock = content.find((c: any) => c.type === "image");
      expect(textBlock.text).toContain("## Page Annotation: http://localhost:3000/");
      expect(textBlock.text).toContain("**Comment:** too small");
      expect(imageBlock).toMatchObject({ type: "image", data: PNG_B64, mimeType: "image/png" });
    } finally {
      child.kill();
      h.cleanup();
    }
  }, 20000);
});
