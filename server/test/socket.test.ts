import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HostSocket } from "../src/socket.js";
import type { AnnotationResult } from "../src/types.js";

const TOKEN = "deadbeefcafe";

interface Harness {
  socketPath: string;
  tokenPath: string;
  server: net.Server;
  conns: net.Socket[];
  received: string[];
  cleanup: () => void;
}

function startStubHost(): Promise<Harness> {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-annotate-sock-"));
    const socketPath = path.join(dir, "host.sock");
    const tokenPath = path.join(dir, "host.token");
    fs.writeFileSync(tokenPath, TOKEN + "\n");

    const conns: net.Socket[] = [];
    const received: string[] = [];
    const server = net.createServer((conn) => {
      conns.push(conn);
      let buf = "";
      conn.on("data", (d) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const l of lines) if (l.trim()) received.push(l);
      });
    });
    server.listen(socketPath, () => {
      resolve({
        socketPath,
        tokenPath,
        server,
        conns,
        received,
        cleanup: () => {
          for (const c of conns) c.destroy();
          server.close();
          fs.rmSync(dir, { recursive: true, force: true });
        },
      });
    });
  });
}

function emit(h: Harness, obj: unknown) {
  h.conns[0].write(JSON.stringify(obj) + "\n");
}

// emit a raw string fragment (for framing tests)
function emitRaw(h: Harness, s: string) {
  h.conns[0].write(s);
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("HostSocket", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startStubHost();
  });
  afterEach(() => {
    h.cleanup();
  });

  test("connect() reads token and sends AUTH", async () => {
    const s = new HostSocket({ socketPath: h.socketPath, tokenPath: h.tokenPath });
    await s.connect();
    await tick();
    expect(h.received).toContain(JSON.stringify({ type: "AUTH", token: TOKEN }));
    s.close();
  });

  test("connect() rejects clearly when token file is missing", async () => {
    const s = new HostSocket({ socketPath: h.socketPath, tokenPath: h.tokenPath + ".nope" });
    await expect(s.connect()).rejects.toThrow(/token/i);
  });

  test("ANNOTATIONS_COMPLETE resolves the matching pending request", async () => {
    const s = new HostSocket({ socketPath: h.socketPath, tokenPath: h.tokenPath });
    await s.connect();
    const result: AnnotationResult = { success: true, url: "http://x/", elements: [] };
    const p = new Promise<AnnotationResult>((res) => s.onResult(42, res));
    await tick();
    emit(h, { type: "ANNOTATIONS_COMPLETE", requestId: 42, result });
    expect(await p).toEqual(result);
    s.close();
  });

  test("message split across two TCP chunks still parses", async () => {
    const s = new HostSocket({ socketPath: h.socketPath, tokenPath: h.tokenPath });
    await s.connect();
    const result: AnnotationResult = { success: true, url: "http://y/", elements: [] };
    const p = new Promise<AnnotationResult>((res) => s.onResult(7, res));
    await tick();
    const full = JSON.stringify({ type: "ANNOTATIONS_COMPLETE", requestId: 7, result }) + "\n";
    emitRaw(h, full.slice(0, 15));
    await tick();
    emitRaw(h, full.slice(15));
    expect(await p).toEqual(result);
    s.close();
  });

  test("CANCEL resolves matching pending as cancelled", async () => {
    const s = new HostSocket({ socketPath: h.socketPath, tokenPath: h.tokenPath });
    await s.connect();
    const p = new Promise<AnnotationResult>((res) => s.onResult(9, res));
    await tick();
    emit(h, { type: "CANCEL", requestId: 9, reason: "user" });
    const r = await p;
    expect(r.success).toBe(false);
    expect(r.cancelled).toBe(true);
    expect(r.reason).toBe("user");
    s.close();
  });

  test("SESSION_REPLACED resolves all pending as cancelled with reason", async () => {
    const s = new HostSocket({ socketPath: h.socketPath, tokenPath: h.tokenPath });
    await s.connect();
    const p1 = new Promise<AnnotationResult>((res) => s.onResult(1, res));
    const p2 = new Promise<AnnotationResult>((res) => s.onResult(2, res));
    await tick();
    emit(h, { type: "SESSION_REPLACED", reason: "Another terminal started annotation" });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.cancelled).toBe(true);
    expect(r1.reason).toBe("Another terminal started annotation");
    expect(r2.cancelled).toBe(true);
    s.close();
  });

  test("socket close resolves pending as connection_lost", async () => {
    const s = new HostSocket({ socketPath: h.socketPath, tokenPath: h.tokenPath });
    await s.connect();
    const p = new Promise<AnnotationResult>((res) => s.onResult(5, res));
    await tick();
    h.conns[0].destroy();
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(r.reason).toBe("connection_lost");
    s.close();
  });

  test("clearPending removes a resolver so later messages are ignored", async () => {
    const s = new HostSocket({ socketPath: h.socketPath, tokenPath: h.tokenPath });
    await s.connect();
    let resolved = false;
    s.onResult(11, () => {
      resolved = true;
    });
    await tick();
    s.clearPending(11);
    emit(h, { type: "ANNOTATIONS_COMPLETE", requestId: 11, result: { success: true } });
    await tick();
    expect(resolved).toBe(false);
    s.close();
  });
});
