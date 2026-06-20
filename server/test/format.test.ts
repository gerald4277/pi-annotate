import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatResult } from "../src/format.js";
import type { AnnotationResult } from "../src/types.js";

const TS = 1234567890;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-annotate-test-"));
}

// 1x1 transparent PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

describe("formatResult — failure & cancel paths", () => {
  test("user cancellation", async () => {
    const r: AnnotationResult = { success: false, cancelled: true, reason: "user" };
    const { text, images } = await formatResult(r, { timestamp: TS });
    expect(text).toBe("Annotation cancelled by user.");
    expect(images).toEqual([]);
  });

  test("cancellation with reason", async () => {
    const r: AnnotationResult = { success: false, cancelled: true, reason: "timeout" };
    const { text } = await formatResult(r, { timestamp: TS });
    expect(text).toBe("Annotation cancelled: timeout");
  });

  test("session replaced by another terminal", async () => {
    const r: AnnotationResult = {
      success: false,
      cancelled: true,
      reason: "Another terminal started annotation",
    };
    const { text } = await formatResult(r, { timestamp: TS });
    expect(text).toBe("Annotation session ended: Another terminal started annotation");
  });

  test("failure with no reason", async () => {
    const r: AnnotationResult = { success: false };
    const { text } = await formatResult(r, { timestamp: TS });
    expect(text).toBe("Annotation failed: Unknown error");
  });
});

describe("formatResult — success path", () => {
  test("minimal element with no box model renders Size line", async () => {
    const r: AnnotationResult = {
      success: true,
      url: "http://localhost:3000/",
      viewport: { width: 1280, height: 720 },
      elements: [
        {
          selector: ".box",
          tag: "div",
          id: null,
          classes: [],
          text: "",
          rect: { x: 0, y: 0, width: 100, height: 40 },
          attributes: {},
        },
      ],
    };
    const { text, images } = await formatResult(r, { timestamp: TS });
    expect(text).toBe(
      "## Page Annotation: http://localhost:3000/\n" +
        "**Viewport:** 1280×720\n\n" +
        "### Selected Elements (1)\n\n" +
        "1. **div**\n" +
        "   - Selector: `.box`\n" +
        "   - Size: 100×40px\n" +
        "\n",
    );
    expect(images).toEqual([]);
  });

  test("rich element: id, classes, text, box model, attributes, a11y, comment", async () => {
    const r: AnnotationResult = {
      success: true,
      url: "http://x/",
      viewport: { width: 800, height: 600 },
      elements: [
        {
          selector: "#hero",
          tag: "section",
          id: "hero",
          classes: ["a", "b"],
          text: "Hello",
          rect: { x: 0, y: 0, width: 200, height: 100 },
          attributes: { "data-x": "1" },
          comment: "fix padding",
          boxModel: {
            content: { width: 180, height: 80 },
            padding: { top: 10, right: 10, bottom: 10, left: 10 },
            border: { top: 0, right: 0, bottom: 0, left: 0 },
            margin: { top: 5, right: 5, bottom: 5, left: 5 },
          },
          accessibility: {
            role: "region",
            name: "Hero",
            description: null,
            focusable: false,
            disabled: false,
            expanded: true,
          },
        },
      ],
    };
    const { text } = await formatResult(r, { timestamp: TS });
    expect(text).toContain("1. **section**");
    expect(text).toContain("   - Selector: `#hero`");
    expect(text).toContain("   - ID: `hero`");
    expect(text).toContain("   - Classes: `a, b`");
    expect(text).toContain('   - Text: "Hello"');
    expect(text).toContain(
      "   - **Box Model:** 200×100 (content: 180×80, padding: 10 10 10 10, border: 0, margin: 5 5 5 5)",
    );
    expect(text).toContain('   - **Attributes:** data-x="1"');
    expect(text).toContain(
      "   - **Accessibility:** role=region, name=\"Hero\", focusable=false, disabled=false, expanded=true",
    );
    expect(text).toContain("   - **Comment:** fix padding");
  });

  test("no elements selected", async () => {
    const r: AnnotationResult = {
      success: true,
      url: "http://x/",
      viewport: { width: 1, height: 1 },
      elements: [],
    };
    const { text } = await formatResult(r, { timestamp: TS });
    expect(text).toContain("*No elements selected*");
  });
});

describe("formatResult — screenshots", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("element screenshot writes file and returns image with base64+mime+path", async () => {
    const r: AnnotationResult = {
      success: true,
      url: "http://x/",
      viewport: { width: 1, height: 1 },
      elements: [],
      screenshots: [{ index: 1, dataUrl: PNG_DATA_URL }],
    };
    const { text, images } = await formatResult(r, { timestamp: TS, tmpDir: dir });
    const expectedPath = path.join(dir, `pi-annotate-${TS}-el1.png`);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(text).toContain(`Element 1: ${expectedPath}`);
    expect(images).toEqual([{ path: expectedPath, base64: PNG_B64, mime: "image/png" }]);
  });

  test("full-page screenshot writes file and returns image", async () => {
    const r: AnnotationResult = {
      success: true,
      url: "http://x/",
      viewport: { width: 1, height: 1 },
      elements: [],
      screenshot: PNG_DATA_URL,
    };
    const { text, images } = await formatResult(r, { timestamp: TS, tmpDir: dir });
    const expectedPath = path.join(dir, `pi-annotate-${TS}-full.png`);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(text).toContain(`**Screenshot (full page):** ${expectedPath}`);
    expect(images).toContainEqual({ path: expectedPath, base64: PNG_B64, mime: "image/png" });
  });

  test("malformed screenshot is skipped, not thrown", async () => {
    const r: AnnotationResult = {
      success: true,
      url: "http://x/",
      viewport: { width: 1, height: 1 },
      elements: [],
      screenshots: [{ index: 1, dataUrl: "not-a-data-url" }],
    };
    const { text, images } = await formatResult(r, { timestamp: TS, tmpDir: dir });
    expect(text).toContain("capture failed");
    expect(images).toEqual([]);
  });
});

describe("formatResult — edit capture", () => {
  test("renders inline style + rule + dom changes", async () => {
    const r: AnnotationResult = {
      success: true,
      url: "http://x/",
      viewport: { width: 1, height: 1 },
      elements: [],
      editCapture: {
        inlineStyles: [
          { selector: ".a", tag: "div", added: { color: "red" }, changed: [{ property: "margin", from: "0", to: "8px" }], removed: ["padding"] },
        ],
        rules: [
          { ruleSelector: ".b", sheet: "main.css", added: {}, changed: [{ property: "width", from: "10px", to: "20px" }], removed: [] },
        ],
        dom: [{ type: "text", selector: ".c", detail: "changed text" }],
        duration: 4000,
        changeCount: 3,
      },
    };
    const { text } = await formatResult(r, { timestamp: TS });
    expect(text).toContain("## Edit Capture (3 changes, 4s)");
    expect(text).toContain("### Inline Style Changes");
    expect(text).toContain("- `margin`: `0` → `8px`");
    expect(text).toContain("- `color`: added `red`");
    expect(text).toContain("- `padding`: removed");
    expect(text).toContain("### CSS Rule Changes");
    expect(text).toContain("**`.b`** (main.css)");
    expect(text).toContain("### DOM Changes");
    expect(text).toContain("- **`.c`** — changed text");
  });
});
