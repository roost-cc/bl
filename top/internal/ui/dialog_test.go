package ui

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
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
			body += fmt.Sprintf("echo 'a first line' >&2\necho '%s' >&2\nexit %d\n", stderr, code)
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

// atRow is the recorded snapshot at 171×63, with row id selected in box num and the focus there.
func atRow(t *testing.T, num int, id string) Model {
	t.Helper()
	m, _ := update(t, sized(t, 171, 63), snapshot(t))
	for m.focus != num {
		m, _ = press(t, m, tab)
	}
	for range 20 {
		if i := m.selected(num); i >= 0 && m.rowIDs(num)[i] == id {
			return m
		}
		m, _ = press(t, m, down)
	}
	t.Fatalf("no row %s in box %d", id, num)
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
	m, _ := press(t, atRow(t, 2, "T-52"), text("a"))
	out = append(out, dialogText(m))
	m, _ = press(t, m, append([]tea.KeyPressMsg{text("d")}, typed("image rebuilt on 44.140, 0 high advisories")...)...)
	out = append(out, dialogText(m))
	m, _ = press(t, atRow(t, 1, "S-1330"), text("s"))
	out = append(out, dialogText(m))
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
		box  int
		id   string
		want []string
	}{
		{1, "F-83", []string{"r  resume the run", "bl run F-83 --resume  (new tmux window)", "o  open the page", "p  open the pull request",
			"xdg-open https://example.invalid/roost-cc/bl/pull/12", "g  talk it through", "bl agent  (new tmux window)"}},
		{2, "F-83:esc", []string{"e  read the escalation", "bl status F-83  (new tmux window)"}},
		{2, "F-81:change", []string{"m  merge it", "bl merge F-81"}},
		{2, "updates:run", []string{"▶ g  talk it through"}},
		{3, "F-84", []string{"▶ o  open the page", "bl view F-84  (new tmux window)"}},
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
	for m.attentionRows()[m.selected(2)].item != nil {
		m, _ = press(t, m, down)
	}
	if m, _ = press(t, m, text("a")); m.dialog != nil || !strings.Contains(screen(t, m), "a: select a row first") {
		t.Errorf("a on the update group:\n%s", screen(t, m))
	}
}

func TestTaskDoneRunsAfterYWithTheNoteAndShowsTheResult(t *testing.T) {
	dir := fakeTools(t, true, "committed tasks/T52-renovate-image (backlog 4f1c2a9)", 0)
	m, _ := press(t, atRow(t, 2, "T-52"), text("a"), down, up, up, enter)
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
	m, _ = press(t, atRow(t, 2, "T-52"), text("a"), text("d"), enter)
	if out := dialogText(m); !strings.Contains(out, "runs: bl task done T-52 ") || strings.Contains(out, "[note]") {
		t.Errorf("an empty note:\n%s", out)
	}
	m, cmd = press(t, m, text("y"))
	if m, _ = update(t, m, cmd()); !slices.Equal(argsOf(t, dir, "bl"), []string{"task", "done", "T-52"}) {
		t.Errorf("an empty note: bl got %q", argsOf(t, dir, "bl"))
	}
	m, _ = press(t, atRow(t, 2, "T-52"), text("a"), text("d"), enter)
	if m, cmd = press(t, m, text("n")); m.dialog != nil || cmd != nil {
		t.Error("n did not cancel")
	}
}

func TestAFailedVerbShowsItsExitCodeAndLastStderrLine(t *testing.T) {
	fakeTools(t, true, "bl merge: F-81 is not ready_for_merge", 1)
	m, _ := press(t, atRow(t, 2, "F-81:change"), text("a"), text("m"))
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
	m := atRow(t, 2, "T-52")
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
		m, _ := press(t, atRow(t, 1, c.id), text("r"))
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
	m, cmd := press(t, atRow(t, 1, "F-81"), text("r"))
	if m.dialog != nil || cmd != nil || !strings.Contains(screen(t, m), "r: F-81 has no such action (a lists its actions)") {
		t.Errorf("r on a live run:\n%s", screen(t, m))
	}
}

func TestSStopsALiveRunAfterMockupCsQuestionAndDoesNotNotify(t *testing.T) {
	dir := fakeTools(t, true, "stopped S-1330 at review; resume: bl run S-1330 --resume", 0)
	m, _ := press(t, atRow(t, 1, "S-1330"), text("s"))
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
	// The next snapshots: S-1330 (stopped here) does not notify; F-81 (stopped elsewhere) does.
	next := *m.snap
	next.Runs.Rows = slices.Clone(next.Runs.Rows)
	for i, r := range next.Runs.Rows {
		if r.ID == "S-1330" || r.ID == "F-81" {
			next.Runs.Rows[i].Status = "stopped"
		}
	}
	if notes := m.differ.Diff(&next); len(notes) != 1 || notes[0].ID != "F-81" {
		t.Errorf("notes after the stop: %v, want F-81's only", notes)
	}
	// A run that is not live has no s.
	m, cmd = press(t, atRow(t, 1, "F-85"), text("s"))
	if m.dialog != nil || cmd != nil {
		t.Error("s on a run that is not live asked")
	}
}

// TestAFailedStopLeavesALaterStopLoud: a stop from this view that failed (it did not start, exited
// 1, or timed out with exit 1), with its result box shown or hidden, does not hide S-1330's later
// `stopped` end, which then comes from another shell. A stop that worked does.
func TestAFailedStopLeavesALaterStopLoud(t *testing.T) {
	for _, c := range []struct {
		what   string
		code   int
		noBl   bool // the command does not start
		hidden bool // esc hides the running box before the result
		notify bool
	}{
		{what: "the command did not start", noBl: true, notify: true},
		{what: "exit 1", code: 1, notify: true},
		{what: "exit 1 after the wait (stop requested)", code: 1, hidden: true, notify: true},
		{what: "exit 0, hidden", code: 0, hidden: true, notify: false},
		{what: "exit 0", code: 0, notify: false},
	} {
		fakeTools(t, true, "stop requested: S-1330 (pid 4242) stops at its next check", c.code)
		m := atRow(t, 1, "S-1330")
		if c.noBl {
			m.blArgv = []string{filepath.Join(t.TempDir(), "no-bl")}
		}
		m, _ = press(t, m, text("s"))
		m, cmd := press(t, m, text("y"))
		if c.hidden {
			m, _ = press(t, m, esc)
		}
		m, _ = update(t, m, cmd())
		next := *m.snap
		next.Runs.Rows = slices.Clone(next.Runs.Rows)
		for i, r := range next.Runs.Rows {
			if r.ID == "S-1330" {
				next.Runs.Rows[i].Status = "stopped"
			}
		}
		notes := m.differ.Diff(&next)
		if got := slices.ContainsFunc(notes, func(n notify.Note) bool { return n.ID == "S-1330" }); got != c.notify {
			t.Errorf("%s: S-1330's stopped end notifies: %v, want %v", c.what, got, c.notify)
		}
	}
}

func TestOGAndPOpenThePageAgentAndPullRequest(t *testing.T) {
	cwd, _ := os.Getwd()
	dir := fakeTools(t, true, "", 0)
	m, cmd := press(t, atRow(t, 2, "T-52"), text("o"), text("y"))
	cmd()
	if got := argsOf(t, dir, "tmux"); !slices.Equal(got, []string{"new-window", "-n", "T-52 view", "-c", cwd, "'bl' 'view' 'T-52'; exec ${SHELL:-sh}"}) {
		t.Errorf("o: tmux %q", got)
	}
	m, cmd = press(t, atRow(t, 3, "F-84"), text("g"), text("y"))
	cmd()
	if got := argsOf(t, dir, "tmux"); !slices.Equal(got, []string{"new-window", "-n", "agent", "-c", cwd, "'bl' 'agent'; exec ${SHELL:-sh}"}) {
		t.Errorf("g: tmux %q", got)
	}
	for _, c := range []struct{ goos, opener string }{{"linux", "xdg-open"}, {"darwin", "open"}} {
		goos = c.goos
		m, _ = press(t, atRow(t, 1, "S-1330"), text("p"))
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
	if m, _ = press(t, atRow(t, 1, "F-81"), text("p")); m.dialog != nil {
		t.Error("p on a run with no pull request asked")
	}
}

func TestOutsideTmuxTheWindowActionsSayNeedsTmux(t *testing.T) {
	dir := fakeTools(t, false, "", 0)
	for _, keys := range [][]tea.KeyPressMsg{{text("r")}, {text("a"), text("o")}, {text("g")}} {
		m, cmd := press(t, atRow(t, 1, "F-83"), keys...)
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
	if m, _ := press(t, atRow(t, 1, "S-1330"), text("s")); m.dialog == nil {
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
