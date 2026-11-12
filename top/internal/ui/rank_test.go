package ui

import (
	"slices"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/roost-cc/bl/top/internal/stream"
)

// The recorded snapshot's box ³: F-81, F-84, F-80, F-86, F-16 and F-13 are ranked; S-1400 and F-99
// are not.

// conflictText is F-113 Decision A3's message.
const conflictText = "merge conflict in .bl/priority.staged.yaml: edit it, then bl rank --commit; or bl rank --reset"

// staged gives m's snapshot the box's own actions, as the snapshot sends them while a staged copy
// exists (F-113 D7).
func staged(m Model) Model {
	m.snap.Next.Actions = []stream.Action{
		{Key: "C", Label: "commit the staged order", Argv: []string{"bl", "rank", "--commit"}},
		{Key: "R", Label: "drop the staged edits", Argv: []string{"bl", "rank", "--reset"}},
	}
	return m
}

// selectIn selects row id of box ³, which has the focus.
func selectIn(t *testing.T, m Model, id string) Model {
	t.Helper()
	for range 20 {
		m, _ = press(t, m, up)
	}
	for range 20 {
		if m.selectedUnit(3) == id {
			return m
		}
		m, _ = press(t, m, down)
	}
	t.Fatalf("no row %s in box ³", id)
	return m
}

// answer presses y on the open question and returns the model after the child's end.
func answer(t *testing.T, m Model) Model {
	t.Helper()
	m, cmd := press(t, m, text("y"))
	if cmd == nil {
		t.Fatalf("y: no command:\n%s", dialogText(m))
	}
	m, _ = update(t, m, cmd())
	return m
}

func TestYankThenPutRunsTheRenderedRankCommandAfterYN(t *testing.T) {
	for _, c := range []struct{ key, where string }{{"p", "--after"}, {"P", "--before"}} {
		dir := fakeTools(t, true, "staged: S-1400 "+c.where+" F-84", 0)
		m, _ := press(t, atRow(t, 3, "S-1400"), text("y"))
		if m.yanked != "S-1400" {
			t.Fatalf("y on S-1400: yanked %q", m.yanked)
		}
		m, _ = press(t, selectIn(t, m, "F-84"), text(c.key))
		if m.dialog == nil || m.dialog.stage != stageAsk || !strings.Contains(dialogText(m), "runs: bl rank S-1400 "+c.where+" F-84") {
			t.Fatalf("%s on F-84 did not ask for the rendered command: %+v", c.key, m.dialog)
		}
		// n keeps the yank.
		if m, _ = press(t, m, text("n")); m.dialog != nil || m.yanked != "S-1400" {
			t.Fatalf("n: dialog %v, yanked %q", m.dialog, m.yanked)
		}
		m, _ = press(t, m, text(c.key))
		m = answer(t, m)
		if got := argsOf(t, dir, "bl"); !slices.Equal(got, []string{"rank", "S-1400", c.where, "F-84"}) {
			t.Errorf("%s: bl got %q", c.key, got)
		}
		if out := dialogText(m); !strings.Contains(out, "exit 0") || !strings.Contains(out, "stderr: staged: S-1400") {
			t.Errorf("%s: the result box:\n%s", c.key, out)
		}
		if m.yanked != "" {
			t.Errorf("%s: the put left the yank %q", c.key, m.yanked)
		}
	}
}

func TestXUnranksTheSelectedRankedRow(t *testing.T) {
	dir := fakeTools(t, true, "", 0)
	m, _ := press(t, atRow(t, 3, "F-80"), text("x"))
	if !strings.Contains(dialogText(m), "runs: bl rank F-80 --remove") {
		t.Fatalf("x on F-80:\n%s", dialogText(m))
	}
	answer(t, m)
	if got := argsOf(t, dir, "bl"); !slices.Equal(got, []string{"rank", "F-80", "--remove"}) {
		t.Errorf("bl got %q", got)
	}
}

func TestAPutWithNothingYankedRefuses(t *testing.T) {
	dir := fakeTools(t, true, "", 0)
	for _, k := range []string{"p", "P"} {
		m, cmd := press(t, atRow(t, 3, "F-84"), text(k))
		if m.dialog != nil || cmd != nil || m.note != yankFirst || !strings.Contains(screen(t, m), yankFirst) {
			t.Errorf("%s with nothing yanked: dialog %v, note %q", k, m.dialog, m.note)
		}
	}
	if argsOf(t, dir, "bl") != nil {
		t.Error("bl ran")
	}
}

func TestRankKeysOnAnUnrankedRowDoNothing(t *testing.T) {
	m, _ := press(t, atRow(t, 3, "F-84"), text("y"))
	m = selectIn(t, m, "F-99")
	for _, k := range []string{"p", "P", "x"} {
		got, cmd := press(t, m, text(k))
		if got.dialog != nil || cmd != nil || got.note != "" {
			t.Errorf("%s on an unranked row: dialog %v, note %q", k, got.dialog, got.note)
		}
	}
}

func TestEscCancelsTheYankAndBoxThreeMarksIt(t *testing.T) {
	m, _ := press(t, atRow(t, 3, "F-84"), text("y"))
	// The yanked row has a peach ↕ after its rank; the others none.
	if l := lineWith(t, m, "↕ F-84"); !strings.Contains(ansi.Strip(l), "  4 ↕ F-84") || !strings.Contains(l, strings.TrimSuffix(sgr(colorPeach), "m")) {
		t.Errorf("the yanked row: %q", l)
	}
	if l := ansi.Strip(lineWith(t, m, "  5   F-80")); strings.Contains(l, "↕") {
		t.Errorf("a row not yanked: %q", l)
	}
	if m, _ = press(t, m, esc); m.yanked != "" || strings.Contains(ansi.Strip(m.render()), "↕") {
		t.Errorf("esc: yanked %q", m.yanked)
	}
	// y on another row moves the yank.
	m, _ = press(t, m, text("y"), down, text("y"))
	if m.yanked != "F-80" {
		t.Errorf("a second y: yanked %q", m.yanked)
	}
}

func TestCAndRRunCommitAndResetAfterYN(t *testing.T) {
	const noTerminal = "conflict: run bl rank --commit in a terminal"
	dir := fakeTools(t, true, noTerminal, 1)
	m, _ := press(t, staged(atRow(t, 3, "F-84")), text("C"))
	if out := dialogText(m); !strings.Contains(out, "runs: bl rank --commit") || strings.Contains(out, "F-84 · approved") {
		t.Fatalf("C: the question is about the box, not the row:\n%s", out)
	}
	m = answer(t, m)
	if got := argsOf(t, dir, "bl"); !slices.Equal(got, []string{"rank", "--commit"}) {
		t.Errorf("C: bl got %q", got)
	}
	if out := dialogText(m); !strings.Contains(out, "exit 1") || !strings.Contains(out, "stderr: "+noTerminal) {
		t.Errorf("C on a conflict: the result box:\n%s", out)
	}
	dir = fakeTools(t, true, "", 0)
	m, _ = press(t, staged(atRow(t, 3, "S-1400")), text("R"))
	answer(t, m)
	if got := argsOf(t, dir, "bl"); !slices.Equal(got, []string{"rank", "--reset"}) {
		t.Errorf("R: bl got %q", got)
	}
	// No staged copy: no C and R.
	for _, k := range []string{"C", "R"} {
		if m, cmd := press(t, atRow(t, 3, "F-84"), text(k)); m.dialog != nil || cmd != nil {
			t.Errorf("%s with no staged copy asked", k)
		}
	}
}

func TestAConflictRefusesEveryRankingKeyButR(t *testing.T) {
	fakeTools(t, true, "", 0)
	m := staged(atRow(t, 3, "F-84"))
	m.yanked = "S-1400"
	m.snap.Next.Conflict = conflictText
	for _, k := range []tea.KeyPressMsg{text("y"), text("p"), text("P"), text("x"), esc, text("C")} {
		got, cmd := press(t, m, k)
		if got.dialog != nil || cmd != nil || got.note != conflictText || got.yanked != "S-1400" {
			t.Errorf("%s in conflict: dialog %v, note %q, yanked %q", k, got.dialog, got.note, got.yanked)
		}
	}
	if m, _ = press(t, m, text("R")); !strings.Contains(dialogText(m), "runs: bl rank --reset") {
		t.Errorf("R in conflict:\n%s", dialogText(m))
	}
}

func TestOtherBoxesKeepTheirKeys(t *testing.T) {
	fakeTools(t, true, "", 0)
	// In ¹, p opens the pull request (F-88); y, x, C and R are no keys there.
	m := staged(atRow(t, 1, "S-1330"))
	if got, _ := press(t, m, text("p")); !strings.Contains(dialogText(got), "runs: xdg-open https://example.invalid/roost-cc/bl/pull/15") {
		t.Errorf("p in ¹:\n%s", dialogText(got))
	}
	for _, k := range []string{"y", "x", "C", "R"} {
		if got, cmd := press(t, m, text(k)); got.dialog != nil || cmd != nil || got.yanked != "" {
			t.Errorf("%s in ¹: dialog %v, yanked %q", k, got.dialog, got.yanked)
		}
	}
	// In ¹, r starts the run, as before.
	if got, _ := press(t, atRow(t, 1, "F-85"), text("r")); got.dialog == nil || !strings.Contains(dialogText(got), "runs: bl run F-85") {
		t.Errorf("r in ¹: %+v", got.dialog)
	}
}

func TestHelpListsEachBoxsKeysUnderThatBox(t *testing.T) {
	// The headings follow the help's border, not a box's.
	order := []string{"open the selected run's pull request", "read capacity now", "│  ³next", "yank the selected unit",
		"put the yanked unit after the selected ranked unit", "put the yanked unit before the selected ranked unit",
		"unrank the selected ranked unit", "cancel the yank", "commit the staged edits (bl rank --commit)",
		"drop the staged edits (bl rank --reset)", "show the unranked units newest or oldest first", "│  ⁶detail",
		"follow the feed of ⁶ on or off", "any key closes this help"}
	// One column where it fits.
	m, _ := press(t, sized(t, 171, 63), text("h"))
	out := screen(t, m)
	at := -1
	for _, want := range order {
		i := strings.Index(out, want)
		if i < at {
			t.Errorf("the help has no %q after the key before it:\n%s", want, out)
		}
		at = i
	}
	// Where one column does not fit, the boxes' keys go beside the others: each heading on the line
	// of a key of every box.
	m, _ = press(t, sized(t, 171, 24), text("h"))
	out = screen(t, m)
	for _, want := range order {
		if !strings.Contains(out, strings.TrimPrefix(want, "│  ")) {
			t.Errorf("two columns: the help has no %q:\n%s", want, out)
		}
	}
	for key, heading := range map[string]string{"hide or show a box": "³next", "open bl agent in a tmux window": "⁶detail"} {
		if l := ansi.Strip(lineWith(t, m, key)); !strings.Contains(l, heading) {
			t.Errorf("two columns: %q is not beside %q: %q", heading, key, l)
		}
	}
}
