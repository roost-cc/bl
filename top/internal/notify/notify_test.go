package notify

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/roost-cc/bl/top/internal/stream"
)

var readAt = time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)

// snap is a snapshot with both sections read: the inbox items as kind:id, the runs as id:status.
func snap(items []string, runs []string) *stream.Snapshot {
	s := &stream.Snapshot{}
	s.Attention.ReadAt, s.Runs.ReadAt = readAt, readAt
	for _, it := range items {
		kind, id, _ := strings.Cut(it, ":")
		s.Attention.Items = append(s.Attention.Items, stream.Item{Kind: kind, ID: id, Line: "line of " + id})
	}
	for _, r := range runs {
		id, status, _ := strings.Cut(r, ":")
		s.Runs.Rows = append(s.Runs.Rows, stream.Run{ID: id, Status: status, Step: "review", Story: ""})
	}
	return s
}

// titles are the notes as `<id> <kind>`.
func titles(notes []Note) []string {
	var out []string
	for _, n := range notes {
		out = append(out, n.ID+" "+n.Kind)
	}
	return out
}

func TestDiff(t *testing.T) {
	var d Differ
	steps := []struct {
		what string
		snap *stream.Snapshot
		want []string
	}{
		{"the first snapshot sets the baseline", snap(
			[]string{"escalation:F-83:esc", "task:T-2", "change:F-81:change"},
			[]string{"F-81:running", "F-85:clean", "S-1:running"}), nil},
		{"nothing changed", snap(
			[]string{"escalation:F-83:esc", "task:T-2", "change:F-81:change"},
			[]string{"F-81:running", "F-85:clean", "S-1:running"}), nil},
		{"a new escalation, task and change; two runs end; one goes stale", snap(
			[]string{"runner:updates:run", "escalation:F-83:esc", "escalation:F-81:esc", "task:T-2", "task:T-52", "change:S-9:change", "change:F-81:change"},
			[]string{"F-81:escalated", "F-85:clean", "S-1:stale", "S-2:no-change"}),
			[]string{"F-81:esc escalation", "T-52 task", "F-81 escalated", "S-2 no-change"}},
		{"an item notifies once", snap(
			[]string{"escalation:F-83:esc", "escalation:F-81:esc", "task:T-2", "task:T-52"},
			[]string{"F-81:escalated", "S-1:stale"}), nil},
		{"T-52 leaves the inbox", snap(
			[]string{"escalation:F-83:esc", "escalation:F-81:esc", "task:T-2"},
			[]string{"F-81:running", "S-1:stopped"}), []string{"S-1 stopped"}},
		{"T-52 comes back; F-81 ends again", snap(
			[]string{"escalation:F-83:esc", "escalation:F-81:esc", "task:T-2", "task:T-52"},
			[]string{"F-81:failed", "S-1:stopped"}), []string{"T-52 task", "F-81 failed"}},
	}
	for _, s := range steps {
		if got := titles(d.Diff(s.snap)); !slices.Equal(got, s.want) {
			t.Errorf("%s: %q, want %q", s.what, got, s.want)
		}
	}
}

// runStatuses are the statuses a runs row can have: those src/feature-run.js writes (running,
// clean, no-change, reviewed, escalated, failed; stopped from F-88), and stale from the snapshot.
var runStatuses = []string{"running", "stale", "clean", "no-change", "reviewed", "escalated", "failed", "stopped"}

func TestRunThatEndsCleanNotifies(t *testing.T) {
	for _, status := range runStatuses {
		var d Differ
		d.Diff(snap(nil, []string{"F-81:running"}))
		want := 1
		if status == "running" || status == "stale" {
			want = 0
		}
		if notes := d.Diff(snap(nil, []string{"F-81:" + status})); len(notes) != want {
			t.Errorf("running → %s: %d notes, want %d", status, len(notes), want)
		}
	}
}

// skip is snap with ids in Runs.Skipped and the section's error set, as a read that could not read
// those run states gives it.
func skip(runs []string, ids ...string) *stream.Snapshot {
	s := snap(nil, runs)
	s.Runs.Skipped, s.Runs.Error = ids, "skipped: …"
	return s
}

func TestDiffKeepsARunThatWasSkipped(t *testing.T) {
	cases := []struct {
		what  string
		snaps []*stream.Snapshot
		want  []int // notes per snapshot
	}{
		{"end, skip with its last good row, back: no second note",
			[]*stream.Snapshot{snap(nil, []string{"F-1:running"}), snap(nil, []string{"F-1:reviewed"}),
				skip([]string{"F-1:reviewed"}, "F-1"), snap(nil, []string{"F-1:reviewed"})},
			[]int{0, 1, 0, 0}},
		{"end, skip with no row, back: no second note",
			[]*stream.Snapshot{snap(nil, []string{"F-1:running"}), snap(nil, []string{"F-1:reviewed"}),
				skip(nil, "F-1"), snap(nil, []string{"F-1:reviewed"})},
			[]int{0, 1, 0, 0}},
		{"skipped at the first read, then read as ended long ago: no note",
			[]*stream.Snapshot{skip([]string{"F-2:running"}, "F-9"), snap(nil, []string{"F-2:running", "F-9:reviewed"})},
			[]int{0, 0}},
		{"skipped at the first read, then running, then clean: one note",
			[]*stream.Snapshot{skip(nil, "F-9"), snap(nil, []string{"F-9:running"}), snap(nil, []string{"F-9:clean"})},
			[]int{0, 0, 1}},
		{"skipped while running with no row, then clean: one note",
			[]*stream.Snapshot{snap(nil, []string{"F-1:running"}), skip(nil, "F-1"), skip(nil, "F-1"), snap(nil, []string{"F-1:clean"})},
			[]int{0, 0, 0, 1}},
		{"a run that leaves the rows unskipped and comes back ended notifies",
			[]*stream.Snapshot{snap(nil, []string{"F-1:running"}), snap(nil, nil), snap(nil, []string{"F-1:clean"})},
			[]int{0, 0, 1}},
	}
	for _, c := range cases {
		var d Differ
		for i, s := range c.snaps {
			if got := d.Diff(s); len(got) != c.want[i] {
				t.Errorf("%s: snapshot %d: notes %q, want %d", c.what, i, titles(got), c.want[i])
			}
		}
	}
}

func TestDiffWaitsForASectionsFirstRead(t *testing.T) {
	var d Differ
	unread := snap(nil, []string{"F-81:running"})
	unread.Attention.ReadAt = time.Time{}
	if notes := d.Diff(unread); notes != nil {
		t.Fatalf("first snapshot: %v", notes)
	}
	// The attention section's first read is its baseline; the runs section has one already.
	if got := titles(d.Diff(snap([]string{"task:T-2"}, []string{"F-81:reviewed"}))); !slices.Equal(got, []string{"F-81 reviewed"}) {
		t.Errorf("the first read of attention: %q, want only the run", got)
	}
}

func TestRunLine(t *testing.T) {
	notes := (&Differ{runs: map[string]string{}}).Diff(&stream.Snapshot{Runs: stream.Runs{
		Section: stream.Section{ReadAt: readAt},
		Rows:    []stream.Run{{ID: "F-81", Status: "clean", Step: "closing-review"}, {ID: "F-87", Status: "stopped", Step: "implement", Story: "S-1337"}},
	}})
	got := []string{notes[0].Line, notes[1].Line}
	if want := []string{"ended at closing-review", "ended at implement (S-1337)"}; !slices.Equal(got, want) {
		t.Errorf("lines %q, want %q", got, want)
	}
}

func TestBellIsTheTerminalBell(t *testing.T) {
	if msg, ok := Bell()().(tea.RawMsg); !ok || msg.Msg != "\a" {
		t.Errorf("Bell: %#v", Bell()())
	}
}

// script writes an executable sh script to a temp dir and returns its path.
func script(t *testing.T, name, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSender(t *testing.T) {
	note := Note{ID: "T-52", Kind: "task", Line: "Renovate image: 8 advisories"}
	args := filepath.Join(t.TempDir(), "args")
	ok := Sender{Name: "push", Argv: []string{script(t, "ok", `printf '%s\n' "$@" > "$1"`), args, "-x"}}
	if got := ok.Send(note)(); got != (ResultMsg{Sender: "push"}) {
		t.Errorf("exit 0: %#v", got)
	}
	data, err := os.ReadFile(args)
	if err != nil {
		t.Fatal(err)
	}
	if want := args + "\n-x\nT-52 task\nRenovate image: 8 advisories\n"; string(data) != want {
		t.Errorf("arguments %q, want %q", data, want)
	}

	fail := Sender{Name: "push", Argv: []string{script(t, "fail", "echo first >&2\necho 'no daemon' >&2\necho >&2\nexit 1\n")}}
	if got := fail.Send(note)(); got != (ResultMsg{Sender: "push", Err: "no daemon"}) {
		t.Errorf("exit 1: %#v", got)
	}
	silent := Sender{Name: "push", Argv: []string{script(t, "silent", "exit 3\n")}}
	if got := silent.Send(note)(); got != (ResultMsg{Sender: "push", Err: "exit status 3"}) {
		t.Errorf("exit 3 with no stderr: %#v", got)
	}

	timeout = 200 * time.Millisecond
	t.Cleanup(func() { timeout = 10 * time.Second })
	// The child sleep keeps stderr open: the timeout kills it too, so the sender ends at once.
	slow := Sender{Name: "push", Argv: []string{script(t, "slow", "echo waiting >&2\nsleep 30\n")}}
	start := time.Now()
	if got := slow.Send(note)(); got != (ResultMsg{Sender: "push", Err: "timeout"}) {
		t.Errorf("timeout: %#v", got)
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Errorf("the timed-out sender took %s", took)
	}
}

// A command that ends, leaving a child that holds its stderr: its own exit is the result, within
// the wait delay, and never `timeout`.
func TestSenderDoesNotWaitForAChildOfAnExit0Command(t *testing.T) {
	timeout = 3 * time.Second
	t.Cleanup(func() { timeout = 10 * time.Second })
	note := Note{ID: "T-52", Kind: "task", Line: "x"}
	for _, c := range []struct {
		body, want string
	}{
		{"sleep 5 >&2 &\nexit 0\n", ""},
		{"sleep 5 >&2 &\necho 'no daemon' >&2\nexit 1\n", "no daemon"},
	} {
		s := Sender{Name: "push", Argv: []string{script(t, "bg", c.body)}}
		start := time.Now()
		if got := s.Send(note)(); got != (ResultMsg{Sender: "push", Err: c.want}) {
			t.Errorf("%q: %#v, want Err %q", c.body, got, c.want)
		}
		if took := time.Since(start); took >= timeout {
			t.Errorf("%q: the sender took %s, the timeout is %s", c.body, took, timeout)
		}
	}
}

func TestPushGetsNewEscalationsAndTasksOnly(t *testing.T) {
	args := filepath.Join(t.TempDir(), "args")
	push := Push([]string{script(t, "push", `printf '%s|' "$@" >> "$1"; echo >> "$1"`), args})
	if push.Name != "push" {
		t.Errorf("Push().Name = %q", push.Name)
	}
	var d Differ
	d.Diff(snap([]string{"task:T-2"}, []string{"F-81:running"}))
	notes := d.Diff(snap(
		[]string{"task:T-2", "escalation:F-83:esc", "task:T-52", "change:S-9:change"},
		[]string{"F-81:reviewed", "S-2:escalated"}))
	if got, want := titles(notes), []string{"F-83:esc escalation", "T-52 task", "F-81 reviewed", "S-2 escalated"}; !slices.Equal(got, want) {
		t.Fatalf("notes %q, want %q", got, want)
	}
	for _, n := range notes {
		if push.Wants(n) {
			if got := push.Send(n)(); got != (ResultMsg{Sender: "push"}) {
				t.Errorf("%s %s: %#v", n.ID, n.Kind, got)
			}
		}
	}
	data, err := os.ReadFile(args)
	if err != nil {
		t.Fatal(err)
	}
	if want := args + "|F-83:esc escalation|line of F-83:esc|\n" + args + "|T-52 task|line of T-52|\n"; string(data) != want {
		t.Errorf("push ran with %q, want %q", data, want)
	}
	desktop := Sender{Name: "desktop", Argv: []string{"notify-send"}}
	for _, n := range notes {
		if !desktop.Wants(n) {
			t.Errorf("the desktop sender does not want %s %s", n.ID, n.Kind)
		}
	}
}

func TestDesktopNeedsNotifySendOnPath(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if _, ok := Desktop(); ok {
		t.Error("a desktop sender with no notify-send on PATH")
	}
	args := filepath.Join(t.TempDir(), "args")
	dir := filepath.Dir(script(t, "notify-send", `printf '%s\n' "$@" > "`+args+`"`+"\n"))
	t.Setenv("PATH", dir)
	s, ok := Desktop()
	if want := []string{filepath.Join(dir, "notify-send"), "-a", "bl top", "--"}; !ok || s.Name != "desktop" || !slices.Equal(s.Argv, want) {
		t.Errorf("Desktop() = %#v, %v", s, ok)
	}
	// A title and a line that start with `-` come after `--`, so notify-send reads them as text.
	if got := s.Send(Note{ID: "-T-9", Kind: "task", Line: "--help"})(); got != (ResultMsg{Sender: "desktop"}) {
		t.Fatalf("send: %#v", got)
	}
	if data, _ := os.ReadFile(args); string(data) != "-a\nbl top\n--\n-T-9 task\n--help\n" {
		t.Errorf("notify-send got %q", data)
	}
}
