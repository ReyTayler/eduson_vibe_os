// Linux-only prototype runner. Private Unix socket, one configured project,
// anchored filesystem operations and systemd-owned process ranges.
package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"golang.org/x/sys/unix"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const maxFile = 1024 * 1024
const maxOutput = 64 * 1024

type guard struct {
	Kind    string `json:"kind"`
	Version string `json:"version"`
}
type request struct {
	Op         string   `json:"op"`
	Path       string   `json:"path"`
	Text       string   `json:"text"`
	Old        string   `json:"old"`
	New        string   `json:"new"`
	ReplaceAll bool     `json:"replaceAll"`
	Guard      *guard   `json:"guard"`
	Program    string   `json:"program"`
	Args       []string `json:"args"`
	TimeoutMS  int      `json:"timeoutMs"`
}
type info struct {
	Type    string `json:"type"`
	Size    int64  `json:"size"`
	Version string `json:"version"`
}
type runner struct {
	rootfd     int
	config     string
	token      string
	uid        uint32
	toolUID    int
	mu         sync.Mutex
	pending    map[string]bool
	registry   string
	workers    map[string]*runner
	controlUID uint32
	prefix     string
	slice      string
}
type peerKey struct{}
type capWriter struct {
	b     []byte
	total int64
}

func (w *capWriter) Write(b []byte) (int, error) {
	w.total += int64(len(b))
	if len(b) >= maxOutput {
		w.b = append(w.b[:0], b[len(b)-maxOutput:]...)
	} else {
		excess := len(w.b) + len(b) - maxOutput
		if excess > 0 {
			w.b = w.b[excess:]
		}
		w.b = append(w.b, b...)
	}
	return len(b), nil
}
func (w *capWriter) value() map[string]any {
	return map[string]any{"text": strings.ToValidUTF8(string(w.b), ""), "totalBytes": w.total, "truncated": w.total > int64(len(w.b))}
}
func randomID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func relative(p string) (string, error) {
	if len(p) > 512 || strings.IndexByte(p, 0) >= 0 {
		return "", errors.New("FS_SANDBOX_DENIED")
	}
	if p == "/workspace" {
		p = "."
	} else if strings.HasPrefix(p, "/workspace/") {
		p = strings.TrimPrefix(p, "/workspace/")
	}
	if strings.HasPrefix(p, "/") {
		return "", errors.New("FS_SANDBOX_DENIED")
	}
	for _, part := range strings.Split(p, "/") {
		if part == ".." {
			return "", errors.New("FS_SANDBOX_DENIED")
		}
	}
	if p == "" {
		p = "."
	}
	return path.Clean(p), nil
}
func opened(dir int, p string, flags int, mode uint64) (int, error) {
	return unix.Openat2(dir, p, &unix.OpenHow{Flags: uint64(flags | unix.O_CLOEXEC), Mode: mode, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV})
}
func metadata(fd int) (*info, error) {
	var s unix.Stat_t
	if err := unix.Fstat(fd, &s); err != nil {
		return nil, err
	}
	t := "other"
	switch s.Mode & unix.S_IFMT {
	case unix.S_IFREG:
		t = "file"
	case unix.S_IFDIR:
		t = "directory"
	case unix.S_IFLNK:
		t = "symlink"
	}
	if t == "file" && s.Nlink != 1 {
		return nil, errors.New("FS_SANDBOX_DENIED")
	}
	v := fmt.Sprintf("%d:%d:%d:%d:%d:%d:%d", s.Dev, s.Ino, s.Size, s.Mtim.Sec, s.Mtim.Nsec, s.Ctim.Sec, s.Ctim.Nsec)
	sum := sha256.Sum256([]byte(v))
	return &info{t, s.Size, hex.EncodeToString(sum[:])}, nil
}
func (r *runner) stat(p string) (*info, error) {
	fd, e := opened(r.rootfd, p, unix.O_PATH, 0)
	if errors.Is(e, unix.ENOENT) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	defer unix.Close(fd)
	return metadata(fd)
}
func (r *runner) read(p string) (string, *info, error) {
	fd, e := opened(r.rootfd, p, unix.O_RDONLY|unix.O_NONBLOCK, 0)
	if e != nil {
		return "", nil, e
	}
	f := os.NewFile(uintptr(fd), "anchored-file")
	defer f.Close()
	s, e := metadata(fd)
	if e != nil {
		return "", nil, e
	}
	if s.Type != "file" {
		return "", nil, errors.New("FS_NOT_REGULAR_FILE")
	}
	if s.Size > maxFile {
		return "", nil, errors.New("FS_TOO_LARGE")
	}
	b, e := io.ReadAll(io.LimitReader(f, maxFile+1))
	if e != nil {
		return "", nil, e
	}
	if len(b) > maxFile {
		return "", nil, errors.New("FS_TOO_LARGE")
	}
	if !utf8.Valid(b) || strings.IndexByte(string(b), 0) >= 0 {
		return "", nil, errors.New("FS_NOT_TEXT")
	}
	return string(b), s, nil
}
func (r *runner) write(p, text string, g *guard) (any, error) {
	if p == "." || len(text) > maxFile || !utf8.ValidString(text) || strings.IndexByte(text, 0) >= 0 {
		return nil, errors.New("FS_TOO_LARGE_OR_INVALID")
	}
	before := ""
	prior, e := r.stat(p)
	if e != nil {
		return nil, e
	}
	if prior != nil {
		if prior.Type != "file" {
			return nil, errors.New("FS_NOT_REGULAR_FILE")
		}
		before, _, e = r.read(p)
		if e != nil {
			return nil, e
		}
	}
	if g != nil {
		switch g.Kind {
		case "createIfAbsent":
			if prior != nil {
				return nil, errors.New("FS_NOT_OBSERVED")
			}
		case "replaceIfVersion":
			if prior == nil || prior.Version != g.Version {
				return nil, errors.New("FS_STALE_VERSION")
			}
		default:
			return nil, errors.New("FS_INVALID_GUARD")
		}
	}
	parent, e := opened(r.rootfd, path.Dir(p), unix.O_RDONLY|unix.O_DIRECTORY, 0)
	if e != nil {
		return nil, e
	}
	defer unix.Close(parent)
	temp := ".vibe-" + randomID()
	fd, e := opened(parent, temp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL, 0600)
	if e != nil {
		return nil, e
	}
	defer unix.Unlinkat(parent, temp, 0)
	f := os.NewFile(uintptr(fd), "new-project-file")
	if e = unix.Fchown(fd, r.toolUID, r.toolUID); e != nil {
		f.Close()
		return nil, e
	}
	if _, e = f.WriteString(text); e != nil {
		f.Close()
		return nil, e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return nil, e
	}
	if e = f.Close(); e != nil {
		return nil, e
	}
	if g != nil && g.Kind == "createIfAbsent" {
		e = unix.Renameat2(parent, temp, parent, path.Base(p), unix.RENAME_NOREPLACE)
	} else {
		e = unix.Renameat(parent, temp, parent, path.Base(p))
	}
	if e != nil {
		return nil, e
	}
	if e = unix.Fsync(parent); e != nil {
		return nil, e
	}
	after, e := r.stat(p)
	if e != nil {
		return nil, e
	}
	op := "create"
	var basis any
	if prior != nil {
		op = "update"
		basis = before
	}
	return map[string]any{"operation": op, "version": after.Version, "before": basis, "after": text}, nil
}
func (r *runner) filesystem(q request) (any, error) {
	p, e := relative(q.Path)
	if e != nil {
		return nil, e
	}
	switch q.Op {
	case "stat":
		return r.stat(p)
	case "read":
		text, s, e := r.read(p)
		if e != nil {
			return nil, e
		}
		return map[string]any{"text": text, "info": s}, nil
	case "write":
		return r.write(p, q.Text, q.Guard)
	case "edit":
		if q.Old == "" {
			return nil, errors.New("FS_EDIT_NOT_FOUND")
		}
		before, s, e := r.read(p)
		if e != nil {
			return nil, e
		}
		if q.Guard != nil && q.Guard.Version != s.Version {
			return nil, errors.New("FS_STALE_VERSION")
		}
		count := strings.Count(before, q.Old)
		if count == 0 {
			return nil, errors.New("FS_EDIT_NOT_FOUND")
		}
		if count > 1 && !q.ReplaceAll {
			return nil, errors.New("FS_AMBIGUOUS_EDIT")
		}
		outputCount := 1
		if q.ReplaceAll {
			outputCount = count
		}
		if int64(len(before))+int64(outputCount)*(int64(len(q.New))-int64(len(q.Old))) > maxFile {
			return nil, errors.New("FS_TOO_LARGE")
		}
		n := 1
		if q.ReplaceAll {
			n = -1
		}
		return r.write(p, strings.Replace(before, q.Old, q.New, n), &guard{"replaceIfVersion", s.Version})
	case "mkdir":
		parent, e := opened(r.rootfd, path.Dir(p), unix.O_RDONLY|unix.O_DIRECTORY, 0)
		if e != nil {
			return nil, e
		}
		defer unix.Close(parent)
		if p == "." {
			return nil, errors.New("FS_INVALID_DIRECTORY")
		}
		e = unix.Mkdirat(parent, path.Base(p), 0700)
		if e != nil {
			return nil, e
		}
		fd, e := opened(parent, path.Base(p), unix.O_RDONLY|unix.O_DIRECTORY, 0)
		if e != nil {
			return nil, e
		}
		defer unix.Close(fd)
		if e = unix.Fchown(fd, r.toolUID, r.toolUID); e != nil {
			return nil, e
		}
		if e = unix.Fsync(parent); e != nil {
			return nil, e
		}
		return map[string]any{"created": true}, nil
	case "remove", "rename":
		if p == "." {
			return nil, errors.New("FS_SANDBOX_DENIED")
		}
		prior, e := r.stat(p)
		if e != nil || prior == nil {
			return nil, errors.New("FS_NOT_FOUND")
		}
		if q.Guard != nil && prior.Version != q.Guard.Version {
			return nil, errors.New("FS_STALE_VERSION")
		}
		parent, e := opened(r.rootfd, path.Dir(p), unix.O_RDONLY|unix.O_DIRECTORY, 0)
		if e != nil {
			return nil, e
		}
		defer unix.Close(parent)
		if q.Op == "remove" {
			flags := 0
			if prior.Type == "directory" {
				flags = unix.AT_REMOVEDIR
			}
			if e = unix.Unlinkat(parent, path.Base(p), flags); e != nil {
				return nil, e
			}
			if e = unix.Fsync(parent); e != nil {
				return nil, e
			}
			return map[string]any{"removed": true}, nil
		}
		dest, e := relative(q.New)
		if e != nil || dest == "." {
			return nil, errors.New("FS_SANDBOX_DENIED")
		}
		dst, e := opened(r.rootfd, path.Dir(dest), unix.O_RDONLY|unix.O_DIRECTORY, 0)
		if e != nil {
			return nil, e
		}
		defer unix.Close(dst)
		if e = unix.Renameat2(parent, path.Base(p), dst, path.Base(dest), unix.RENAME_NOREPLACE); e != nil {
			return nil, e
		}
		if e = unix.Fsync(parent); e != nil {
			return nil, e
		}
		if e = unix.Fsync(dst); e != nil {
			return nil, e
		}
		return map[string]any{"renamed": true}, nil
	case "list":
		fd, e := opened(r.rootfd, p, unix.O_RDONLY|unix.O_DIRECTORY, 0)
		if e != nil {
			return nil, e
		}
		f := os.NewFile(uintptr(fd), "project-directory")
		defer f.Close()
		entries, e := f.ReadDir(513)
		if e != nil && !errors.Is(e, io.EOF) {
			return nil, e
		}
		if len(entries) > 512 {
			return nil, errors.New("FS_TOO_MANY_ENTRIES")
		}
		out := make([]map[string]any, 0, len(entries))
		for _, entry := range entries {
			s, e := r.stat(path.Join(p, entry.Name()))
			if e != nil {
				continue
			}
			out = append(out, map[string]any{"name": entry.Name(), "info": s})
		}
		return out, nil
	}
	return nil, errors.New("UNKNOWN_OPERATION")
}
func cgroupEmpty(unit, slice string) (bool, error) {
	p := filepath.Join("/sys/fs/cgroup", slice, unit, "cgroup.events")
	b, e := os.ReadFile(p)
	if errors.Is(e, os.ErrNotExist) {
		return true, nil
	}
	if e != nil {
		return false, e
	}
	return strings.Contains(string(b), "populated 0\n"), nil
}
func stopRange(unit, slice string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	exec.CommandContext(ctx, "/usr/bin/systemctl", "stop", unit).Run()
	cg := filepath.Join("/sys/fs/cgroup", slice, unit)
	if b, e := os.ReadFile(filepath.Join(cg, "cgroup.events")); e == nil && strings.Contains(string(b), "populated 1\n") {
		if e = os.WriteFile(filepath.Join(cg, "cgroup.kill"), []byte("1"), 0600); e != nil {
			return false, e
		}
	} else if e != nil && !errors.Is(e, os.ErrNotExist) {
		return false, e
	}
	for n := 0; n < 50; n++ {
		empty, e := cgroupEmpty(unit, slice)
		if e != nil {
			return false, e
		}
		if empty {
			return true, nil
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false, errors.New("CGROUP_NOT_EMPTY")
}
func (r *runner) run(ctx context.Context, q request) (any, error) {
	bins := map[string]string{"bash": "/bin/bash", "python": "/usr/bin/python3.10", "node": "/usr/bin/node", "rg": "/usr/bin/rg"}
	binary, ok := bins[q.Program]
	if !ok {
		return nil, errors.New("PROGRAM_NOT_ALLOWED")
	}
	if len(q.Args) > 128 {
		return nil, errors.New("TOO_MANY_ARGUMENTS")
	}
	bytes := 0
	for _, arg := range q.Args {
		bytes += len(arg)
		if strings.IndexByte(arg, 0) >= 0 {
			return nil, errors.New("INVALID_ARGUMENT")
		}
	}
	if bytes > 32*1024 {
		return nil, errors.New("ARGUMENTS_TOO_LARGE")
	}
	ms := q.TimeoutMS
	if ms == 0 {
		ms = 2000
	}
	if ms < 50 || ms > 3000 {
		return nil, errors.New("INVALID_DEADLINE")
	}
	unit := r.prefix + randomID() + ".service"
	r.pending[unit] = true
	args := []string{"--quiet", "--pipe", "--wait", "--service-type=exec", "--description=Vibe OS managed tool range", "--unit=" + unit, "--slice=" + r.slice, "-p", "MemoryMax=256M", "-p", "MemorySwapMax=0", "-p", "TasksMax=64", "-p", "CPUQuota=50%", "-p", "KillMode=control-group", "-p", "OOMPolicy=stop", "-p", fmt.Sprintf("RuntimeMaxSec=%dms", ms), "/opt/vibe-os/bin/nsjail", "--quiet", "--config", r.config, "--", binary}
	args = append(args, q.Args...)
	owned, cancel := context.WithTimeout(ctx, time.Duration(ms)*time.Millisecond+3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(owned, "/usr/bin/systemd-run", args...)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8"}
	var stdout, stderr capWriter
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	start := time.Now()
	e := cmd.Run()
	result, _ := exec.Command("/usr/bin/systemctl", "show", unit, "--value", "-p", "Result").Output()
	empty, cleanupErr := stopRange(unit, r.slice)
	if cleanupErr != nil || !empty {
		return nil, fmt.Errorf("CLEANUP_UNCONFIRMED: %w", cleanupErr)
	}
	delete(r.pending, unit)
	status := 0
	if e != nil {
		var exited *exec.ExitError
		if errors.As(e, &exited) {
			status = exited.ExitCode()
		} else {
			status = -1
		}
	}
	return map[string]any{"exitCode": status, "timedOut": strings.TrimSpace(string(result)) == "timeout" || errors.Is(owned.Err(), context.DeadlineExceeded), "aborted": errors.Is(ctx.Err(), context.Canceled), "unitResult": strings.TrimSpace(string(result)), "durationMs": time.Since(start).Milliseconds(), "stdout": stdout.value(), "stderr": stderr.value(), "cgroupEmpty": empty, "unit": unit}, nil
}
func (r *runner) barrier() error {
	for unit := range r.pending {
		empty, err := stopRange(unit, r.slice)
		if err != nil || !empty {
			return errors.New("CLEANUP_UNCONFIRMED")
		}
		delete(r.pending, unit)
	}
	return nil
}

type registryRecord struct {
	Workspace string `json:"workspace"`
	Config    string `json:"config"`
	Token     string `json:"token"`
	UID       uint32 `json:"uid"`
	ToolUID   int    `json:"toolUid"`
}

func (r *runner) scoped(h *http.Request) (*runner, error) {
	if r.registry == "" {
		return r, nil
	}
	id := h.Header.Get("X-Vibe-Project")
	if len(id) != 32 {
		return nil, errors.New("PROJECT_DENIED")
	}
	if _, e := hex.DecodeString(id); e != nil {
		return nil, errors.New("PROJECT_DENIED")
	}
	for key, child := range r.workers {
		if _, e := os.Stat(filepath.Join(r.registry, key+".json")); errors.Is(e, os.ErrNotExist) {
			unix.Close(child.rootfd)
			delete(r.workers, key)
		}
	}
	if len(r.workers) >= 64 {
		return nil, errors.New("PROJECT_CAPACITY")
	}
	name := filepath.Join(r.registry, id+".json")
	fi, e := os.Lstat(name)
	if e != nil || !fi.Mode().IsRegular() || fi.Mode().Perm()&0022 != 0 || fi.Size() > 4096 {
		return nil, errors.New("PROJECT_DENIED")
	}
	var st unix.Stat_t
	if e = unix.Stat(name, &st); e != nil || st.Uid != 0 {
		return nil, errors.New("PROJECT_DENIED")
	}
	if child := r.workers[id]; child != nil {
		return child, nil
	}
	data, e := os.ReadFile(name)
	if e != nil {
		return nil, e
	}
	var record registryRecord
	if e = json.Unmarshal(data, &record); e != nil {
		return nil, e
	}
	if record.Workspace != "/srv/vibe-os/data/student-projects/"+id+"/workspace" || record.Config != "/etc/vibe-os/student-projects/"+id+"/tool.cfg" || record.UID < 28001 || record.UID > 28005 || record.ToolUID != int(record.UID)+1000 || len(record.Token) != 64 {
		return nil, errors.New("PROJECT_DENIED")
	}
	if _, e = hex.DecodeString(record.Token); e != nil {
		return nil, errors.New("PROJECT_DENIED")
	}
	fd, e := unix.Open(record.Workspace, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if e != nil {
		return nil, e
	}
	child := &runner{rootfd: fd, config: record.Config, token: record.Token, uid: record.UID, toolUID: record.ToolUID, pending: r.pending, controlUID: r.controlUID, prefix: r.prefix, slice: r.slice}
	r.workers[id] = child
	return child, nil
}
func (r *runner) serve(w http.ResponseWriter, h *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	peer, _ := h.Context().Value(peerKey{}).(uint32)
	r.mu.Lock()
	defer r.mu.Unlock()
	target, scopeErr := r.scoped(h)
	if scopeErr != nil {
		http.Error(w, "denied", 403)
		return
	}
	token := strings.TrimPrefix(h.Header.Get("Authorization"), "Bearer ")
	if (peer != target.uid && peer != target.controlUID) || subtle.ConstantTimeCompare([]byte(token), []byte(target.token)) != 1 {
		http.Error(w, "denied", 403)
		return
	}
	if h.Method != "POST" || h.URL.Path != "/v1/operation" {
		http.Error(w, "not found", 404)
		return
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, h.Body, 2*maxFile))
	dec.DisallowUnknownFields()
	var q request
	if e := dec.Decode(&q); e != nil {
		http.Error(w, "invalid request", 400)
		return
	}
	if e := dec.Decode(new(any)); !errors.Is(e, io.EOF) {
		http.Error(w, "trailing request", 400)
		return
	}
	var value any
	var e error
	if cleanupErr := target.barrier(); cleanupErr != nil {
		http.Error(w, "cleanup unavailable", 503)
		return
	}
	if q.Op == "barrier" {
		value = map[string]any{"cgroupEmpty": true}
	} else if q.Op == "run" {
		value, e = target.run(h.Context(), q)
	} else {
		value, e = target.filesystem(q)
	}
	if e != nil {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]any{"error": e.Error()})
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"result": value})
}
func main() {
	socket := flag.String("socket", "/run/vibe-os-poc/runner.sock", "Private Unix socket")
	workspace := flag.String("workspace", "/srv/vibe-os/data/poc-project-1", "Trusted project root")
	config := flag.String("tool-config", "/etc/vibe-os/tool-1.cfg", "Trusted jail configuration")
	capFile := flag.String("cap-file", "/var/lib/vibe-os/poc-engine/capability", "Scoped capability file")
	registry := flag.String("registry", "", "Root-owned multi-project registry")
	controlUID := flag.Uint("control-uid", 4294967295, "Trusted control peer UID")
	prefix := flag.String("unit-prefix", "vibe-tool-", "Owned tool unit prefix")
	slice := flag.String("slice", "vibe-poc-tools.slice", "Owned tool cgroup slice")
	flag.Parse()
	if (*prefix != "vibe-tool-" && *prefix != "vibe-ws-tool-") || (*slice != "vibe-poc-tools.slice" && *slice != "vibe-student-tools.slice") {
		panic("Invalid managed range configuration")
	}
	if *registry != "" && *registry != "/var/lib/vibe-os/student-registry" {
		panic("Invalid registry")
	}

	if os.Geteuid() != 0 {
		panic("Runner requires root for namespace and cgroup setup")
	}
	token, e := os.ReadFile(*capFile)
	if e != nil {
		panic(e)
	}
	token = []byte(strings.TrimSpace(string(token)))
	if len(token) != 64 {
		panic("Invalid capability")
	}
	fd, e := unix.Open(*workspace, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if e != nil {
		panic(e)
	}
	defer unix.Close(fd)
	r := &runner{rootfd: fd, config: *config, token: string(token), uid: 23000, toolUID: 23001, pending: make(map[string]bool), registry: *registry, workers: make(map[string]*runner), controlUID: uint32(*controlUID), prefix: *prefix, slice: *slice}
	// Recover owned short-lived ranges after a broker crash before accepting writes.
	recovery, recoveryErr := exec.Command("/usr/bin/systemctl", "list-units", "--all", "--plain", "--no-legend", *prefix+"*.service").Output()
	if recoveryErr != nil {
		panic(recoveryErr)
	}
	for _, line := range strings.Split(string(recovery), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		unit := fields[0]
		if unit == "●" && len(fields) > 1 {
			unit = fields[1]
		}
		if !strings.HasPrefix(unit, *prefix) {
			continue
		}
		if len(unit) != len(*prefix)+32+len(".service") || !strings.HasPrefix(unit, *prefix) || !strings.HasSuffix(unit, ".service") {
			panic("Unexpected owned range")
		}
		r.pending[unit] = true
	}
	if e = r.barrier(); e != nil {
		panic(e)
	}
	if e = os.MkdirAll(filepath.Dir(*socket), 0755); e != nil {
		panic(e)
	}
	if s, e := os.Lstat(*socket); e == nil {
		if s.Mode()&os.ModeSocket == 0 {
			panic("Refusing to replace non-socket")
		}
		if e = os.Remove(*socket); e != nil {
			panic(e)
		}
	}
	listener, e := net.ListenUnix("unix", &net.UnixAddr{Name: *socket, Net: "unix"})
	if e != nil {
		panic(e)
	}
	defer listener.Close()
	if e = os.Chown(*socket, 23000, 23000); e != nil {
		panic(e)
	}
	mode := os.FileMode(0600)
	if *registry != "" {
		mode = 0660
	}
	if e = os.Chmod(*socket, mode); e != nil {
		panic(e)
	}
	server := &http.Server{Handler: http.HandlerFunc(r.serve), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 8 * time.Second, WriteTimeout: 12 * time.Second, MaxHeaderBytes: 8192,
		ConnContext: func(ctx context.Context, c net.Conn) context.Context {
			uc, ok := c.(*net.UnixConn)
			if !ok {
				return ctx
			}
			raw, e := uc.SyscallConn()
			if e != nil {
				return ctx
			}
			var uid uint32 = ^uint32(0)
			raw.Control(func(fd uintptr) {
				cred, e := unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
				if e == nil {
					uid = cred.Uid
				}
			})
			return context.WithValue(ctx, peerKey{}, uid)
		}}
	fmt.Fprintln(os.Stderr, "Vibe OS anchored workspace runner ready")
	if e = server.Serve(listener); e != nil && !errors.Is(e, http.ErrServerClosed) {
		panic(e)
	}
}
