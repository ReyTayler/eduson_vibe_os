PRAGMA foreign_keys=ON;
PRAGMA recursive_triggers=ON;

CREATE TABLE users (
 id TEXT PRIMARY KEY,
 role TEXT NOT NULL CHECK(role IN ('student','teacher'))
) STRICT;
CREATE TABLE projects (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES users(id),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 UNIQUE(owner_id,id)
) STRICT;
CREATE TRIGGER project_count BEFORE INSERT ON projects
WHEN (SELECT count(*) FROM projects WHERE owner_id=NEW.owner_id)>=20
BEGIN SELECT RAISE(ABORT,'PROJECT_ENTITY_LIMIT'); END;

CREATE TABLE releases (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 content_sha TEXT NOT NULL CHECK(length(content_sha)=64),
 sealed INTEGER NOT NULL CHECK(sealed=1),
 UNIQUE(project_id,id)
) STRICT;
CREATE TRIGGER sealed_release_immutable BEFORE UPDATE ON releases
BEGIN SELECT RAISE(ABORT,'SEALED_RELEASE_IMMUTABLE'); END;
CREATE TABLE publish_grants (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 release_id TEXT NOT NULL,
 valid_until INTEGER,
 revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
 UNIQUE(project_id,id),
 FOREIGN KEY(project_id,release_id) REFERENCES releases(project_id,id)
) STRICT;
CREATE TRIGGER grant_scope_immutable BEFORE UPDATE OF project_id,release_id ON publish_grants
BEGIN SELECT RAISE(ABORT,'GRANT_SCOPE_IMMUTABLE'); END;
CREATE TABLE deployment_restrictions (
 project_id TEXT PRIMARY KEY REFERENCES projects(id),
 active INTEGER NOT NULL CHECK(active IN (0,1)),
 reason TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
) STRICT;
CREATE TABLE hosting_slots (
 user_id TEXT NOT NULL REFERENCES users(id),
 slot_no INTEGER NOT NULL CHECK(slot_no BETWEEN 1 AND 3),
 project_id TEXT UNIQUE,
 release_id TEXT,
 grant_id TEXT,
 generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
 desired TEXT NOT NULL DEFAULT 'off' CHECK(desired IN ('off','on')),
 observed TEXT NOT NULL DEFAULT 'empty'
   CHECK(observed IN ('empty','starting','running','failed','unknown','stopping')),
 resource_held INTEGER NOT NULL DEFAULT 0 CHECK(resource_held IN (0,1)),
 PRIMARY KEY(user_id,slot_no),
 FOREIGN KEY(user_id,project_id) REFERENCES projects(owner_id,id),
 FOREIGN KEY(project_id,release_id) REFERENCES releases(project_id,id),
 FOREIGN KEY(project_id,grant_id) REFERENCES publish_grants(project_id,id),
 CHECK((project_id IS NULL AND release_id IS NULL AND grant_id IS NULL
   AND desired='off' AND resource_held=0 AND observed='empty')
 OR (project_id IS NOT NULL AND release_id IS NOT NULL AND grant_id IS NOT NULL
   AND resource_held=1 AND observed<>'empty'))
) STRICT;
CREATE TRIGGER initialize_student_slots AFTER INSERT ON users
WHEN NEW.role='student'
BEGIN
 INSERT INTO hosting_slots(user_id,slot_no) VALUES(NEW.id,1),(NEW.id,2),(NEW.id,3);
END;
CREATE TABLE stop_receipts (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 slot_no INTEGER NOT NULL,
 project_id TEXT NOT NULL,
 generation INTEGER NOT NULL,
 range_id TEXT NOT NULL,
 empty INTEGER NOT NULL CHECK(empty=1),
 UNIQUE(user_id,slot_no,project_id,generation),
 FOREIGN KEY(user_id,slot_no) REFERENCES hosting_slots(user_id,slot_no)
) STRICT;
CREATE TRIGGER slot_no_replace BEFORE INSERT ON hosting_slots
WHEN EXISTS(SELECT 1 FROM hosting_slots WHERE (user_id=NEW.user_id AND slot_no=NEW.slot_no)
 OR (NEW.project_id IS NOT NULL AND project_id=NEW.project_id))
BEGIN SELECT RAISE(ABORT,'SLOT_REPLACE_FORBIDDEN'); END;
CREATE TRIGGER slot_no_replacing_conflict BEFORE UPDATE OF project_id ON hosting_slots
WHEN NEW.project_id IS NOT NULL AND EXISTS(SELECT 1 FROM hosting_slots
 WHERE project_id=NEW.project_id AND (user_id<>NEW.user_id OR slot_no<>NEW.slot_no))
BEGIN SELECT RAISE(ABORT,'SLOT_REPLACE_FORBIDDEN'); END;
CREATE TRIGGER held_slot_no_delete BEFORE DELETE ON hosting_slots
WHEN OLD.resource_held=1
BEGIN SELECT RAISE(ABORT,'HELD_SLOT_DELETE_FORBIDDEN'); END;
CREATE TRIGGER held_slot_release_guard BEFORE UPDATE ON hosting_slots
WHEN OLD.resource_held=1 AND (NEW.resource_held=0 OR NEW.project_id IS NOT OLD.project_id)
 AND NOT EXISTS(SELECT 1 FROM stop_receipts WHERE user_id=OLD.user_id AND slot_no=OLD.slot_no
   AND project_id=OLD.project_id AND generation=OLD.generation AND empty=1)
BEGIN SELECT RAISE(ABORT,'STOP_RECEIPT_REQUIRED'); END;
CREATE TRIGGER slot_generation_monotonic BEFORE UPDATE ON hosting_slots
WHEN NEW.generation<OLD.generation OR (OLD.resource_held=1 AND NEW.resource_held=1
 AND NEW.project_id<>OLD.project_id AND NEW.generation<=OLD.generation)
BEGIN SELECT RAISE(ABORT,'GENERATION_FENCE'); END;
-- Revocation blocks new execution intents; observations may still be recorded.
CREATE TRIGGER slot_execution_authorization BEFORE UPDATE ON hosting_slots
WHEN NEW.desired='on' AND (OLD.desired<>'on' OR NEW.project_id IS NOT OLD.project_id
 OR NEW.release_id IS NOT OLD.release_id OR NEW.grant_id IS NOT OLD.grant_id
 OR NEW.generation IS NOT OLD.generation)
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM deployment_restrictions WHERE project_id=NEW.project_id AND active=1)
   THEN RAISE(ABORT,'DEPLOYMENT_RESTRICTED') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM publish_grants g
   JOIN releases r ON r.project_id=g.project_id AND r.id=g.release_id
   WHERE g.id=NEW.grant_id AND g.project_id=NEW.project_id AND g.release_id=NEW.release_id
     AND g.revoked=0 AND (g.valid_until IS NULL OR g.valid_until>unixepoch()) AND r.sealed=1)
   THEN RAISE(ABORT,'PUBLISH_GRANT_INVALID') END;
END;
CREATE TABLE agent_runs (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 base_revision INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','leased','settled','failed','unknown')),
 UNIQUE(project_id,id)
) STRICT;
CREATE UNIQUE INDEX one_leased_run ON agent_runs(project_id) WHERE state='leased';
CREATE TABLE jobs (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 agent_run_id TEXT,
 kind TEXT NOT NULL,
 FOREIGN KEY(project_id,agent_run_id) REFERENCES agent_runs(project_id,id)
) STRICT;

CREATE TABLE budget_windows (
 id TEXT PRIMARY KEY,
 subject TEXT NOT NULL,
 period_start INTEGER NOT NULL,
 limit_mu INTEGER NOT NULL CHECK(limit_mu>=0),
 spent_mu INTEGER NOT NULL DEFAULT 0 CHECK(spent_mu>=0),
 held_mu INTEGER NOT NULL DEFAULT 0 CHECK(held_mu>=0),
 CHECK(spent_mu+held_mu<=limit_mu)
) STRICT;
CREATE TRIGGER budget_window_scope_immutable BEFORE UPDATE OF subject,period_start ON budget_windows
BEGIN SELECT RAISE(ABORT,'BUDGET_SCOPE_IMMUTABLE'); END;
CREATE TABLE llm_requests (
 id TEXT PRIMARY KEY,
 state TEXT NOT NULL CHECK(state IN ('reserved','sent','uncertain','settled')),
 reserved_mu INTEGER NOT NULL CHECK(reserved_mu>=0),
 actual_mu INTEGER CHECK(actual_mu>=0)
) STRICT;
CREATE TABLE request_budget_holds (
 request_id TEXT NOT NULL REFERENCES llm_requests(id),
 budget_id TEXT NOT NULL REFERENCES budget_windows(id),
 amount_mu INTEGER NOT NULL CHECK(amount_mu>=0),
 PRIMARY KEY(request_id,budget_id)
) STRICT;
CREATE TRIGGER hold_scope_immutable BEFORE UPDATE ON request_budget_holds
BEGIN SELECT RAISE(ABORT,'BUDGET_HOLD_IMMUTABLE'); END;
