package ui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/roost-cc/bl/top/internal/notify"
	"github.com/roost-cc/bl/top/internal/stream"
)

// fakeNotifySend puts a notify-send with that sh body first on PATH, and returns the desktop
// sender that finds it.
func fakeNotifySend(t *testing.T, body string) notify.Sender {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notify-send"), []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	s, ok := notify.Desktop()
	if !ok {
		t.Fatal("notify-send is not found on PATH")
	}
	return s
}

// notifying is a model of a 100×40 terminal with that bell and those senders, with the local zone
// fixed for the test (fixedLocal), so the runs box's clock does not depend on the machine.
func notifying(t *testing.T, bell bool, senders []notify.Sender) Model {
	t.Helper()
	fixedLocal(t)
	m, _ := update(t, New([]string{"bl"}, 2000, bell, senders), tea.WindowSizeMsg{Width: 100, Height: 40})
	return m
}

// inbox is a snapshot whose read inbox holds those tasks.
func inbox(ids ...string) stream.Snapshot {
	s := stream.Snapshot{Schema: stream.Schema}
	s.Attention.ReadAt = time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	for _, id := range ids {
		s.Attention.Items = append(s.Attention.Items, stream.Item{Kind: "task", ID: id, Line: "re-mint the key"})
	}
	return s
}

// receive gives m the snapshot s, as Update does for a stream line, runs the notification
// commands, and returns their messages. Update adds the wait for the stream's next line, which the
// test has no stream for.
func receive(t *testing.T, m Model, s stream.Snapshot) (Model, []tea.Msg) {
	t.Helper()
	m, cmds := m.snapshot(s)
	if m.snap == nil || m.snap.Attention.ReadAt != s.Attention.ReadAt {
		t.Fatal("the snapshot was not kept")
	}
	var msgs []tea.Msg
	for _, c := range cmds {
		msgs = append(msgs, c())
	}
	return m, msgs
}

func TestANewTaskRingsTheBellAndRunsNotifySend(t *testing.T) {
	args := filepath.Join(t.TempDir(), "args")
	desktop := fakeNotifySend(t, `printf '%s\n' "$@" > `+args+"\n")
	m := notifying(t, true, []notify.Sender{desktop})
	m, msgs := receive(t, m, inbox("T-1"))
	if msgs != nil {
		t.Fatalf("the first snapshot notified: %v", msgs)
	}
	m, msgs = receive(t, m, inbox("T-1", "T-2"))
	if len(msgs) != 2 || msgs[0] != (tea.RawMsg{Msg: "\a"}) || msgs[1] != (notify.ResultMsg{Sender: "desktop"}) {
		t.Fatalf("a new task: %#v, want the bell and notify-send's result", msgs)
	}
	data, err := os.ReadFile(args)
	if err != nil {
		t.Fatal(err)
	}
	if want := "-a\nbl top\n--\nT-2 task\nre-mint the key\n"; string(data) != want {
		t.Errorf("notify-send got %q, want %q", data, want)
	}
	if _, msgs = receive(t, m, inbox("T-1", "T-2")); msgs != nil {
		t.Error("T-2 notified twice")
	}
}

func TestNoBellOnlyRunsTheSenders(t *testing.T) {
	m := notifying(t, false, []notify.Sender{fakeNotifySend(t, "exit 0\n")})
	m, _ = receive(t, m, inbox())
	if _, msgs := receive(t, m, inbox("T-2")); len(msgs) != 1 || msgs[0] != (notify.ResultMsg{Sender: "desktop"}) {
		t.Errorf("--no-bell: %#v, want notify-send's result only", msgs)
	}
	// --no-bell and --no-desktop: nothing.
	m = notifying(t, false, nil)
	m, _ = receive(t, m, inbox())
	if _, msgs := receive(t, m, inbox("T-2")); msgs != nil {
		t.Error("a notification with no bell and no sender")
	}
}

func TestAFailedSenderWarnsInTheBottomBorderUntilItSucceeds(t *testing.T) {
	desktop := fakeNotifySend(t, "echo 'GDBus.Error: no notification daemon' >&2\nexit 1\n")
	m := notifying(t, true, []notify.Sender{desktop})
	m, _ = update(t, m, desktop.Send(notify.Note{ID: "T-2", Kind: "task", Line: "re-mint the key"})())
	golden(t, "warning-100x40", screen(t, m))
	if !strings.Contains(m.render(), styleError.Render("desktop failed: GDBus.Error: no notification daemon")) {
		t.Error("the warning is not red")
	}
	m, _ = update(t, m, notify.ResultMsg{Sender: "desktop"})
	if strings.Contains(screen(t, m), "failed") {
		t.Error("the warning stayed after the sender succeeded")
	}
}

func TestAFailedPushWarnsInTheBottomBorder(t *testing.T) {
	path := filepath.Join(t.TempDir(), "phone-push")
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho 'ntfy: 403 forbidden' >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	m := notifying(t, true, []notify.Sender{notify.Push([]string{path})})
	m, _ = receive(t, m, inbox())
	_, msgs := receive(t, m, inbox("T-2"))
	if len(msgs) != 2 || msgs[1] != (notify.ResultMsg{Sender: "push", Err: "ntfy: 403 forbidden"}) {
		t.Fatalf("a new task with a failing push: %#v", msgs)
	}
	m, _ = update(t, m, msgs[1])
	golden(t, "push-warning-100x40", screen(t, m))
	if !strings.Contains(m.render(), styleError.Render("push failed: ntfy: 403 forbidden")) {
		t.Error("the warning is not red")
	}
}

func TestALongWarningFitsTheBottomBorder(t *testing.T) {
	long := "desktop failed: " + strings.Repeat("x", 200)
	for _, w := range []int{80, 171} {
		got := ansi.Strip(keyBar(w, []string{long}))
		if lipgloss.Width(got) != w || !strings.HasPrefix(got, "╰┘↑↓└┘tab└┘↵└┘a└┘r└┘s└┘o└┘p└┘g└┘h└┘q└─┐desktop failed: x") || !strings.HasSuffix(got, "x…┌─╯") {
			t.Errorf("keyBar(%d) with a long warning = %q", w, got)
		}
	}
	short := ansi.Strip(keyBar(171, []string{"desktop failed: timeout"}))
	if !strings.HasPrefix(short, "╰┘↑↓ select└┘tab box└┘↵ detail└┘a act└┘r run└┘s stop└┘o open└┘p PR└┘g agent└┘h help└┘q quit└─") || !strings.HasSuffix(short, "─┐desktop failed: timeout┌─╯") {
		t.Errorf("keyBar(171) with a short warning = %q", short)
	}
}

// TestTheRunsBoxAndTheNotesAgreeOnTheEndOfARun: for every status a runs row can have (those
// src/feature-run.js writes, stale, and none), the runs box shows a run that ended (✓ done, ■ stop,
// ✗) exactly when a change to that status makes a note, and stream.Ended says the same.
func TestTheRunsBoxAndTheNotesAgreeOnTheEndOfARun(t *testing.T) {
	read := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	runs := func(status string) *stream.Snapshot {
		s := &stream.Snapshot{}
		s.Runs.ReadAt = read
		s.Runs.Rows = []stream.Run{{ID: "F-81", Status: status}}
		return s
	}
	for _, status := range []string{"running", "stale", "clean", "no-change", "reviewed", "escalated", "failed", "stopped", ""} {
		glyph, _, _ := runState(status)
		goesOn := glyph == "● run" || glyph == "◌ stale" || glyph == "? unk"
		var d notify.Differ
		d.Diff(runs("running"))
		if notes := d.Diff(runs(status)); goesOn != (len(notes) == 0) || goesOn == stream.Ended(status) {
			t.Errorf("%s: the runs box shows %q, %d notes, Ended %v", status, glyph, len(notes), stream.Ended(status))
		}
	}
}
