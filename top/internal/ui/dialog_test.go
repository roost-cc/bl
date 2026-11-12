package ui

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/roost-cc/bl/top/internal/actions"
	"github.com/roost-cc/bl/top/internal/notify"
	"github.com/roost-cc/bl/top/internal/stream"
)

// fakeTools puts a fake bl, tmux, xdg-open and open first on PATH, and sets $TMUX for getenv when
// inTmux is true. Each writes its arguments, one per line, to <name>.args in the directory it
// returns; bl then writes stderr on stderr and exits with code.
func fakeTools(t *testing.T, inTmux bool, stderr string, code int) string {
	t.Helper()
	dir := t.TempDir()
	for _, name := range []string{"bl", "tmux", "xdg-open", "open"} {
		body := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' \"$@\" > %s\n", filepath.Join(dir, name+".args"))
		if name == "bl" {
			body += fmt.Sprintf("echo $$ >> %s\necho 'a first line' >&2\necho '%s' >&2\nexit %d\n",
				filepath.Join(dir, "bl.pids"), stderr, code)
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	env := map[string]string{}
	if inTmux {
		env["TMUX"] = "/tmp/tmux-1000/default,1,0"
	}
	getenv = func(k string) string { return env[k] }
	t.Cleanup(func() { getenv = os.Getenv })
	return dir
}

// argsOf are the arguments that the fake name of fakeTools got; nil when it did not run.
func argsOf(t *testing.T, dir, name string) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, name+".args"))
	if err != nil {
		return nil
	}
	return strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
}

// blPids are the pids of the runs of fakeTools' bl in dir, in the order they wrote them.
func blPids(t *testing.T, dir string) []int {
	t.Helper()
	var pids []int
	data, err := os.ReadFile(filepath.Join(dir, "bl.pids"))
	if err != nil {
		return nil
	}
	for _, l := range strings.Fields(string(data)) {
		pid, err := strconv.Atoi(l)
		if err != nil {
			t.Fatalf("bl.pids: %v", err)
		}
		pids = append(pids, pid)
	}
	return pids
}

// ended is m's snapshot with each run of ends `stopped`, by the bl stop pids given.
func ended(m Model, ends map[string][]int) *stream.Snapshot {
	next := *m.snap
	next.Runs.Rows = slices.Clone(next.Runs.Rows)
	for i, r := range next.Runs.Rows {
		if by, ok := ends[r.ID]; ok {
			next.Runs.Rows[i].Status, next.Runs.Rows[i].StoppedBy = "stopped", by
		}
	}
	return &next
}

// notifies says whether notes hold one about run id.
func notifies(notes []notify.Note, id string) bool {
	return slices.ContainsFunc(notes, func(n notify.Note) bool { return n.ID == id })
}

// external is the pid of a bl stop that another shell started.
const external = 4242

// typed are the key presses of s, one per character.
func typed(s string) []tea.KeyPressMsg {
	var out []tea.KeyPressMsg
	for _, r := range s {
		if r == ' ' {
			out = append(out, tea.KeyPressMsg{Code: tea.KeySpace, Text: " "})
		} else {
			out = append(out, text(string(r)))
		}
	}
	return out
}

var (
	esc       = tea.KeyPressMsg{Code: tea.KeyEscape}
	backspace = tea.KeyPressMsg{Code: tea.KeyBackspace}
)

// atRow is the recorded snapshot at 171×63, with row id selected in box b and the focus there.
func atRow(t *testing.T, b boxName, id string) Model {
	t.Helper()
	m, _ := update(t, sized(t, 171, 63), snapshot(t))
	m = focused(t, m, b)
	for range 20 {
		if i := m.selected(b); i >= 0 && m.rowIDs(b)[i] == id {
			return m
		}
		m, _ = press(t, m, down)
	}
	t.Fatalf("no row %s in the %s box", id, b)
	return m
}

// dialogText is the open dialog without its colors.
func dialogText(m Model) string {
	return ansi.Strip(strings.Join(m.dialogBox(m.width), "\n"))
}

// TestActionDialogsGolden draws Mockup C's four boxes: the menu of T-52, the note of its task
// done, the stop question of S-1330, and a result.
func TestActionDialogsGolden(t *testing.T) {
	fakeTools(t, true, "", 0)
	var out []string
	m, _ := press(t, atRow(t, attentionBox, "T-52"), text("a"))
	out = append(out, dialogText(m))
	m, _ = press(t, m, append([]tea.KeyPressMsg{text("d")}, typed("image rebuilt on 44.140, 0 high advisories")...)...)
	out = append(out, dialogText(m))
	m, _ = press(t, atRow(t, runsBox, "S-1330"), text("s"))
	out = append(out, dialogText(m))
	// The result of an action whose box esc hid: it shows with no dialog open.
	m.dialog = nil
	m, _ = update(t, m, actionDoneMsg{words: []string{"bl", "task", "done", "T-52"},
		result: actions.Result{Code: 0, Last: "committed tasks/T52-renovate-image (backlog 4f1c2a9)"}})
	out = append(out, dialogText(m))
	golden(t, "actions", strings.Join(out, "\n\n"))
	// Over the screen, the dialog keeps every line at the terminal's width.
	screen(t, m)
}

func TestAOpensTheMenuOfTheSelectedRowsActions(t *testing.T) {
	fakeTools(t, true, "", 0)
	for _, c := range []struct {
		box  boxName
		id   string
		want []string
	}{
		{runsBox, "F-83", []string{"r  resume the run", "bl run F-83 --resume  (new tmux window)", "o  open the page", "p  open the pull request",
			"xdg-open https://example.invalid/roost-cc/bl/pull/12", "g  talk it through", "bl agent  (new tmux window)"}},
		{attentionBox, "F-83:esc", []string{"e  read the escalation", "bl status F-83  (new tmux window)"}},
		{attentionBox, "F-81:change", []string{"m  merge it", "bl merge F-81"}},
		{attentionBox, "updates:run", []string{"▶ g  talk it through"}},
		// A ranked unit: its put templates wait for a yank; x renders with the selected id (F-113 D7).
		{nextBox, "F-84", []string{"▶ p  put the yanked unit after it   yank a work unit first (y)", "x  unrank it", "bl rank F-84 --remove",
			"o  open the page", "bl view F-84  (new tmux window)"}},
	} {
		m, _ := press(t, atRow(t, c.box, c.id), text("a"))
		out := dialogText(m)
		if !strings.Contains(out, "act on "+c.id) {
			t.Errorf("a on %s: no menu:\n%s", c.id, out)
		}
		for _, want := range c.want {
			if !strings.Contains(out, want) {
				t.Errorf("a on %s: no %q:\n%s", c.id, want, out)
			}
		}
		// ↓ moves the menu's selection; esc closes it.
		if m, _ = press(t, m, down); m.dialog.cursor != min(1, len(m.dialog.actions)-1) {
			t.Errorf("↓ in the menu of %s: cursor %d", c.id, m.dialog.cursor)
		}
		if m, _ = press(t, m, esc); m.dialog != nil {
			t.Errorf("esc did not close the menu of %s", c.id)
		}
	}
	// The grouped update row (stacked layout) has no actions.
	m, _ := update(t, sized(t, 100, 40), snapshot(t))
	m, _ = press(t, m, tab)
	for m.attentionRows()[m.selected(attentionBox)].item != nil {
		m, _ = press(t, m, down)
	}
	if m, _ = press(t, m, text("a")); m.dialog != nil || !strings.Contains(screen(t, m), "a: select a row first") {
		t.Errorf("a on the update group:\n%s", screen(t, m))
	}
}

func TestTaskDoneRunsAfterYWithTheNoteAndShowsTheResult(t *testing.T) {
	dir := fakeTools(t, true, "committed tasks/T52-renovate-image (backlog 4f1c2a9)", 0)
	m, _ := press(t, atRow(t, attentionBox, "T-52"), text("a"), down, up, up, enter)
	if m.dialog == nil || m.dialog.stage != stageInput {
		t.Fatal("↵ on close the task did not ask for its note")
	}
	m, _ = press(t, m, typed("image rebuilt!")...)
	m, _ = press(t, m, backspace, enter)
	out := dialogText(m)
	if !strings.Contains(out, `runs: bl task done T-52 'image rebuilt'`) || !strings.Contains(out, "y  close the task     n  cancel") {
		t.Fatalf("the question:\n%s", out)
	}
	m, cmd := press(t, m, text("y"))
	if cmd == nil || !strings.Contains(dialogText(m), "running") {
		t.Fatalf("y: no command, or no running box:\n%s", dialogText(m))
	}
	m, _ = update(t, m, cmd())
	if got := argsOf(t, dir, "bl"); !slices.Equal(got, []string{"task", "done", "T-52", "image rebuilt"}) {
		t.Errorf("bl got %q", got)
	}
	out = screen(t, m)
	for _, want := range []string{"done┌", `✓ bl task done T-52 'image rebuilt'   exit 0`, "stderr: committed tasks/T52-renovate-image (backlog 4f1c2a9)", "any key to close"} {
		if !strings.Contains(out, want) {
			t.Errorf("the result box has no %q:\n%s", want, out)
		}
	}
	if m, _ = press(t, m, text("x")); m.dialog != nil {
		t.Error("a key did not close the result box")
	}
	// An empty note runs the verb without one; n cancels.
	m, _ = press(t, atRow(t, attentionBox, "T-52"), text("a"), text("d"), enter)
	if out := dialogText(m); !strings.Contains(out, "runs: bl task done T-52 ") || strings.Contains(out, "[note]") {
		t.Errorf("an empty note:\n%s", out)
	}
	m, cmd = press(t, m, text("y"))
	if m, _ = update(t, m, cmd()); !slices.Equal(argsOf(t, dir, "bl"), []string{"task", "done", "T-52"}) {
		t.Errorf("an empty note: bl got %q", argsOf(t, dir, "bl"))
	}
	m, _ = press(t, atRow(t, attentionBox, "T-52"), text("a"), text("d"), enter)
	if m, cmd = press(t, m, text("n")); m.dialog != nil || cmd != nil {
		t.Error("n did not cancel")
	}
}

func TestAFailedVerbShowsItsExitCodeAndLastStderrLine(t *testing.T) {
	fakeTools(t, true, "bl merge: F-81 is not ready_for_merge", 1)
	m, _ := press(t, atRow(t, attentionBox, "F-81:change"), text("a"), text("m"))
	if !strings.Contains(dialogText(m), "runs: bl merge F-81") {
		t.Fatalf("the question:\n%s", dialogText(m))
	}
	m, cmd := press(t, m, text("y"))
	m, _ = update(t, m, cmd())
	out := dialogText(m)
	if !strings.Contains(out, "failed┌") || !strings.Contains(out, "✗ bl merge F-81   exit 1") || !strings.Contains(out, "stderr: bl merge: F-81 is not ready_for_merge") {
		t.Errorf("the result box:\n%s", out)
	}
}

func TestAReasonIsNeeded(t *testing.T) {
	fakeTools(t, true, "", 0)
	m := atRow(t, attentionBox, "T-52")
	m.snap.Attention.Items[2].Actions = []stream.Action{{Key: "x", Label: "drop it", Argv: []string{"bl", "task", "drop", "T-52"}, Input: "reason"}}
	m, _ = press(t, m, text("a"), text("x"), enter)
	if m.dialog.stage != stageInput || !strings.Contains(dialogText(m), "a reason is needed") {
		t.Fatalf("an empty reason was taken:\n%s", dialogText(m))
	}
	m, _ = press(t, m, typed(" ")...)
	if m, _ = press(t, m, enter); m.dialog.stage != stageInput {
		t.Fatal("a blank reason was taken")
	}
	m, _ = press(t, m, typed("dup")...)
	m, _ = press(t, m, enter)
	if m.dialog.stage != stageAsk || !strings.Contains(dialogText(m), "runs: bl task drop T-52 dup") {
		t.Errorf("the reason:\n%s", dialogText(m))
	}
}

func TestRStartsOrResumesARunInANewTmuxWindow(t *testing.T) {
	cwd, _ := os.Getwd()
	for _, c := range []struct{ id, cmd string }{
		{"F-83", "'bl' 'run' 'F-83' '--resume'"}, // escalated
		{"F-79", "'bl' 'run' 'F-79' '--resume'"}, // stale
		{"F-85", "'bl' 'run' 'F-85'"},            // clean
	} {
		dir := fakeTools(t, true, "", 0)
		m, _ := press(t, atRow(t, runsBox, c.id), text("r"))
		if m.dialog == nil || m.dialog.stage != stageAsk || !strings.Contains(dialogText(m), "(new tmux window)") {
			t.Fatalf("r on %s did not ask first", c.id)
		}
		m, cmd := press(t, m, text("y"))
		if m.dialog != nil || cmd == nil {
			t.Fatalf("y on %s: dialog %v", c.id, m.dialog)
		}
		if msg := cmd(); msg != (tmuxDoneMsg{}) {
			t.Fatalf("tmux: %#v", msg)
		}
		want := []string{"new-window", "-n", c.id + " run", "-c", cwd, c.cmd + "; exec ${SHELL:-sh}"}
		if got := argsOf(t, dir, "tmux"); !slices.Equal(got, want) {
			t.Errorf("r on %s: tmux %q, want %q", c.id, got, want)
		}
		if argsOf(t, dir, "bl") != nil {
			t.Errorf("r on %s ran bl itself", c.id)
		}
	}
	// A live run has no r.
	fakeTools(t, true, "", 0)
	m, cmd := press(t, atRow(t, runsBox, "F-81"), text("r"))
	if m.dialog != nil || cmd != nil || !strings.Contains(screen(t, m), "r: F-81 has no such action (a lists its actions)") {
		t.Errorf("r on a live run:\n%s", screen(t, m))
	}
}

func TestSStopsALiveRunAfterMockupCsQuestionAndDoesNotNotify(t *testing.T) {
	dir := fakeTools(t, true, "stopped S-1330 at review; resume: bl run S-1330 --resume", 0)
	m, _ := press(t, atRow(t, runsBox, "S-1330"), text("s"))
	out := dialogText(m)
	for _, want := range []string{
		"bl stop S-1330┌",
		"S-1330 is in review r1 (codex gpt-6-sol), 4m in.",
		"bl stop ends the agent session and the run.",
		"The work so far stays on the branch.",
		"Resume it later with: bl run S-1330 --resume",
		"runs: bl stop S-1330",
		"y  stop the run     n  cancel",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("the stop question has no %q:\n%s", want, out)
		}
	}
	m, cmd := press(t, m, text("y"))
	m, _ = update(t, m, cmd())
	if got := argsOf(t, dir, "bl"); !slices.Equal(got, []string{"stop", "S-1330"}) {
		t.Errorf("bl got %q", got)
	}
	if !strings.Contains(dialogText(m), "stderr: stopped S-1330 at review; resume: bl run S-1330 --resume") {
		t.Errorf("the result:\n%s", dialogText(m))
	}
	// The next snapshots: S-1330 (stopped by this bl stop) does not notify; F-81 (stopped elsewhere) does.
	next := ended(m, map[string][]int{"S-1330": blPids(t, dir), "F-81": {external}})
	if notes := m.differ.Diff(next); len(notes) != 1 || notes[0].ID != "F-81" {
		t.Errorf("notes after the stop: %v, want F-81's only", notes)
	}
	// A run that is not live has no s.
	m, cmd = press(t, atRow(t, runsBox, "F-85"), text("s"))
	if m.dialog != nil || cmd != nil {
		t.Error("s on a run that is not live asked")
	}
}

// TestAFailedStopLeavesALaterStopLoud: whatever the end of a stop from this view (it did not start,
// exited 1, timed out with exit 1, or exited 0), with its result box shown or hidden, S-1330's
// `stopped` end is quiet only when that bl stop is one of the stops that stopped it. An end by
// another shell's stop, or by no named stop, notifies.
func TestAFailedStopLeavesALaterStopLoud(t *testing.T) {
	type by int
	const (
		own by = iota
		other
		none
	)
	for _, c := range []struct {
		what   string
		code   int
		noBl   bool // the command does not start
		hidden bool // esc hides the running box before the result
	}{
		{what: "the command did not start", noBl: true},
		{what: "exit 1", code: 1},
		{what: "exit 1 after the wait (stop requested)", code: 1, hidden: true},
		{what: "exit 0, hidden", code: 0, hidden: true},
		{what: "exit 0", code: 0},
	} {
		for _, who := range []by{own, other, none} {
			if c.noBl && who == own {
				continue // no child, no pid of its own
			}
			dir := fakeTools(t, true, "stop requested: S-1330 (pid 4242) stops at its next check", c.code)
			m := atRow(t, runsBox, "S-1330")
			if c.noBl {
				m.blArgv = []string{filepath.Join(t.TempDir(), "no-bl")}
			}
			m, _ = press(t, m, text("s"))
			m, cmd := press(t, m, text("y"))
			if c.hidden {
				m, _ = press(t, m, esc)
			}
			m, _ = update(t, m, cmd())
			stoppers := map[by][]int{own: blPids(t, dir), other: {external}, none: nil}[who]
			got := notifies(m.differ.Diff(ended(m, map[string][]int{"S-1330": stoppers})), "S-1330")
			if want := who != own; got != want {
				t.Errorf("%s, stopped by %v: S-1330's stopped end notifies: %v, want %v", c.what, stoppers, got, want)
			}
		}
	}
}

// TestExternalStopDuringFailedActionNotifies: another shell's stop ends S-1330 while this view's bl
// stop still runs, and that bl stop then fails. The end notifies once, when the snapshot shows it.
func TestExternalStopDuringFailedActionNotifies(t *testing.T) {
	fakeTools(t, true, "bl stop: cannot write the stop request: ENOSPC; nothing stopped", 1)
	m, _ := press(t, atRow(t, runsBox, "S-1330"), text("s"))
	m, cmd := press(t, m, text("y"))
	stopped := ended(m, map[string][]int{"S-1330": {external}})
	first := m.differ.Diff(stopped)
	m, _ = update(t, m, cmd())
	later := m.differ.Diff(stopped)
	if !notifies(first, "S-1330") || notifies(later, "S-1330") {
		t.Errorf("the external stop's end: notes while the action ran %v, after it failed %v; want one, at once", first, later)
	}
}

// TestTimedOutStopLaterCompletesQuietly: this view's bl stop exits 1 after its wait, and its request
// stays; the run then stops at its next check, by that request. That end is quiet. After the end
// the mark is gone: a later stop from another shell notifies.
func TestTimedOutStopLaterCompletesQuietly(t *testing.T) {
	dir := fakeTools(t, true, "stop requested: S-1330 (pid 4242) stops at its next check", 1)
	m, _ := press(t, atRow(t, runsBox, "S-1330"), text("s"))
	m, cmd := press(t, m, text("y"))
	m, _ = update(t, m, cmd())
	running := m.snap
	if notes := m.differ.Diff(running); len(notes) != 0 {
		t.Errorf("a snapshot while the run still runs: %v", notes)
	}
	if notes := m.differ.Diff(ended(m, map[string][]int{"S-1330": blPids(t, dir)})); notifies(notes, "S-1330") {
		t.Errorf("the end by this view's request notified: %v", notes)
	}
	m.differ.Diff(running)
	if notes := m.differ.Diff(ended(m, map[string][]int{"S-1330": {external}})); !notifies(notes, "S-1330") {
		t.Errorf("a later stop from another shell: %v, want S-1330's end", notes)
	}
}

// TestOverlappingStopActionsKeepSuccessQuiet: two stops of S-1330 from this view overlap (the first
// box is hidden); the first fails and the second succeeds. The failure takes no mark off: an end by
// either of them is quiet, and an end by another shell's stop alone notifies.
func TestOverlappingStopActionsKeepSuccessQuiet(t *testing.T) {
	for _, c := range []struct {
		what   string
		by     func(failed, ok int) []int
		notify bool
	}{
		{"by the stop that succeeded", func(_, ok int) []int { return []int{ok} }, false},
		{"by the stop that failed (its request was read)", func(failed, _ int) []int { return []int{failed} }, false},
		{"by the one that succeeded and another shell's", func(_, ok int) []int { return []int{ok, external} }, false},
		{"by another shell's stop alone", func(int, int) []int { return []int{external} }, true},
	} {
		dir := fakeTools(t, true, "", 0)
		// The first bl stop to run fails, the other succeeds; each writes its pid to say which it is.
		// The claim is sh's own O_EXCL create (set -C): two mkdir runs can both succeed in a race.
		body := fmt.Sprintf("#!/bin/sh\nif (set -C; echo $$ > %[1]s/failed.pid) 2>/dev/null; then exit 1; fi\necho $$ > %[1]s/ok.pid\n", dir)
		if err := os.WriteFile(filepath.Join(dir, "bl"), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
		m, _ := press(t, atRow(t, runsBox, "S-1330"), text("s"))
		m, first := press(t, m, text("y"))
		m, _ = press(t, m, esc, text("s"))
		m, second := press(t, m, text("y"))
		m, _ = update(t, m, first())
		m, _ = update(t, m, second())
		pid := func(name string) int {
			data, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				t.Fatal(err)
			}
			n, err := strconv.Atoi(strings.TrimSpace(string(data)))
			if err != nil {
				t.Fatal(err)
			}
			return n
		}
		notes := m.differ.Diff(ended(m, map[string][]int{"S-1330": c.by(pid("failed.pid"), pid("ok.pid"))}))
		if got := notifies(notes, "S-1330"); got != c.notify {
			t.Errorf("%s: notifies %v, want %v", c.what, got, c.notify)
		}
	}
}

// TestALateResultKeepsTheNewerDialog: the result of an action whose box esc hid shows only in its
// own running box or with no dialog open; a newer dialog of each stage, or another action's running
// box, stays, and the result goes to the note line. A tmux window that opened late keeps the note.
func TestALateResultKeepsTheNewerDialog(t *testing.T) {
	fakeTools(t, true, "stopped S-1330 at review; resume: bl run S-1330 --resume", 0)
	// started runs bl stop S-1330 after its y, hides its box, and returns its end.
	started := func() (Model, tea.Msg) {
		m, _ := press(t, atRow(t, runsBox, "S-1330"), text("s"))
		m, cmd := press(t, m, text("y"))
		m, _ = press(t, m, esc)
		return m, cmd()
	}
	for _, stage := range []int{stageMenu, stageInput, stageAsk, stageRunning, stageResult} {
		m, done := started()
		newer := &dialog{stage: stage, row: "F-2", seq: 99}
		m.dialog = newer
		m, _ = update(t, m, done)
		if m.dialog != newer {
			t.Errorf("stage %d: the late result replaced the newer dialog", stage)
		}
		if !strings.Contains(m.note, "bl stop S-1330: exit 0 · stopped S-1330 at review") {
			t.Errorf("stage %d: the note %q", stage, m.note)
		}
	}
	// No dialog open: the hidden box's result shows.
	m, done := started()
	m, _ = update(t, m, done)
	if m.dialog == nil || m.dialog.stage != stageResult {
		t.Errorf("with no dialog, the result box did not show: %+v", m.dialog)
	}
	// Two overlapping actions: the first one's result does not replace the second one's running box;
	// the second one's result does.
	m, first := started()
	m, _ = press(t, m, text("s"))
	m, cmd := press(t, m, text("y"))
	second := cmd()
	m, _ = update(t, m, first)
	if m.dialog == nil || m.dialog.stage != stageRunning {
		t.Errorf("the first result replaced the second running box: %+v", m.dialog)
	}
	m, _ = update(t, m, second)
	if m.dialog == nil || m.dialog.stage != stageResult {
		t.Errorf("the second result did not replace its own running box: %+v", m.dialog)
	}
	// A tmux window that opened after a newer note leaves the note; one that failed says why.
	m.note = "w needs tmux"
	m, _ = update(t, m, tmuxDoneMsg{})
	if m.note != "w needs tmux" {
		t.Errorf("an opened window cleared the note: %q", m.note)
	}
	m, _ = update(t, m, tmuxDoneMsg{Err: "tmux: no server"})
	if m.note != "tmux: no server" {
		t.Errorf("a failed window: the note %q", m.note)
	}
}

func TestOGAndPOpenThePageAgentAndPullRequest(t *testing.T) {
	cwd, _ := os.Getwd()
	dir := fakeTools(t, true, "", 0)
	m, cmd := press(t, atRow(t, attentionBox, "T-52"), text("o"), text("y"))
	cmd()
	if got := argsOf(t, dir, "tmux"); !slices.Equal(got, []string{"new-window", "-n", "T-52 view", "-c", cwd, "'bl' 'view' 'T-52'; exec ${SHELL:-sh}"}) {
		t.Errorf("o: tmux %q", got)
	}
	m, cmd = press(t, atRow(t, nextBox, "F-84"), text("g"), text("y"))
	cmd()
	if got := argsOf(t, dir, "tmux"); !slices.Equal(got, []string{"new-window", "-n", "agent", "-c", cwd, "'bl' 'agent'; exec ${SHELL:-sh}"}) {
		t.Errorf("g: tmux %q", got)
	}
	for _, c := range []struct{ goos, opener string }{{"linux", "xdg-open"}, {"darwin", "open"}} {
		goos = c.goos
		m, _ = press(t, atRow(t, runsBox, "S-1330"), text("p"))
		if !strings.Contains(dialogText(m), "runs: "+c.opener+" https://example.invalid/roost-cc/bl/pull/15") {
			t.Errorf("p on %s:\n%s", c.goos, dialogText(m))
		}
		m, cmd = press(t, m, text("y"))
		m, _ = update(t, m, cmd())
		if got := argsOf(t, dir, c.opener); !slices.Equal(got, []string{"https://example.invalid/roost-cc/bl/pull/15"}) {
			t.Errorf("p on %s: %s got %q", c.goos, c.opener, got)
		}
		if !strings.Contains(dialogText(m), "exit 0") {
			t.Errorf("p on %s: no result box:\n%s", c.goos, dialogText(m))
		}
	}
	goos = "linux"
	// A run with no pull request has no p.
	if m, _ = press(t, atRow(t, runsBox, "F-81"), text("p")); m.dialog != nil {
		t.Error("p on a run with no pull request asked")
	}
}

func TestOutsideTmuxTheWindowActionsSayNeedsTmux(t *testing.T) {
	dir := fakeTools(t, false, "", 0)
	for _, keys := range [][]tea.KeyPressMsg{{text("r")}, {text("a"), text("o")}, {text("g")}} {
		m, cmd := press(t, atRow(t, runsBox, "F-83"), keys...)
		if m.dialog != nil || cmd != nil {
			t.Errorf("%v outside tmux: dialog %v", keys, m.dialog)
		}
		if out := screen(t, m); !strings.Contains(out, "needs tmux") {
			t.Errorf("%v outside tmux:\n%s", keys, out)
		}
	}
	if argsOf(t, dir, "tmux") != nil {
		t.Error("tmux ran outside tmux")
	}
	// A child verb needs no tmux.
	if m, _ := press(t, atRow(t, runsBox, "S-1330"), text("s")); m.dialog == nil {
		t.Error("s outside tmux did not ask")
	}
}

func TestHelpListsTheActionKeys(t *testing.T) {
	m, _ := press(t, sized(t, 171, 63), text("h"))
	out := screen(t, m)
	for _, want := range []string{"open the action menu of the selected row", "start or resume the selected run", "stop the selected run (bl stop)",
		"open the selected row's page", "open the selected run's pull request", "open bl agent in a tmux window"} {
		if !strings.Contains(out, want) {
			t.Errorf("the help has no %q:\n%s", want, out)
		}
	}
}
