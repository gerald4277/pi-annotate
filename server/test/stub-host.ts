import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const TOKEN = "deadbeefcafe";

export interface Harness {
  socketPath: string;
  tokenPath: string;
  server: net.Server;
  conns: net.Socket[];
  received: string[];
  emit: (obj: unknown) => void;
  emitRaw: (s: string) => void;
  /** Resolve once a line matching `pred` has been received from the client. */
  waitFor: (pred: (msg: any) => boolean, timeoutMs?: number) => Promise<any>;
  cleanup: () => void;
}

export function startStubHost(): Promise<Harness> {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-annotate-sock-"));
    const socketPath = path.join(dir, "host.sock");
    const tokenPath = path.join(dir, "host.token");
    fs.writeFileSync(tokenPath, TOKEN + "\n");

    const conns: net.Socket[] = [];
    const received: string[] = [];
    const watchers: Array<(msg: any) => void> = [];

    const server = net.createServer((conn) => {
      conns.push(conn);
      let buf = "";
      conn.on("data", (d) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const l of lines) {
          if (!l.trim()) continue;
          received.push(l);
          let parsed: any;
          try {
            parsed = JSON.parse(l);
          } catch {
            continue;
          }
          for (const w of [...watchers]) w(parsed);
        }
      });
    });

    server.listen(socketPath, () => {
      resolve({
        socketPath,
        tokenPath,
        server,
        conns,
        received,
        emit: (obj) => conns[0].write(JSON.stringify(obj) + "\n"),
        emitRaw: (s) => conns[0].write(s),
        waitFor: (pred, timeoutMs = 1000) =>
          new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error("waitFor timed out")), timeoutMs);
            const w = (msg: any) => {
              if (pred(msg)) {
                clearTimeout(t);
                const i = watchers.indexOf(w);
                if (i >= 0) watchers.splice(i, 1);
                res(msg);
              }
            };
            watchers.push(w);
          }),
        cleanup: () => {
          for (const c of conns) c.destroy();
          server.close();
          fs.rmSync(dir, { recursive: true, force: true });
        },
      });
    });
  });
}
