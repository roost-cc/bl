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
			[]string{"F-81:running", "F-85:done", "S-1:running"}), nil},
		{"nothing changed", snap(
			[]string{"escalation:F-83:esc", "task:T-2", "change:F-81:change"},
			[]string{"F-81:running", "F-85:done", "S-1:running"}), nil},
		{"a new escalation, task and change; two runs end; one goes stale", snap(
			[]string{"runner:updates:run", "escalation:F-83:esc", "escalation:F-81:esc", "task:T-2", "task:T-52", "change:S-9:change", "change:F-81:change"},
			[]string{"F-81:escalated", "F-85:done", "S-1:stale", "S-2:done"}),
			[]string{"F-81:esc escalation", "T-52 task", "F-81 escalated", "S-2 done"}},
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

func TestDiffWaitsForASectionsFirstRead(t *testing.T) {
	var d Differ
	unread := snap(nil, []string{"F-81:running"})
	unread.Attention.ReadAt = time.Time{}
	if notes := d.Diff(unread); notes != nil {
		t.Fatalf("first snapshot: %v", notes)
	}
	// The attention section's first read is its baseline; the runs section has one already.
	if got := titles(d.Diff(snap([]string{"task:T-2"}, []string{"F-81:done"}))); !slices.Equal(got, []string{"F-81 done"}) {
		t.Errorf("the first read of attention: %q, want only the run", got)
	}
}

func TestRunLine(t *testing.T) {
	notes := (&Differ{runs: map[string]string{}}).Diff(&stream.Snapshot{Runs: stream.Runs{
		Section: stream.Section{ReadAt: readAt},
		Rows:    []stream.Run{{ID: "F-81", Status: "done", Step: "merged"}, {ID: "F-87", Status: "stopped", Step: "implement", Story: "S-1337"}},
	}})
	got := []string{notes[0].Line, notes[1].Line}
	if want := []string{"ended at merged", "ended at implement (S-1337)"}; !slices.Equal(got, want) {
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

func TestDesktopNeedsNotifySendOnPath(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if _, ok := Desktop(); ok {
		t.Error("a desktop sender with no notify-send on PATH")
	}
	dir := filepath.Dir(script(t, "notify-send", "exit 0\n"))
	t.Setenv("PATH", dir)
	s, ok := Desktop()
	if want := []string{filepath.Join(dir, "notify-send"), "-a", "bl top"}; !ok || s.Name != "desktop" || !slices.Equal(s.Argv, want) {
		t.Errorf("Desktop() = %#v, %v", s, ok)
	}
}
