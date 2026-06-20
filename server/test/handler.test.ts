import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HostSocket } from "../src/socket.js";
import { runAnnotate } from "../src/handler.js";
import { startStubHost, type Harness } from "./stub-host.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-annotate-h-"));
}

describe("runAnnotate", () => {
  let h: Harness;
  let dir: string;
  beforeEach(async () => {
    h = await startStubHost();
    dir = mkTmp();
  });
  afterEach(() => {
    h.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function socket(): HostSocket {
    return new HostSocket({ socketPath: h.socketPath, tokenPath: h.tokenPath, log: () => {} });
  }

  test("sends START_ANNOTATION with the url and request id", async () => {
    const s = socket();
    const p = runAnnotate(s, { url: "http://localhost:3000/" }, undefined, {
      now: () => 555,
      tmpDir: dir,
    });
    const start = await h.waitFor((m) => m.type === "START_ANNOTATION");
    expect(start).toMatchObject({ type: "START_ANNOTATION", requestId: 555, url: "http://localhost:3000/" });
    h.emit({ type: "ANNOTATIONS_COMPLETE", requestId: 555, result: { success: true, url: "http://localhost:3000/", elements: [] } });
    await p;
    s.close();
  });

  test("returns formatted text on completion", async () => {
    const s = socket();
    const p = runAnnotate(s, {}, undefined, { now: () => 1, tmpDir: dir });
    await h.waitFor((m) => m.type === "START_ANNOTATION");
    h.emit({
      type: "ANNOTATIONS_COMPLETE",
      requestId: 1,
      result: {
        success: true,
        url: "http://x/",
        viewport: { width: 10, height: 10 },
        elements: [
          { selector: ".a", tag: "div", id: null, classes: [], text: "", rect: { x: 0, y: 0, width: 5, height: 5 }, attributes: {} },
        ],
      },
    });
    const out = await p;
    expect(out.isError).toBeFalsy();
    expect(out.content[0]).toMatchObject({ type: "text" });
    expect(out.content[0].text).toContain("## Page Annotation: http://x/");
    s.close();
  });

  test("returns inline image blocks plus text when screenshots present", async () => {
    const s = socket();
    const p = runAnnotate(s, {}, undefined, { now: () => 2, tmpDir: dir });
    await h.waitFor((m) => m.type === "START_ANNOTATION");
    h.emit({
      type: "ANNOTATIONS_COMPLETE",
      requestId: 2,
      result: {
        success: true,
        url: "http://x/",
        viewport: { width: 1, height: 1 },
        elements: [],
        screenshots: [{ index: 1, dataUrl: PNG_DATA_URL }],
      },
    });
    const out = await p;
    const imageBlocks = out.content.filter((c) => c.type === "image");
    expect(imageBlocks).toHaveLength(1);
    expect(imageBlocks[0]).toMatchObject({ type: "image", data: PNG_B64, mimeType: "image/png" });
    s.close();
  });

  test("timeout sends CANCEL{reason:timeout} and returns timeout message", async () => {
    const s = socket();
    const p = runAnnotate(s, { timeout: 0.05 }, undefined, { now: () => 3, tmpDir: dir });
    const cancel = await h.waitFor((m) => m.type === "CANCEL");
    expect(cancel).toMatchObject({ type: "CANCEL", requestId: 3, reason: "timeout" });
    const out = await p;
    expect(out.content[0].text).toContain("timed out after 0.05s");
    s.close();
  });

  test("abort sends CANCEL{reason:aborted} and returns aborted message", async () => {
    const s = socket();
    const ac = new AbortController();
    const p = runAnnotate(s, {}, ac.signal, { now: () => 4, tmpDir: dir });
    await h.waitFor((m) => m.type === "START_ANNOTATION");
    ac.abort();
    const cancel = await h.waitFor((m) => m.type === "CANCEL");
    expect(cancel).toMatchObject({ type: "CANCEL", requestId: 4, reason: "aborted" });
    const out = await p;
    expect(out.content[0].text).toContain("aborted");
    s.close();
  });

  test("already-aborted signal returns immediately without START", async () => {
    const s = socket();
    await s.connect();
    const ac = new AbortController();
    ac.abort();
    const out = await runAnnotate(s, {}, ac.signal, { now: () => 99, tmpDir: dir });
    expect(out.content[0].text).toContain("aborted");
    expect(h.received.some((l) => l.includes("START_ANNOTATION"))).toBe(false);
    s.close();
  });

  test("connect failure returns actionable error, not a throw", async () => {
    const s = new HostSocket({
      socketPath: h.socketPath,
      tokenPath: h.tokenPath + ".missing",
      log: () => {},
    });
    const out = await runAnnotate(s, {}, undefined, { now: () => 5, tmpDir: dir });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/not connected/i);
    s.close();
  });
});
