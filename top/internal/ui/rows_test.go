package ui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"

	"github.com/roost-cc/bl/top/internal/stream"
)

// runsMsg is a snapshot whose `runs` section holds a running run of each id.
func runsMsg(ids ...string) stream.SnapshotMsg {
	var rows []stream.Run
	for _, id := range ids {
		rows = append(rows, stream.Run{ID: id, Status: "running"})
	}
	return stream.SnapshotMsg{Gen: 1, Snapshot: stream.Snapshot{Runs: stream.Runs{Rows: rows}}}
}

// surface0 is the background SGR of D5's selected row: surface0 #313244.
const surface0 = "48;2;49;50;68m"

// lineWith is the line of the rendered screen that holds want once its colors are stripped.
func lineWith(t *testing.T, m Model, want string) string {
	t.Helper()
	for _, l := range strings.Split(m.render(), "\n") {
		if strings.Contains(ansi.Strip(l), want) {
			return l
		}
	}
	t.Fatalf("no line holds %q:\n%s", want, ansi.Strip(m.render()))
	return ""
}

func TestSelectionStaysOnItsRowAcrossSnapshots(t *testing.T) {
	m, _ := update(t, sized(t, 171, 63), runsMsg("F-1", "F-2", "F-3"))
	m, _ = press(t, m, down)
	if got := m.sel[1]; got != (selection{"F-2", 1}) {
		t.Fatalf("↓ from the first row: %+v", got)
	}
	// A new run comes first: F-2 moves down one place, and stays selected.
	m, _ = update(t, m, runsMsg("F-9", "F-1", "F-2", "F-3"))
	if got := m.sel[1]; got != (selection{"F-2", 2}) {
		t.Errorf("after F-2 moved down: %+v, want F-2 at 2", got)
	}
	// F-2 leaves: the row at its place is selected.
	m, _ = update(t, m, runsMsg("F-9", "F-1", "F-3"))
	if got := m.sel[1]; got != (selection{"F-3", 2}) {
		t.Errorf("after F-2 left: %+v, want F-3 at 2", got)
	}
	// ↑ and ↓ stop at the first and the last row.
	m, _ = press(t, m, down, down)
	if got := m.sel[1]; got != (selection{"F-3", 2}) {
		t.Errorf("↓ past the last row: %+v", got)
	}
	m, _ = press(t, m, up, up, up, up)
	if got := m.sel[1]; got != (selection{"F-9", 0}) {
		t.Errorf("↑ past the first row: %+v", got)
	}
	// ↓ moves the selection of the box with the focus only.
	m, _ = press(t, m, tab, down)
	if m.sel[1].id != "F-9" {
		t.Errorf("↓ in box ² moved box ¹'s selection: %+v", m.sel[1])
	}
}

func TestSelectedRowHasTheSurface0Background(t *testing.T) {
	m, _ := update(t, sized(t, 171, 63), snapshot(t))
	m, _ = press(t, m, down)
	if l := lineWith(t, m, "S-1330  ● run"); !strings.Contains(l, surface0+"S-1330") {
		t.Errorf("the selected run row has no surface0 background: %q", l)
	}
	if l := lineWith(t, m, "F-81    ● run"); strings.Contains(l, surface0+"F-81") {
		t.Errorf("a row that is not selected has the surface0 background: %q", l)
	}
}

func TestRunsBoxShowsStatesSummaryAndColumns(t *testing.T) {
	m, _ := update(t, sized(t, 171, 63), snapshot(t))
	out := screen(t, m)
	for _, want := range []string{
		"Id      State   Step            Story   Round  Elapsed  Out tok  Agent              Pull request",
		"F-81    ● run   implement       S-1277  -      1h02m    412k     claude opus high   -",
		"S-1330  ● run   review          -       1/2    38m      109k     codex gpt-6-sol    bl#15",
		"F-85    ✓ done  merged          -       2/2    5h14m    257k     claude opus        bl#14",
		"F-83    ✗ esc   closing-review  -       2/2    2h05m    151k     codex gpt-6-sol    bl#12",
		// A step longer than its column is cut with …; a stale run's time runs to the snapshot.
		"F-79    ◌ stale a step name lo… S-1201  -      3h00m    950      claude sonnet low  -",
		"2 running · 0 stopped · 1 stale · done today (UTC): 1 stories, 10 points",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("box ¹ has no %q:\n%s", want, out)
		}
	}
	// Mockup B's narrow box ¹ has no Agent column.
	m, _ = update(t, sized(t, 100, 40), snapshot(t))
	if out := screen(t, m); strings.Contains(out, "Agent") || !strings.Contains(out, "S-1330  ● run   review          -       1/2    38m      109k     bl#15") {
		t.Errorf("box ¹ at 100x40:\n%s", out)
	}
}

func TestRunStatesHaveD5Glyphs(t *testing.T) {
	for _, c := range []struct {
		status, glyph, color string
		dim                  bool
	}{
		{"running", "● run", sgr(colorGreen), false},
		{"stale", "◌ stale", sgr(colorPeach), false},
		{"stopped", "■ stop", sgr(colorPeach), false},
		{"escalated", "✗ esc", sgr(colorRed), false},
		{"failed", "✗ fail", sgr(colorRed), false},
		{"clean", "✓ done", sgr(colorGreen), true},
		{"no-change", "✓ done", sgr(colorGreen), true},
		{"reviewed", "✓ done", sgr(colorGreen), true},
		// A run state with a missing or mistyped status: unknown, not done.
		{"", "? unk", sgr(colorPeach), false},
	} {
		glyph, style, dim := runState(c.status)
		if glyph != c.glyph || dim != c.dim || !strings.Contains(style.Render("x"), c.color) {
			t.Errorf("runState(%s) = %q dim %v %q", c.status, glyph, dim, style.Render("x"))
		}
	}
	// A done row is dim: its id is overlay1.
	m, _ := update(t, sized(t, 171, 63), snapshot(t))
	if l := lineWith(t, m, "F-85    ✓ done"); !strings.Contains(l, sgr(colorOverlay1)+"F-85") {
		t.Errorf("the done row is not dim: %q", l)
	}
}

func TestAttentionBoxShowsKindsAndTheSelectedItemsNext(t *testing.T) {
	m, _ := update(t, sized(t, 171, 63), snapshot(t))
	m, _ = press(t, m, tab, down, down, down, down, down)
	out := screen(t, m)
	for _, want := range []string{
		"Kind  Id            For     Line",
		"RUN   updates:run   updates no update run since 14:02 (9 h)",
		"ESC   F-83:esc      F-83    round cap: 2 open review items",
		"TASK  T-52          F-81    Renovate image: 8 advisories",
		"CHG   S-1330:change S-1330  bl · 3 commits · not merged",
		"UPD   tools:renova… tools   eslint 9.39.1 · red · notes: none",
		"next: bl run S-1330",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("box ² has no %q:\n%s", want, out)
		}
	}
	for tag, color := range map[string]string{"RUN": sgr(colorTeal), "ESC": sgr(colorRed), "TASK": sgr(colorYellow), "CHG": sgr(colorBlue), "UPD": sgr(colorPeach)} {
		if l := lineWith(t, m, tag+" "); !strings.Contains(l, color+tag) {
			t.Errorf("%s is not %s: %q", tag, color, l)
		}
	}
}

func TestStackedAttentionFoldsTheUpdatesAndEnterOpensThem(t *testing.T) {
	m, _ := update(t, sized(t, 100, 40), snapshot(t))
	out := screen(t, m)
	if !strings.Contains(out, "UPD   3 red updates") || strings.Contains(out, "tools:renova") {
		t.Fatalf("the updates are not one row:\n%s", out)
	}
	// ↵ on another row does nothing.
	m, _ = press(t, m, tab, enter)
	if m.updatesOpen {
		t.Fatal("↵ on the runner row opened the group")
	}
	m, _ = press(t, m, down, down, down, down, down, down)
	if !strings.Contains(screen(t, m), "next: ↵ shows the updates") {
		t.Errorf("the group row's next line:\n%s", screen(t, m))
	}
	m, _ = press(t, m, enter)
	out = screen(t, m)
	if !m.updatesOpen || !strings.Contains(out, "↵ close") {
		t.Fatalf("↵ did not open the group:\n%s", out)
	}
	// The group row stays selected, and ↓ goes into it: the box scrolls to show the update.
	m, _ = press(t, m, down)
	if m.sel[2].id != "tools:renovate/eslint-9.x" || !strings.Contains(screen(t, m), "UPD   tools:renova") {
		t.Errorf("↓ from the open group: %+v\n%s", m.sel[2], screen(t, m))
	}
	m, _ = press(t, m, up, enter)
	if m.updatesOpen || strings.Contains(screen(t, m), "tools:renova") {
		t.Error("↵ did not close the group")
	}
	// The full layout lists each update.
	m, _ = update(t, sized(t, 171, 63), snapshot(t))
	if strings.Contains(screen(t, m), "red updates") {
		t.Error("the full layout folds the updates")
	}
}

func TestNextBoxShowsRankedUnitsAndThePick(t *testing.T) {
	m, _ := update(t, sized(t, 171, 63), snapshot(t))
	out := screen(t, m)
	for _, want := range []string{
		"Rank  Id     Status    Pts  Held by  Title",
		// The title is cut with … at the box's edge.
		"  3   F-81   running    21           Every repo's pre-push gate runs the tests that prove a change, an…│",
		"  4   F-84   approved    8  F-81     Every repo's gate passes in a throwaway worktree on the guest",
		"  6   F-86   draft       -           AGENTS.md in plain English",
		"bl next → F-81 (running) · 185 work units not ranked",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("box ³ has no %q:\n%s", want, out)
		}
	}
	// The narrow box cuts it shorter.
	m, _ = update(t, sized(t, 100, 40), snapshot(t))
	if !strings.Contains(screen(t, m), "Every repo's pre-push gate runs the tests that prove a chan…│") {
		t.Errorf("the long title is not cut:\n%s", screen(t, m))
	}
	n := stream.Next{Pick: &stream.Pick{ID: "S-11", Status: "backlog", From: "F-3"}}
	if got := pickLine(n); got != "bl next → S-11 (backlog) · it unblocks F-3" {
		t.Errorf("pickLine = %q", got)
	}
	if got := pickLine(stream.Next{}); got != "bl next → nothing can run" {
		t.Errorf("pickLine with no pick = %q", got)
	}
}
