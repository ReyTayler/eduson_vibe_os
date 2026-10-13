/** AES-GCM credential records. Plaintext exists only during import and provider authentication. */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  chownSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
export class Vault {
  constructor(master, dir) {
    if (master.length !== 32) throw new Error("INVALID_MASTER");
    this.master = master;
    this.dir = dir;
  }
  file(id) {
    if (!Number.isInteger(id) || id < 20 || id > 27)
      throw new Error("CREDENTIAL_SCOPE");
    return join(this.dir, "deepseek-" + id + ".json");
  }
  get(id) {
    const r = JSON.parse(readFileSync(this.file(id), "utf8"));
    if (r.version !== 1 || r.id !== id) throw new Error("CREDENTIAL_RECORD");
    const d = createDecipheriv(
      "aes-256-gcm",
      this.master,
      Buffer.from(r.nonce, "base64"),
    );
    d.setAAD(Buffer.from("vibe-os:deepseek:" + id + ":1"));
    d.setAuthTag(Buffer.from(r.tag, "base64"));
    const key = Buffer.concat([
      d.update(Buffer.from(r.ciphertext, "base64")),
      d.final(),
    ]).toString("utf8");
    if (!/^sk-[A-Za-z0-9_-]{16,128}$/.test(key))
      throw new Error("CREDENTIAL_RECORD");
    return key;
  }
  metadata() {
    return Array.from({ length: 8 }, (_, i) => 20 + i)
      .filter((id) => existsSync(this.file(id)))
      .map((id) => {
        const r = JSON.parse(readFileSync(this.file(id), "utf8"));
        return { id, fingerprint: r.fingerprint };
      });
  }
  put(id, key, gid, { replace = false } = {}) {
    this.file(id);
    if (!/^sk-[A-Za-z0-9_-]{16,128}$/.test(key))
      throw new Error("CREDENTIAL_FORMAT");
    const fingerprint = createHash("sha256")
      .update(key)
      .digest("hex")
      .slice(0, 16);
    const replacing = existsSync(this.file(id));
    if (replacing) {
      if (this.get(id) === key) return { id, fingerprint, existing: true };
      if (!replace) throw new Error("CREDENTIAL_ALREADY_DIFFERENT");
    }
    const nonce = randomBytes(12),
      c = createCipheriv("aes-256-gcm", this.master, nonce);
    c.setAAD(Buffer.from("vibe-os:deepseek:" + id + ":1"));
    const ciphertext = Buffer.concat([c.update(key, "utf8"), c.final()]);
    const record = {
      version: 1,
      id,
      fingerprint,
      nonce: nonce.toString("base64"),
      tag: c.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const temp = this.file(id) + ".new-" + randomBytes(8).toString("hex");
    writeFileSync(temp, JSON.stringify(record) + "\n", {
      mode: 0o640,
      flag: "wx",
    });
    chownSync(temp, 0, gid);
    const fd = openSync(temp, "r");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(temp, this.file(id));
    const dir = openSync(this.dir, "r");
    fsyncSync(dir);
    closeSync(dir);
    return {
      id,
      fingerprint,
      existing: false,
      ...(replacing ? { rotated: true } : {}),
    };
  }
}
export async function importStdin() {
  let bytes = 0,
    parts = [];
  for await (const p of process.stdin) {
    bytes += p.length;
    if (bytes > 8192) throw new Error("IMPORT_TOO_LARGE");
    parts.push(p);
  }
  const rows = JSON.parse(
    Buffer.concat(parts)
      .toString("utf8")
      .replace(/^\uFEFF/, ""),
  );
  if (
    !Array.isArray(rows) ||
    rows.length !== 8 ||
    rows.some((r, i) => r.id !== 20 + i)
  )
    throw new Error("EXPECTED_20_THROUGH_27");
  if (new Set(rows.map((r) => r.key)).size !== 8)
    throw new Error("DUPLICATE_KEYS");
  mkdirSync("/etc/vibe-os/credentials", { recursive: true, mode: 0o700 });
  const masterFile = "/etc/vibe-os/credentials/master.key";
  if (!existsSync(masterFile))
    writeFileSync(masterFile, randomBytes(32), { mode: 0o400, flag: "wx" });
  chmodSync(masterFile, 0o400);
  const dir = "/var/lib/vibe-os/credentials";
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  chownSync(dir, 0, 25000);
  chmodSync(dir, 0o750);
  const vault = new Vault(readFileSync(masterFile), dir);
  const result = rows.map((r) => vault.put(r.id, r.key, 25000));
  if (vault.metadata().length !== 8) throw new Error("INCOMPLETE_IMPORT");
  process.stdout.write(
    JSON.stringify({ imported: result, encrypted: true }) + "\n",
  );
}
