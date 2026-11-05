// Runs one process and collects its output. Async through `spawn`, so a long
// write does not block the UI, and the same code runs in Node and in Tinycast's
// child_process shim (which sends stdin from `stdin.end(chunk)`).
import { spawn } from "node:child_process";

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  /** Set when the binary could not start, such as ENOENT. */
  spawnError?: string;
}

export type Runner = (bin: string, args: string[], input?: string) => Promise<RunResult>;

export const runProcess: Runner = (bin, args, input) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 });
    } catch (error) {
      resolve({ status: 127, stdout: "", stderr: "", spawnError: String((error as Error)?.message ?? error) });
      return;
    }
    const out: string[] = [];
    const err: string[] = [];
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", (d: string | Buffer) => out.push(String(d)));
    child.stderr?.on("data", (d: string | Buffer) => err.push(String(d)));
    child.on("error", (error: Error) => finish({ status: 127, stdout: out.join(""), stderr: err.join(""), spawnError: error.message }));
    child.on("close", (code: number | null) => finish({ status: code ?? 1, stdout: out.join(""), stderr: err.join("") }));
    child.stdin?.on?.("error", () => undefined);
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
