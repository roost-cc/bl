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

	"github.com/roost-cc/bl/top/internal/notify"
	"github.com/roost-cc/bl/top/internal/stream"
)

// fakeTools puts a fake bl, tmux, xdg-open and open first on PATH, and sets $TMUX for getenv when
// inTmux is true. Each writes its arguments, one per line, to <name>.args in the directory it
// returns, and adds them as one line to <name>.log, so a test reads the order of its runs; bl then
// writes stderr on stderr and exits with code.
func fakeTools(t *testing.T, inTmux bool, stderr string, code int) string {
	t.Helper()
	dir := t.TempDir()
	for _, name := range []string{"bl", "tmux", "xdg-open", "open"} {
		body := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' \"$@\" > %s\necho \"$*\" >> %s\n",
			filepath.Join(dir, name+".args"), filepath.Join(dir, name+".log"))
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

// logOf are the runs of the fake name of fakeTools, one line of arguments per run, in the order
// they ran; nil when it did not run.
func logOf(t *testing.T, dir, name string) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, name+".log"))
	if err != nil {
		return nil
	}
	return strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
}

// settle runs cmd, the command of the job that runs, and the command of each job that the end
// before it started, until the queue is empty. It returns the model after the last end.
func settle(t *testing.T, m Model, cmd tea.Cmd) Model {
	t.Helper()
	for cmd != nil {
		m, cmd = update(t, m, cmd())
	}
	return m
}

// noteLine is the screen's bottom border, which holds the note line.
func noteLine(t *testing.T, m Model) string {
	t.Helper()
	lines := strings.Split(screen(t, m), "\n")
	return lines[len(lines)-1]
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

// TestActionDialogsGolden draws the only two action dialogs (F-127 Decision 2): the menu of T-52,
// and the note box of its task done.
func TestActionDialogsGolden(t *testing.T) {
	fakeTools(t, true, "", 0)
	var out []string
	m, _ := press(t, atRow(t, attentionBox, "T-52"), text("a"))
	out = append(out, dialogText(m))
	m, _ = press(t, m, append([]tea.KeyPressMsg{text("d")}, typed("image rebuilt on 44.140, 0 high advisories")...)...)
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

func TestTaskDoneTakesItsNoteThenRunsAtOnce(t *testing.T) {
	dir := fakeTools(t, true, "committed tasks/T52-renovate-image (backlog 4f1c2a9)", 0)
	m, _ := press(t, atRow(t, attentionBox, "T-52"), text("a"), down, up, up, enter)
	if m.dialog == nil || m.dialog.stage != stageInput {
		t.Fatal("↵ on close the task did not ask for its note")
	}
	m, _ = press(t, m, typed("image rebuilt!")...)
	m, _ = press(t, m, backspace)
	if out := dialogText(m); !strings.Contains(out, `runs: bl task done T-52 'image rebuilt'`) || !strings.Contains(out, "enter  run     esc  cancel") {
		t.Fatalf("the note box:\n%s", out)
	}
	// enter runs it at once: no question, no running box; the note line shows the command.
	m, cmd := press(t, m, enter)
	if cmd == nil || m.dialog != nil || !strings.Contains(noteLine(t, m), `┐bl task done T-52 'image rebuilt'┌`) {
		t.Fatalf("enter: dialog %+v, the note line %q", m.dialog, noteLine(t, m))
	}
	m = settle(t, m, cmd)
	if got := argsOf(t, dir, "bl"); !slices.Equal(got, []string{"task", "done", "T-52", "image rebuilt"}) {
		t.Errorf("bl got %q", got)
	}
	// On success the note line clears, and no result box opens.
	if m.dialog != nil || m.note != "" || strings.Contains(noteLine(t, m), "bl task done") {
		t.Errorf("after the end: dialog %+v, the note line %q", m.dialog, noteLine(t, m))
	}
	// An empty note runs the verb without one.
	m, _ = press(t, atRow(t, attentionBox, "T-52"), text("a"), text("d"))
	if out := dialogText(m); !strings.Contains(out, "runs: bl task done T-52 ") || strings.Contains(out, "[note]") {
		t.Errorf("an empty note:\n%s", out)
	}
	m, cmd = press(t, m, enter)
	if settle(t, m, cmd); !slices.Equal(argsOf(t, dir, "bl"), []string{"task", "done", "T-52"}) {
		t.Errorf("an empty note: bl got %q", argsOf(t, dir, "bl"))
	}
	// esc cancels the note box: nothing runs.
	m, _ = press(t, atRow(t, attentionBox, "T-52"), text("a"), text("d"))
	if m, cmd = press(t, m, esc); m.dialog != nil || cmd != nil || len(m.jobs) != 0 {
		t.Error("esc did not cancel")
	}
	if got := logOf(t, dir, "bl"); len(got) != 2 {
		t.Errorf("bl ran %q, want the two task done runs", got)
	}
}

func TestAFailedVerbShowsItsExitCodeAndLastStderrLineOnTheNoteLine(t *testing.T) {
	fakeTools(t, true, "bl merge: F-81 is not ready_for_merge", 1)
	m, cmd := press(t, atRow(t, attentionBox, "F-81:change"), text("a"), text("m"))
	// While it runs, the note line shows the command in the text color.
	if cmd == nil || m.dialog != nil || !strings.Contains(m.render(), styleText.Render("bl merge F-81")) {
		t.Fatalf("m: dialog %+v, the note line %q", m.dialog, noteLine(t, m))
	}
	m = settle(t, m, cmd)
	const want = "exit 1: bl merge F-81: bl merge: F-81 is not ready_for_merge"
	if m.dialog != nil || !strings.Contains(noteLine(t, m), "┐"+want+"┌") || !strings.Contains(m.render(), styleError.Render(want)) {
		t.Errorf("the failure: dialog %+v, the note line %q, want %q in red", m.dialog, noteLine(t, m), want)
	}
	// It stays until the next key.
	if m, _ = press(t, m, down); strings.Contains(noteLine(t, m), "bl merge") {
		t.Errorf("the next key left the failure: %q", noteLine(t, m))
	}
}

func TestAReasonIsNeeded(t *testing.T) {
	dir := fakeTools(t, true, "", 0)
	m := atRow(t, attentionBox, "T-52")
	m.snap.Attention.Items[2].Actions = []stream.Action{{Key: "x", Label: "drop it", Argv: []string{"bl", "task", "drop", "T-52"}, Input: "reason"}}
	m, cmd := press(t, m, text("a"), text("x"), enter)
	if cmd != nil || m.dialog.stage != stageInput || !strings.Contains(dialogText(m), "a reason is needed") {
		t.Fatalf("an empty reason was taken:\n%s", dialogText(m))
	}
	m, _ = press(t, m, typed(" ")...)
	if m, cmd = press(t, m, enter); cmd != nil || m.dialog.stage != stageInput {
		t.Fatal("a blank reason was taken")
	}
	m, _ = press(t, m, typed("dup")...)
	m, cmd = press(t, m, enter)
	if m.dialog != nil || cmd == nil || !strings.Contains(noteLine(t, m), "bl task drop T-52 dup") {
		t.Fatalf("the reason: dialog %+v, the note line %q", m.dialog, noteLine(t, m))
	}
	if settle(t, m, cmd); !slices.Equal(argsOf(t, dir, "bl"), []string{"task", "drop", "T-52", "dup"}) {
		t.Errorf("bl got %q", argsOf(t, dir, "bl"))
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
		m, cmd := press(t, atRow(t, runsBox, c.id), text("r"))
		if m.dialog != nil || cmd == nil || !strings.Contains(noteLine(t, m), "(new tmux window)") {
			t.Fatalf("r on %s: dialog %+v, the note line %q", c.id, m.dialog, noteLine(t, m))
		}
		if msg := cmd(); msg != (jobDoneMsg{}) {
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
	// A live run has no r: the key does nothing, and the key bar does not show it.
	fakeTools(t, true, "", 0)
	m, cmd := press(t, atRow(t, runsBox, "F-81"), text("r"))
	if m.dialog != nil || cmd != nil || m.note != "" || strings.Contains(noteLine(t, m), "r run") {
		t.Errorf("r on a live run:\n%s", screen(t, m))
	}
}

func TestSStopsALiveRunAtOnceAndDoesNotNotify(t *testing.T) {
	dir := fakeTools(t, true, "stopped S-1330 at review; resume: bl run S-1330 --resume", 0)
	m, cmd := press(t, atRow(t, runsBox, "S-1330"), text("s"))
	if m.dialog != nil || cmd == nil || !strings.Contains(noteLine(t, m), "┐bl stop S-1330┌") {
		t.Fatalf("s: dialog %+v, the note line %q", m.dialog, noteLine(t, m))
	}
	m = settle(t, m, cmd)
	if got := argsOf(t, dir, "bl"); !slices.Equal(got, []string{"stop", "S-1330"}) {
		t.Errorf("bl got %q", got)
	}
	if m.dialog != nil || m.note != "" {
		t.Errorf("after the stop: dialog %+v, note %q", m.dialog, m.note)
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
// exited 1 after its wait, or exited 0), S-1330's `stopped` end is quiet only when that bl stop is
// one of the stops that stopped it. An end by another shell's stop, or by no named stop, notifies.
func TestAFailedStopLeavesALaterStopLoud(t *testing.T) {
	type by int
	const (
		own by = iota
		other
		none
	)
	for _, c := range []struct {
		what string
		code int
		noBl bool // the command does not start
	}{
		{what: "the command did not start", noBl: true},
		{what: "exit 1 after the wait (stop requested)", code: 1},
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
			m, cmd := press(t, m, text("s"))
			m = settle(t, m, cmd)
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
	m, cmd := press(t, atRow(t, runsBox, "S-1330"), text("s"))
	stopped := ended(m, map[string][]int{"S-1330": {external}})
	first := m.differ.Diff(stopped)
	m = settle(t, m, cmd)
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
	m, cmd := press(t, atRow(t, runsBox, "S-1330"), text("s"))
	m = settle(t, m, cmd)
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

// TestAStopQueuedBehindAFailedStopIsDropped: two stops of S-1330 from this view; the second waits
// in the queue, and the first fails. The second never runs, so it marks nothing: an end by the
// failed stop (its request was read) is quiet, and an end by another shell's stop notifies.
func TestAStopQueuedBehindAFailedStopIsDropped(t *testing.T) {
	for _, c := range []struct {
		what   string
		by     func(failed int) []int
		notify bool
	}{
		{"by the stop that failed (its request was read)", func(failed int) []int { return []int{failed} }, false},
		{"by another shell's stop", func(int) []int { return []int{external} }, true},
	} {
		dir := fakeTools(t, true, "bl stop: S-1330 did not stop in 30 s", 1)
		m, first := press(t, atRow(t, runsBox, "S-1330"), text("s"))
		m, second := press(t, m, text("s"))
		if first == nil || second != nil || len(m.jobs) != 2 {
			t.Fatalf("two stops: the second started at once, or did not wait: %d jobs", len(m.jobs))
		}
		m = settle(t, m, first)
		if got := logOf(t, dir, "bl"); !slices.Equal(got, []string{"stop S-1330"}) {
			t.Errorf("bl ran %q, want the first stop only", got)
		}
		if want := "exit 1, dropped 1 queued action: bl stop S-1330: bl stop: S-1330 did not stop in 30 s"; m.note != want || len(m.jobs) != 0 {
			t.Errorf("the note %q, want %q; %d jobs", m.note, want, len(m.jobs))
		}
		notes := m.differ.Diff(ended(m, map[string][]int{"S-1330": c.by(blPids(t, dir)[0])}))
		if got := notifies(notes, "S-1330"); got != c.notify {
			t.Errorf("%s: notifies %v, want %v", c.what, got, c.notify)
		}
	}
}

func TestOGAndPOpenThePageAgentAndPullRequest(t *testing.T) {
	cwd, _ := os.Getwd()
	dir := fakeTools(t, true, "", 0)
	m, cmd := press(t, atRow(t, attentionBox, "T-52"), text("o"))
	settle(t, m, cmd)
	if got := argsOf(t, dir, "tmux"); !slices.Equal(got, []string{"new-window", "-n", "T-52 view", "-c", cwd, "'bl' 'view' 'T-52'; exec ${SHELL:-sh}"}) {
		t.Errorf("o: tmux %q", got)
	}
	m, cmd = press(t, atRow(t, nextBox, "F-84"), text("g"))
	settle(t, m, cmd)
	if got := argsOf(t, dir, "tmux"); !slices.Equal(got, []string{"new-window", "-n", "agent", "-c", cwd, "'bl' 'agent'; exec ${SHELL:-sh}"}) {
		t.Errorf("g: tmux %q", got)
	}
	for _, c := range []struct{ goos, opener string }{{"linux", "xdg-open"}, {"darwin", "open"}} {
		goos = c.goos
		m, cmd = press(t, atRow(t, runsBox, "S-1330"), text("p"))
		if !strings.Contains(noteLine(t, m), "┐"+c.opener+" https://example.invalid/roost-cc/bl/pull/15┌") {
			t.Errorf("p on %s: the note line %q", c.goos, noteLine(t, m))
		}
		m = settle(t, m, cmd)
		if got := argsOf(t, dir, c.opener); !slices.Equal(got, []string{"https://example.invalid/roost-cc/bl/pull/15"}) {
			t.Errorf("p on %s: %s got %q", c.goos, c.opener, got)
		}
		if m.dialog != nil || m.note != "" {
			t.Errorf("p on %s: dialog %+v, note %q", c.goos, m.dialog, m.note)
		}
	}
	goos = "linux"
	// A run with no pull request has no p.
	if m, cmd = press(t, atRow(t, runsBox, "F-81"), text("p")); m.dialog != nil || cmd != nil {
		t.Error("p on a run with no pull request ran")
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
	m, cmd := press(t, atRow(t, runsBox, "S-1330"), text("s"))
	if cmd == nil {
		t.Fatal("s outside tmux did not run")
	}
	if settle(t, m, cmd); !slices.Equal(argsOf(t, dir, "bl"), []string{"stop", "S-1330"}) {
		t.Errorf("s outside tmux: bl got %q", argsOf(t, dir, "bl"))
	}
}

// TestHelpListsTheActionKeys: the help names the row action keys in one line, not as global keys
// (F-127 Decision 5).
func TestHelpListsTheActionKeys(t *testing.T) {
	m, _ := press(t, sized(t, 171, 63), text("h"))
	out := screen(t, m)
	for _, want := range []string{"open the action menu of the selected row", "the selected row's actions; a lists them"} {
		if !strings.Contains(out, want) {
			t.Errorf("the help has no %q:\n%s", want, out)
		}
	}
	for _, gone := range []string{"stop the selected run (bl stop)", "open the selected run's pull request"} {
		if strings.Contains(out, gone) {
			t.Errorf("the help lists %q as a global key:\n%s", gone, out)
		}
	}
}

// TestAnyKeyOfTheSelectedRowsActionsPicksIt: e, d and m on attention items pick their actions,
// though no global key or box key has them (F-127, "Three kinds of keys").
func TestAnyKeyOfTheSelectedRowsActionsPicksIt(t *testing.T) {
	fakeTools(t, true, "", 0)
	m, cmd := press(t, atRow(t, attentionBox, "F-83:esc"), text("e"))
	if len(m.jobs) != 1 || m.jobs[0].show != "bl status F-83  (new tmux window)" {
		t.Errorf("e on an escalation: %+v", m.jobs)
	}
	settle(t, m, cmd)
	m, cmd = press(t, atRow(t, attentionBox, "F-81:change"), text("m"))
	if len(m.jobs) != 1 || m.jobs[0].show != "bl merge F-81" {
		t.Errorf("m on a change: %+v", m.jobs)
	}
	settle(t, m, cmd)
	if m, _ = press(t, atRow(t, attentionBox, "T-52"), text("d")); m.dialog == nil || m.dialog.stage != stageInput {
		t.Errorf("d on a task did not open its note box: %+v", m.dialog)
	}
}
