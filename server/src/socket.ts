import * as net from "node:net";
import * as fs from "node:fs";
import type { AnnotationResult } from "./types.js";

const MAX_SOCKET_BUFFER = 32 * 1024 * 1024; // 32MB

export interface HostSocketOptions {
  socketPath: string;
  tokenPath: string;
  /** Optional logger; defaults to stderr. Never write to stdout (reserved for MCP). */
  log?: (msg: string) => void;
}

type Resolver = (result: AnnotationResult) => void;

function cancelled(reason: string): AnnotationResult {
  return {
    success: false,
    cancelled: true,
    reason,
    elements: [],
    url: "",
    viewport: { width: 0, height: 0 },
  };
}

/**
 * Client side of the claude-annotate Unix-socket protocol. A drop-in replacement
 * for the Pi layer in the original index.ts: connects to the native host's
 * socket, authenticates, and dispatches newline-delimited JSON messages to
 * per-requestId resolvers.
 */
export class HostSocket {
  private sock: net.Socket | null = null;
  private buffer = "";
  private token: string | null = null;
  private readonly pending = new Map<number, Resolver>();
  private readonly opts: HostSocketOptions;
  private readonly log: (msg: string) => void;

  constructor(opts: HostSocketOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((m) => process.stderr.write(`[claude-annotate] ${m}\n`));
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.sock && !this.sock.destroyed) {
        resolve();
        return;
      }

      try {
        this.token = fs.readFileSync(this.opts.tokenPath, "utf8").trim();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reject(
          new Error(`Failed to read auth token at ${this.opts.tokenPath}: ${message}`, {
            cause: err,
          }),
        );
        return;
      }

      const sock = net.createConnection(this.opts.socketPath);
      this.sock = sock;

      sock.on("connect", () => {
        this.log("Connected to native host");
        this.send({ type: "AUTH", token: this.token });
        resolve();
      });

      sock.on("data", (data) => {
        this.buffer += data.toString();
        if (this.buffer.length > MAX_SOCKET_BUFFER) {
          this.log("Error: Socket buffer overflow");
          sock.destroy();
          this.buffer = "";
          return;
        }
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            this.handleMessage(JSON.parse(line));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log(`Error: Failed to parse message: ${message}`);
          }
        }
      });

      sock.on("error", (err) => {
        this.log(`Error: ${err.message}`);
        reject(err);
      });

      sock.on("close", () => {
        this.log("Disconnected from native host");
        this.sock = null;
        this.token = null;
        this.buffer = "";
        for (const [, resolvePending] of this.pending) {
          resolvePending(cancelled("connection_lost"));
        }
        this.pending.clear();
      });
    });
  }

  send(msg: object): void {
    if (this.sock && !this.sock.destroyed) {
      this.sock.write(JSON.stringify(msg) + "\n");
    }
  }

  /** Register a resolver for a request id. Resolved by the next matching terminal message. */
  onResult(requestId: number, cb: Resolver): void {
    this.pending.set(requestId, cb);
  }

  /** Drop a pending resolver without resolving it (handler owns timeout/abort messaging). */
  clearPending(requestId: number): void {
    this.pending.delete(requestId);
  }

  close(): void {
    this.sock?.destroy();
    this.sock = null;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  private isAnnotationResult(value: unknown): value is AnnotationResult {
    return this.isRecord(value) && typeof value.success === "boolean";
  }

  private handleMessage(msg: unknown): void {
    if (!this.isRecord(msg) || typeof msg.type !== "string") return;

    this.log(`Received: ${msg.type}`);
    const requestId = typeof msg.requestId === "number" ? msg.requestId : null;

    if (msg.type === "SESSION_REPLACED") {
      const reason =
        typeof msg.reason === "string" ? msg.reason : "Session replaced by another terminal";
      for (const [, resolvePending] of this.pending) {
        resolvePending(cancelled(reason));
      }
      this.pending.clear();
      this.sock = null;
      this.buffer = "";
      return;
    }

    if (msg.type === "ANNOTATIONS_COMPLETE") {
      if (!this.isAnnotationResult(msg.result)) return;
      if (requestId !== null && this.pending.has(requestId)) {
        const resolvePending = this.pending.get(requestId)!;
        this.pending.delete(requestId);
        resolvePending(msg.result);
      }
    } else if (msg.type === "CANCEL") {
      if (requestId !== null && this.pending.has(requestId)) {
        const resolvePending = this.pending.get(requestId)!;
        this.pending.delete(requestId);
        resolvePending(cancelled(typeof msg.reason === "string" ? msg.reason : "user"));
      }
    }
  }
}
