// Copied from tinytick. One account, `test-token`, under the service `tinydrop`.
// Every secret goes to the macOS login Keychain as a generic password, through
// /usr/bin/security. Tinycast keeps preferences, LocalStorage and Cache as
// plaintext JSON, so no secret goes there.
//
// Writes send the secret on stdin to `security -i`, so it never shows in the
// process list. Reads use `find-generic-password -w`, which prints only the secret.
import { spawnSync } from "node:child_process";

export const KEYCHAIN_SERVICE = "tinydrop";
export const TOKEN_ACCOUNT = "test-token";
const SECURITY = "/usr/bin/security";
/** The exit code of `security` when no item matches. */
const NOT_FOUND = 44;

export interface Auth {
  token?: string;
}

function security(args: string[], input?: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(SECURITY, args, { input, encoding: "utf8", timeout: 10_000 });
  if (result.error) throw new Error(`Could not run ${SECURITY}: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Quotes a value for one line of `security -i`, which splits on spaces and reads \" and \\. */
export function quoteArg(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** The `security -i` line that adds or replaces one secret. */
export function addCommand(account: string, secret: string): string {
  return `add-generic-password -U -s ${quoteArg(KEYCHAIN_SERVICE)} -a ${quoteArg(account)} -w ${quoteArg(secret)}\n`;
}

function read(account: string): string | undefined {
  const r = security(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"]);
  if (r.status === NOT_FOUND) return undefined;
  if (r.status !== 0) throw new Error(`Could not read the Keychain (${r.status}): ${r.stderr.trim()}`);
  return r.stdout.replace(/\n$/, "") || undefined;
}

function write(account: string, secret: string): void {
  // A control character would end the `security -i` line, and `-w` prints such a secret as hex.
  if (/[\u0000-\u001f\u007f]/.test(secret)) throw new Error("The secret has a control character. Paste it again.");
  const r = security(["-i"], addCommand(account, secret));
  // `security -i` can exit 0 after a failed command, so read the item back.
  if (r.status !== 0 || read(account) !== secret) {
    throw new Error(`Could not save to the Keychain: ${r.stderr.trim() || "the stored value does not match"}`);
  }
}

function remove(account: string): void {
  const r = security(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account]);
  if (r.status !== 0 && r.status !== NOT_FOUND) throw new Error(`Could not delete from the Keychain (${r.status}): ${r.stderr.trim()}`);
}

export async function getAuth(): Promise<Auth> {
  return { token: read(TOKEN_ACCOUNT) };
}

export async function saveToken(token: string): Promise<void> {
  write(TOKEN_ACCOUNT, token.trim());
}

/** Removes the stored token. */
export async function deleteToken(): Promise<void> {
  remove(TOKEN_ACCOUNT);
}
