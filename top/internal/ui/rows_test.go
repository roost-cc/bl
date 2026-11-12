package ui

import (
	"fmt"
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
	if got := m.sel[runsBox]; got != (selection{"F-2", 1}) {
		t.Fatalf("↓ from the first row: %+v", got)
	}
	// A new run comes first: F-2 moves down one place, and stays selected.
	m, _ = update(t, m, runsMsg("F-9", "F-1", "F-2", "F-3"))
	if got := m.sel[runsBox]; got != (selection{"F-2", 2}) {
		t.Errorf("after F-2 moved down: %+v, want F-2 at 2", got)
	}
	// F-2 leaves: the row at its place is selected.
	m, _ = update(t, m, runsMsg("F-9", "F-1", "F-3"))
	if got := m.sel[runsBox]; got != (selection{"F-3", 2}) {
		t.Errorf("after F-2 left: %+v, want F-3 at 2", got)
	}
	// ↑ and ↓ stop at the first and the last row.
	m, _ = press(t, m, down, down)
	if got := m.sel[runsBox]; got != (selection{"F-3", 2}) {
		t.Errorf("↓ past the last row: %+v", got)
	}
	m, _ = press(t, m, up, up, up, up)
	if got := m.sel[runsBox]; got != (selection{"F-9", 0}) {
		t.Errorf("↑ past the first row: %+v", got)
	}
	// ↓ moves the selection of the box with the focus only.
	m, _ = press(t, m, tab, down)
	if m.sel[runsBox].id != "F-9" {
		t.Errorf("↓ in the attention box moved the runs box's selection: %+v", m.sel[runsBox])
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
			t.Errorf("the runs box has no %q:\n%s", want, out)
		}
	}
	// Mockup B's narrow runs box has no Agent column.
	m, _ = update(t, sized(t, 100, 40), snapshot(t))
	if out := screen(t, m); strings.Contains(out, "Agent") || !strings.Contains(out, "S-1330  ● run   review          -       1/2    38m      109k     bl#15") {
		t.Errorf("the runs box at 100x40:\n%s", out)
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
			t.Errorf("the attention box has no %q:\n%s", want, out)
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
	// Without the detail box, the attention box has room for every row.
	m, _ = press(t, m, numberKey(m, detailBox))
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
	if m.sel[attentionBox].id != "tools:renovate/eslint-9.x" || !strings.Contains(screen(t, m), "UPD   tools:renova") {
		t.Errorf("↓ from the open group: %+v\n%s", m.sel[attentionBox], screen(t, m))
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
		"  8   F-13   draft       -           Maintenance requests",
		"── not ranked · oldest first ───",
		"      S-1400 backlog     2           Loose story, the oldest",
		"      F-99   draft       -           Feature, the newest",
		"bl next → F-81 (running)",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("the next box has no %q:\n%s", want, out)
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

// units are open units with these ids, ranked 1, 2, 3 when ranked is true, else unranked.
func units(ranked bool, ids ...string) []stream.Unit {
	var out []stream.Unit
	for i, id := range ids {
		u := stream.Unit{ID: id, Status: "draft", Title: "title of " + id}
		if ranked {
			u.Position = i + 1
		}
		out = append(out, u)
	}
	return out
}

// withNext is the recorded snapshot with its `next` section's orders and conflict replaced.
func withNext(t *testing.T, committed stream.Order, staged *stream.Order, conflict string) stream.SnapshotMsg {
	t.Helper()
	msg := snapshot(t)
	msg.Snapshot.Next.Order, msg.Snapshot.Next.Staged, msg.Snapshot.Next.Conflict = committed, staged, conflict
	return msg
}

func TestNextBoxScrollsPastItsHeightAndSkipsTheDivider(t *testing.T) {
	var ranked, unranked []string
	for i := range 12 {
		ranked = append(ranked, fmt.Sprintf("F-%d", 100+i))
		unranked = append(unranked, fmt.Sprintf("S-%d", 200+i))
	}
	msg := withNext(t, stream.Order{Ranked: units(true, ranked...), Unranked: units(false, unranked...)}, nil, "")
	// At 100x40 the next box holds a few rows only.
	m, _ := update(t, sized(t, 100, 40), msg)
	m = focused(t, m, nextBox)
	for range 11 {
		m, _ = press(t, m, down)
	}
	if m.sel[nextBox].id != "F-111" {
		t.Fatalf("after 11 ↓: %+v", m.sel[nextBox])
	}
	// The next ↓ passes over the divider to the first unranked unit, which the box scrolls to.
	m, _ = press(t, m, down)
	out := screen(t, m)
	if m.sel[nextBox].id != "S-200" || !strings.Contains(out, "S-200") || !strings.Contains(out, "── not ranked · oldest first") ||
		strings.Contains(out, "F-100") {
		t.Errorf("↓ past the last ranked row: %+v\n%s", m.sel[nextBox], out)
	}
	for range 20 {
		m, _ = press(t, m, down)
	}
	if out := screen(t, m); m.sel[nextBox].id != "S-211" || !strings.Contains(out, "S-211") {
		t.Errorf("↓ to the end: %+v\n%s", m.sel[nextBox], out)
	}
	m, _ = press(t, m, up)
	if m.sel[nextBox].id != "S-210" {
		t.Errorf("↑ from the end: %+v", m.sel[nextBox])
	}
}

func TestNextBoxShowsTheCommittedOrderWithoutFocusAndTheStagedWithIt(t *testing.T) {
	committed := stream.Order{Ranked: units(true, "F-1", "F-2", "F-3"), Unranked: units(false, "S-9")}
	staged := stream.Order{Ranked: units(true, "S-9", "F-3", "F-1"), Unranked: units(false, "F-2")}
	for i, mark := range []string{"+", "~", ""} {
		staged.Ranked[i].Mark = mark
	}
	staged.Unranked[0].Mark = "-"
	m, _ := update(t, sized(t, 171, 63), withNext(t, committed, &staged, ""))
	out := screen(t, m)
	for _, want := range []string{
		"⁵next · staged edits┌",
		"│ Rank  Id     Status    Pts  Held by  Title",
		"│   1   F-1    draft       -           title of F-1",
		"│       S-9    draft       -           title of S-9",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("the next box without the focus has no %q:\n%s", want, out)
		}
	}
	m = focused(t, m, nextBox)
	out = screen(t, m)
	for _, want := range []string{
		"⁵next · staged edits┌",
		"│   Rank  Id     Status    Pts  Held by  Title",
		"│ +   1   S-9    draft       -           title of S-9",
		"│ ~   2   F-3    draft       -           title of F-3",
		"│     3   F-1    draft       -           title of F-1",
		"│ -       F-2    draft       -           title of F-2",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("the next box with the focus has no %q:\n%s", want, out)
		}
	}
	// The selection kept its unit, F-1, which has no marker: a selected row's marker would carry the
	// surface0 background too.
	if m.sel[nextBox].id != "F-1" {
		t.Errorf("the focus moved the selection off F-1: %+v", m.sel[nextBox])
	}
	for mark, color := range map[string]string{"+": sgr(colorGreen), "~": sgr(colorPeach), "-": sgr(colorRed)} {
		if l := lineWith(t, m, "│ "+mark+"   "); !strings.Contains(l, color+mark) {
			t.Errorf("the %s marker is not %s: %q", mark, color, l)
		}
	}
	// With no staged copy, the title has no staged edits and the rows no marker column.
	m, _ = update(t, m, withNext(t, committed, nil, ""))
	if out := screen(t, m); strings.Contains(out, "staged edits") || !strings.Contains(out, "│   1   F-1    draft") {
		t.Errorf("no staged copy:\n%s", out)
	}
}

func TestDTogglesTheUnrankedOrderInBothViews(t *testing.T) {
	committed := stream.Order{Ranked: units(true, "F-1"), Unranked: units(false, "S-1", "S-2", "S-3")}
	staged := stream.Order{Ranked: units(true, "F-1", "S-1"), Unranked: units(false, "S-2", "S-3")}
	m, _ := update(t, sized(t, 171, 63), withNext(t, committed, &staged, ""))
	// first is the first unranked unit the next box draws: the id on the line after the divider.
	first := func(m Model, order string) string {
		t.Helper()
		lines := strings.Split(screen(t, m), "\n")
		for i, l := range lines {
			if j := strings.Index(l, "── not ranked · "+order); j >= 0 {
				return strings.Fields(lines[i+1][j:])[0]
			}
		}
		t.Fatalf("no divider says %q:\n%s", order, strings.Join(lines, "\n"))
		return ""
	}
	if got := first(m, "oldest first"); got != "S-1" {
		t.Errorf("bl top starts oldest first: %s", got)
	}
	// d outside the next box does nothing.
	m, _ = press(t, m, text("d"))
	if m.newestFirst {
		t.Error("d in the runs box toggled the order")
	}
	m, _ = press(t, focused(t, m, nextBox), text("d"))
	if got := first(m, "newest first"); got != "S-3" {
		t.Errorf("staged view, newest first: %s", got)
	}
	// The committed view takes the same order.
	m, _ = press(t, m, tab)
	if got := first(m, "newest first"); got != "S-3" {
		t.Errorf("committed view, newest first: %s", got)
	}
	m, _ = press(t, m, shiftTab, text("d"))
	if got := first(m, "oldest first"); got != "S-2" {
		t.Errorf("staged view, oldest first again: %s", got)
	}
}

func TestAConflictIsARedLineAboveTheBoxes(t *testing.T) {
	const conflict = "merge conflict in .bl/priority.staged.yaml: edit it, then bl rank --commit; or bl rank --reset"
	msg := withNext(t, stream.Order{Ranked: units(true, "F-1")}, nil, conflict)
	for _, hide := range []bool{false, true} {
		m, _ := update(t, sized(t, 171, 63), msg)
		if hide {
			m, _ = press(t, m, numberKey(m, nextBox))
		}
		lines := strings.Split(screen(t, m), "\n")
		if lines[0] != fit(" ! "+conflict, 171) || !strings.HasPrefix(lines[1], "╭─┐¹runs┌") {
			t.Errorf("the next box hidden %v: %q / %q", hide, lines[0], lines[1])
		}
		if raw := strings.Split(m.render(), "\n")[0]; !strings.Contains(raw, sgr(colorRed)) {
			t.Errorf("the conflict line is not red: %q", raw)
		}
	}
	// Without a conflict, the boxes start on the first line.
	m, _ := update(t, sized(t, 171, 63), withNext(t, stream.Order{}, nil, ""))
	if lines := strings.Split(screen(t, m), "\n"); !strings.HasPrefix(lines[0], "╭─┐¹runs┌") {
		t.Errorf("no conflict: %q", lines[0])
	}
}
