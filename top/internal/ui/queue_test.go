package ui

import (
	"slices"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

// The tests of the action queue (F-127 Decision 4). In the recorded snapshot's next box, F-84,
// F-80 and F-86 are ranked, in that order.

// unrankThree presses x on F-84, F-80 and F-86, one after the other, and returns the model and the
// command of each press.
func unrankThree(t *testing.T) (Model, []tea.Cmd) {
	t.Helper()
	m := atRow(t, nextBox, "F-84")
	var cmds []tea.Cmd
	for i := range 3 {
		if i > 0 {
			m, _ = press(t, m, down)
		}
		var cmd tea.Cmd
		m, cmd = press(t, m, text("x"))
		cmds = append(cmds, cmd)
	}
	return m, cmds
}

func TestARankKeyRunsAtOnceAndReportsOnTheNoteLine(t *testing.T) {
	fakeTools(t, true, "", 0)
	m, cmd := press(t, atRow(t, nextBox, "F-84"), text("x"))
	if cmd == nil || m.dialog != nil {
		t.Fatalf("x: command %v, dialog %+v", cmd != nil, m.dialog)
	}
	// While it runs, the note line shows its command, in the text color.
	if !strings.Contains(noteLine(t, m), "┐bl rank F-84 --remove┌") || !strings.Contains(m.render(), styleText.Render("bl rank F-84 --remove")) {
		t.Errorf("while x runs, the note line %q", noteLine(t, m))
	}
	// On success the line clears.
	m, _ = update(t, m, cmd())
	if strings.Contains(noteLine(t, m), "bl rank") || m.note != "" {
		t.Errorf("after exit 0, the note line %q", noteLine(t, m))
	}
	// On failure it shows the command, its exit code and its last stderr line, in red.
	fakeTools(t, true, "F-84 is not ranked", 1)
	m, cmd = press(t, atRow(t, nextBox, "F-84"), text("x"))
	m, _ = update(t, m, cmd())
	const want = "bl rank F-84 --remove: exit 1 · F-84 is not ranked"
	if !strings.Contains(noteLine(t, m), "┐"+want+"┌") || !strings.Contains(m.render(), styleError.Render(want)) {
		t.Errorf("after exit 1, the note line %q, want %q in red", noteLine(t, m), want)
	}
}

func TestActionsRunOneAtATimeInKeyPressOrder(t *testing.T) {
	dir := fakeTools(t, true, "", 0)
	m, cmds := unrankThree(t)
	if cmds[0] == nil || cmds[1] != nil || cmds[2] != nil || len(m.jobs) != 3 {
		t.Fatalf("three x: only the first should start; %d jobs", len(m.jobs))
	}
	// The note line shows the command that runs now, not the ones that wait.
	if l := noteLine(t, m); !strings.Contains(l, "bl rank F-84 --remove") || strings.Contains(l, "F-80") {
		t.Errorf("the note line %q", l)
	}
	// Each end starts the next job: before it, only the jobs before it ran.
	msg := cmds[0]()
	if got := logOf(t, dir, "bl"); len(got) != 1 {
		t.Fatalf("the first end: bl ran %q", got)
	}
	m, next := update(t, m, msg)
	for i := 1; i < 3; i++ {
		if next == nil || len(m.jobs) != 3-i {
			t.Fatalf("end %d: next %v, %d jobs", i, next != nil, len(m.jobs))
		}
		msg = next()
		if got := logOf(t, dir, "bl"); len(got) != i+1 {
			t.Fatalf("end %d: bl ran %q", i+1, got)
		}
		m, next = update(t, m, msg)
	}
	if next != nil || len(m.jobs) != 0 {
		t.Errorf("after the last end: next %v, %d jobs", next != nil, len(m.jobs))
	}
	want := []string{"rank F-84 --remove", "rank F-80 --remove", "rank F-86 --remove"}
	if got := logOf(t, dir, "bl"); !slices.Equal(got, want) {
		t.Errorf("bl ran %q, want %q", got, want)
	}
}

func TestAFailureDropsTheQueuedActions(t *testing.T) {
	dir := fakeTools(t, true, "F-84 is not ranked", 1)
	m, cmds := unrankThree(t)
	m, next := update(t, m, cmds[0]())
	if next != nil || len(m.jobs) != 0 {
		t.Errorf("after the failure: next %v, %d jobs", next != nil, len(m.jobs))
	}
	if got := logOf(t, dir, "bl"); len(got) != 1 {
		t.Errorf("bl ran %q, want the first x only", got)
	}
	if want := "bl rank F-84 --remove: exit 1 · F-84 is not ranked · dropped 2 queued actions"; m.note != want {
		t.Errorf("the note %q, want %q", m.note, want)
	}
}

// TestAWindowHoldsTheQueueOnlyForItsTmuxCall: g opens a tmux window; x, pressed while tmux runs,
// starts when tmux ends, not when the command in the window ends. w queues the same way.
func TestAWindowHoldsTheQueueOnlyForItsTmuxCall(t *testing.T) {
	dir := fakeTools(t, true, "", 0)
	m := atRow(t, nextBox, "F-84")
	m.detail = "S-1330"
	m, window := press(t, m, text("g"))
	m, x := press(t, m, text("x"))
	m, w := press(t, m, text("w"))
	if window == nil || x != nil || w != nil || len(m.jobs) != 3 || m.jobs[0].window == "" {
		t.Fatalf("g, x, w: %+v", m.jobs)
	}
	m, next := update(t, m, window())
	if next == nil || m.jobs[0].show != "bl rank F-84 --remove" {
		t.Fatalf("the window's end did not start x: %+v", m.jobs)
	}
	m, next = update(t, m, next())
	if next == nil || m.jobs[0].show != "bl watch S-1330  (new tmux window)" {
		t.Fatalf("x's end did not start w: %+v", m.jobs)
	}
	settle(t, m, next)
	if got := logOf(t, dir, "tmux"); len(got) != 2 {
		t.Errorf("tmux ran %q, want g's and w's windows", got)
	}
	if got := logOf(t, dir, "bl"); !slices.Equal(got, []string{"rank F-84 --remove"}) {
		t.Errorf("bl ran %q", got)
	}
}
