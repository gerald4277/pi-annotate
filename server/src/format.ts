import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AnnotationResult, ElementSelection, EditCapture } from "./types.js";

const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024; // 15MB

export interface ImageOut {
  path: string;
  base64: string;
  mime: string;
}

export interface FormatOptions {
  /** Timestamp used in screenshot filenames (injected for determinism). */
  timestamp: number;
  /** Directory screenshots are written to. Defaults to the OS temp dir. */
  tmpDir?: string;
}

export interface FormatOutput {
  text: string;
  images: ImageOut[];
}

function formatEditCapture(capture: EditCapture): string {
  let output = "";

  if (capture.warnings?.length) {
    for (const w of capture.warnings) {
      output += `> **Note:** ${w}\n`;
    }
    output += "\n";
  }

  // Inline style changes
  if (capture.inlineStyles.length > 0) {
    output += `### Inline Style Changes\n\n`;
    for (const change of capture.inlineStyles) {
      output += `**\`${change.selector}\`**\n`;
      for (const c of change.changed) {
        output += `- \`${c.property}\`: \`${c.from}\` → \`${c.to}\`\n`;
      }
      for (const [prop, value] of Object.entries(change.added)) {
        output += `- \`${prop}\`: added \`${value}\`\n`;
      }
      for (const prop of change.removed) {
        output += `- \`${prop}\`: removed\n`;
      }
      output += "\n";
    }
  }

  // Stylesheet rule changes
  if (capture.rules.length > 0) {
    output += `### CSS Rule Changes\n\n`;
    for (const change of capture.rules) {
      output += `**\`${change.ruleSelector}\`** (${change.sheet})\n`;
      for (const c of change.changed) {
        output += `- \`${c.property}\`: \`${c.from}\` → \`${c.to}\`\n`;
      }
      for (const [prop, value] of Object.entries(change.added)) {
        output += `- \`${prop}\`: added \`${value}\`\n`;
      }
      for (const prop of change.removed) {
        output += `- \`${prop}\`: removed\n`;
      }
      output += "\n";
    }
  }

  // DOM changes
  if (capture.dom.length > 0) {
    output += `### DOM Changes\n\n`;
    for (const change of capture.dom) {
      output += `- **\`${change.selector}\`** — ${change.detail}\n`;
    }
    output += "\n";
  }

  return output;
}

/** Decode a `data:image/...;base64,...` URL, write it to disk, and record it. */
function writeScreenshot(
  dataUrl: string,
  filePath: string,
  images: ImageOut[],
): void {
  if (!dataUrl.startsWith("data:image/")) throw new Error("Invalid screenshot data");
  const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
  const buffer = Buffer.from(base64Data, "base64");
  if (buffer.length > MAX_SCREENSHOT_BYTES) throw new Error("Screenshot too large");
  fs.writeFileSync(filePath, buffer);
  images.push({ path: filePath, base64: base64Data, mime: "image/png" });
}

export async function formatResult(
  result: AnnotationResult,
  opts: FormatOptions,
): Promise<FormatOutput> {
  const images: ImageOut[] = [];
  const tmpDir = opts.tmpDir ?? os.tmpdir();

  if (!result.success) {
    if (result.cancelled) {
      if (result.reason?.includes("Another terminal")) {
        return { text: `Annotation session ended: ${result.reason}`, images };
      }
      if (result.reason && result.reason !== "user") {
        return { text: `Annotation cancelled: ${result.reason}`, images };
      }
      return { text: "Annotation cancelled by user.", images };
    }
    return { text: `Annotation failed: ${result.reason || "Unknown error"}`, images };
  }

  let output = `## Page Annotation: ${result.url || "Unknown"}\n`;
  if (result.viewport) {
    output += `**Viewport:** ${result.viewport.width}×${result.viewport.height}\n\n`;
  }

  // Show overall context if provided (uses existing 'prompt' field for backwards compat)
  if (result.prompt) {
    output += `**Context:** ${result.prompt}\n\n`;
  }

  // Check if any element has debug data (to show header)
  const hasDebugData = result.elements?.some(
    (el) => el.computedStyles || el.parentContext || el.cssVariables,
  );
  if (hasDebugData) {
    output += `**Debug Mode:** Enabled\n\n`;
  }

  if (result.elements && result.elements.length > 0) {
    output += `### Selected Elements (${result.elements.length})\n\n`;
    result.elements.forEach((el: ElementSelection, i: number) => {
      output += `${i + 1}. **${el.tag}**\n`;
      output += `   - Selector: \`${el.selector}\`\n`;
      if (el.id) output += `   - ID: \`${el.id}\`\n`;
      if (el.classes?.length) output += `   - Classes: \`${el.classes.join(", ")}\`\n`;
      if (el.text) {
        output += `   - Text: "${el.text}"\n`;
      }

      // Box model - compact format
      if (el.boxModel) {
        const bm = el.boxModel;
        const padStr = `${bm.padding.top} ${bm.padding.right} ${bm.padding.bottom} ${bm.padding.left}`;
        const borderStr =
          bm.border.top || bm.border.right || bm.border.bottom || bm.border.left
            ? `${bm.border.top} ${bm.border.right} ${bm.border.bottom} ${bm.border.left}`
            : "0";
        const marginStr = `${bm.margin.top} ${bm.margin.right} ${bm.margin.bottom} ${bm.margin.left}`;
        output += `   - **Box Model:** ${el.rect.width}×${el.rect.height} (content: ${bm.content.width}×${bm.content.height}, padding: ${padStr}, border: ${borderStr}, margin: ${marginStr})\n`;
      } else {
        output += `   - Size: ${el.rect.width}×${el.rect.height}px\n`;
      }

      // Attributes
      if (el.attributes && Object.keys(el.attributes).length > 0) {
        const attrStr = Object.entries(el.attributes)
          .map(([k, v]) => `${k}="${v}"`)
          .join(", ");
        output += `   - **Attributes:** ${attrStr}\n`;
      }

      // Accessibility - compact format, omit undefined booleans
      if (el.accessibility) {
        const a11y = el.accessibility;
        const parts: string[] = [];
        if (a11y.role) parts.push(`role=${a11y.role}`);
        if (a11y.name) parts.push(`name="${a11y.name}"`);
        parts.push(`focusable=${a11y.focusable}`);
        parts.push(`disabled=${a11y.disabled}`);
        if (a11y.expanded !== undefined) parts.push(`expanded=${a11y.expanded}`);
        if (a11y.pressed !== undefined) parts.push(`pressed=${a11y.pressed}`);
        if (a11y.checked !== undefined) parts.push(`checked=${a11y.checked}`);
        if (a11y.selected !== undefined) parts.push(`selected=${a11y.selected}`);
        if (a11y.description) parts.push(`description="${a11y.description}"`);
        output += `   - **Accessibility:** ${parts.join(", ")}\n`;
      }

      // Key styles - compact format (suppressed when full computedStyles is present)
      const hasComputedStyles = el.computedStyles && Object.keys(el.computedStyles).length > 0;
      if (!hasComputedStyles && el.keyStyles && Object.keys(el.keyStyles).length > 0) {
        const styleStr = Object.entries(el.keyStyles)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        output += `   - **Styles:** ${styleStr}\n`;
      }

      // Comment
      if (el.comment) {
        output += `   - **Comment:** ${el.comment}\n`;
      }

      // Debug mode data - verbose format
      if (el.computedStyles && Object.keys(el.computedStyles).length > 0) {
        output += `   - **Computed Styles:**\n`;
        for (const [key, value] of Object.entries(el.computedStyles)) {
          output += `     - ${key}: ${value}\n`;
        }
      }

      if (el.parentContext) {
        const pc = el.parentContext;
        const pcLabel = pc.id
          ? `${pc.tag}#${pc.id}`
          : `${pc.tag}${pc.classes[0] ? "." + pc.classes[0] : ""}`;
        const pcStyles = Object.entries(pc.styles)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        output += `   - **Parent Context:** ${pcLabel} (${pcStyles})\n`;
      }

      if (el.cssVariables && Object.keys(el.cssVariables).length > 0) {
        output += `   - **CSS Variables:**\n`;
        for (const [name, value] of Object.entries(el.cssVariables)) {
          output += `     - ${name}: ${value}\n`;
        }
      }

      output += `\n`;
    });
  } else {
    output += "*No elements selected*\n\n";
  }

  // Handle screenshots
  const timestamp = opts.timestamp;

  if (result.screenshot) {
    // Full page screenshot
    try {
      const screenshotPath = path.join(tmpDir, `claude-annotate-${timestamp}-full.png`);
      writeScreenshot(result.screenshot, screenshotPath, images);
      output += `**Screenshot (full page):** ${screenshotPath}\n`;
    } catch (err) {
      output += `*Screenshot capture failed: ${err}*\n`;
    }
  }

  if (result.screenshots && result.screenshots.length > 0) {
    // Individual element screenshots
    output += `### Screenshots\n\n`;
    for (let i = 0; i < result.screenshots.length; i++) {
      const shot = result.screenshots[i];
      try {
        const safeIndex = Number.isFinite(shot.index) ? Math.max(1, Math.floor(shot.index)) : i + 1;
        const screenshotPath = path.join(tmpDir, `claude-annotate-${timestamp}-el${safeIndex}.png`);
        writeScreenshot(shot?.dataUrl, screenshotPath, images);
        output += `- Element ${safeIndex}: ${screenshotPath}\n`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output += `- Element ${shot?.index ?? i + 1}: *capture failed (${message})*\n`;
      }
    }
    output += "\n";
  }

  if (result.editCapture && result.editCapture.changeCount > 0) {
    const ec = result.editCapture;
    output += `## Edit Capture (${ec.changeCount} changes, ${Math.round(ec.duration / 1000)}s)\n\n`;
    output += formatEditCapture(ec);

    // Before/after screenshots
    if (ec.beforeScreenshot || ec.afterScreenshot) {
      output += `### Before/After Screenshots\n\n`;
      if (ec.beforeScreenshot) {
        try {
          const p = path.join(tmpDir, `claude-annotate-${timestamp}-before.png`);
          writeScreenshot(ec.beforeScreenshot, p, images);
          output += `- Before: ${p}\n`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          output += `- Before: *capture failed (${message})*\n`;
        }
      }
      if (ec.afterScreenshot) {
        try {
          const p = path.join(tmpDir, `claude-annotate-${timestamp}-after.png`);
          writeScreenshot(ec.afterScreenshot, p, images);
          output += `- After: ${p}\n`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          output += `- After: *capture failed (${message})*\n`;
        }
      }
      output += "\n";
    }
  }

  return { text: output, images };
}
