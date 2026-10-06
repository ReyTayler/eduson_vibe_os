/** Root SSH bootstrap. Creates the owner admin once and never replaces an existing password. */
import { DatabaseSync } from "node:sqlite";
import { hash } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";
import { writeFileSync, chmodSync, existsSync } from "node:fs";
import { initializeAdminSchema } from "./admin.mjs";
if (process.getuid() !== 0) throw new Error("ROOT_REQUIRED");
const db = new DatabaseSync("/var/lib/vibe-os/portal/portal.sqlite");
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
initializeAdminSchema(db);
const file = "/var/lib/vibe-os/portal-private/admin-login.json";
if (db.prepare("SELECT count(*) n FROM administrators").get().n) {
  console.log(
    JSON.stringify({
      created: false,
      existingAdministratorPreserved: true,
      credentialsFileExists: existsSync(file),
    }),
  );
  db.close();
} else {
  const login = "admin",
    password = randomBytes(21).toString("base64url"),
    id = randomBytes(16).toString("hex");
  const passwordHash = await hash(password, {
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  db.prepare("INSERT INTO administrators VALUES(?,?,?,?,1,?)").run(
    id,
    login,
    "Администратор",
    passwordHash,
    Date.now(),
  );
  writeFileSync(
    file,
    JSON.stringify(
      { login, password, id, url: "https://80.249.145.94/admin" },
      null,
      2,
    ) + "\n",
    { mode: 0o400, flag: "wx" },
  );
  chmodSync(file, 0o400);
  db.close();
  console.log(JSON.stringify({ created: true, credentialsSaved: true }));
}
