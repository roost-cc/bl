package ui

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/roost-cc/bl/top/internal/stream"
)

var updateGolden = flag.Bool("update", false, "write the golden files from the output")

// golden compares got with testdata/<name>.golden, or writes the file with -update. The file ends
// in a newline, as the repo's file hygiene hook wants.
func golden(t *testing.T, name, got string) {
	t.Helper()
	got += "\n"
	path := filepath.Join("testdata", name+".golden")
	if *updateGolden {
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != string(want) {
		t.Errorf("%s differs from %s (go test ./... -update writes it):\n%s", name, path, got)
	}
}

func update(t *testing.T, m Model, msg tea.Msg) (Model, tea.Cmd) {
	t.Helper()
	next, cmd := m.Update(msg)
	return next.(Model), cmd
}

// sized is a model of a w×h terminal. Its commands never run, so it starts no stream.
func sized(t *testing.T, w, h int) Model {
	t.Helper()
	m, _ := update(t, New([]string{"bl"}, 2000, true, nil), tea.WindowSizeMsg{Width: w, Height: h})
	return m
}

func press(t *testing.T, m Model, keys ...tea.KeyPressMsg) (Model, tea.Cmd) {
	t.Helper()
	var cmd tea.Cmd
	for _, k := range keys {
		m, cmd = update(t, m, k)
	}
	return m, cmd
}

func text(s string) tea.KeyPressMsg { return tea.KeyPressMsg{Code: []rune(s)[0], Text: s} }

// numberKey is the number key that hides or shows box b: its number in m's drawn layout.
func numberKey(m Model, b boxName) tea.KeyPressMsg { return text(fmt.Sprint(m.number(b))) }

// focused is m after Tab moved the focus to box b.
func focused(t *testing.T, m Model, b boxName) Model {
	t.Helper()
	for range boxes {
		if m.focus == b {
			return m
		}
		m, _ = press(t, m, tab)
	}
	t.Fatalf("tab does not reach the %s box", b)
	return m
}

var (
	tab      = tea.KeyPressMsg{Code: tea.KeyTab}
	shiftTab = tea.KeyPressMsg{Code: tea.KeyTab, Mod: tea.ModShift}
	up       = tea.KeyPressMsg{Code: tea.KeyUp}
	down     = tea.KeyPressMsg{Code: tea.KeyDown}
	enter    = tea.KeyPressMsg{Code: tea.KeyEnter}
)

// screen is the model's screen without its colors, after a check that it fills the terminal.
func screen(t *testing.T, m Model) string {
	t.Helper()
	out := m.render()
	lines := strings.Split(out, "\n")
	if len(lines) != m.height {
		t.Fatalf("%d lines at %dx%d", len(lines), m.width, m.height)
	}
	for i, l := range lines {
		if w := lipgloss.Width(l); w != m.width {
			t.Fatalf("line %d is %d cells wide at %dx%d: %q", i, w, m.width, m.height, ansi.Strip(l))
		}
	}
	return ansi.Strip(out)
}

// fixedLocal sets the local zone to a fixed one until the test ends, so the times on screen do not
// depend on the machine's zone.
func fixedLocal(t *testing.T) {
	t.Helper()
	local := time.Local
	time.Local = time.FixedZone("UTC-5", -5*60*60)
	t.Cleanup(func() { time.Local = local })
}

// recorded is the snapshot of line i of the stream package's recorded lines.
func recorded(t *testing.T, i int) stream.SnapshotMsg {
	t.Helper()
	data, err := os.ReadFile("../stream/testdata/stream.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	snap, err := stream.Decode(bytes.Split(data, []byte("\n"))[i])
	if err != nil {
		t.Fatal(err)
	}
	return stream.SnapshotMsg{Gen: 1, Snapshot: snap}
}

func TestEmptyFrameGolden(t *testing.T) {
	for _, size := range []struct {
		name string
		w, h int
	}{{"frame-171x63", 171, 63}, {"frame-100x40", 100, 40}} {
		golden(t, size.name, screen(t, sized(t, size.w, size.h)))
	}
	golden(t, "frame-79x23", sized(t, 79, 23).render())
}

func TestEveryLayoutFillsTheTerminal(t *testing.T) {
	for _, s := range [][2]int{{80, 24}, {90, 30}, {99, 39}, {170, 63}, {171, 49}, {171, 50}, {240, 80}} {
		screen(t, sized(t, s[0], s[1]))
	}
}

func TestSizeMessageBelow80x24(t *testing.T) {
	for _, s := range [][2]int{{79, 40}, {120, 23}} {
		if got := sized(t, s[0], s[1]).render(); got != sizeMessage {
			t.Errorf("%dx%d: %q", s[0], s[1], got)
		}
	}
}

func TestFullLayoutFrom171x50(t *testing.T) {
	full := strings.Split(screen(t, sized(t, 171, 50)), "\n")
	if !strings.HasPrefix(full[0], "╭─┐¹runs┌") || !strings.Contains(full[0], "╮╭─┐²attention┌") {
		t.Errorf("171x50 top line: %q", full[0])
	}
	stacked := strings.Split(screen(t, sized(t, 170, 50)), "\n")
	if strings.Contains(stacked[0], "²attention") {
		t.Errorf("170x50 is not stacked: %q", stacked[0])
	}
}

func TestHiddenBoxGivesItsSpace(t *testing.T) {
	m := sized(t, 171, 63)
	m, _ = press(t, m, numberKey(m, nextBox), numberKey(m, detailBox))
	lines := strings.Split(screen(t, m), "\n")
	if s := strings.Join(lines, "\n"); strings.Contains(s, "next┌") || strings.Contains(s, "detail┌") {
		t.Fatal("the next or the detail box is drawn while hidden")
	}
	// The runs box takes the whole left column: its side runs to the line above the key bar.
	if !strings.HasPrefix(lines[61], "│") || !strings.HasPrefix(lines[62], "╰┘↑↓ select└┘tab box└") {
		t.Errorf("left column ends: %q / %q", lines[61], lines[62])
	}
	// Hide the right column too: the runs box takes the whole width.
	m, _ = press(t, m, numberKey(m, attentionBox), numberKey(m, tokensBox), numberKey(m, activityBox))
	lines = strings.Split(screen(t, m), "\n")
	if !strings.HasSuffix(lines[0], "┌─╮") || strings.Count(lines[0], "╮") != 1 {
		t.Errorf("the runs box alone: %q", lines[0])
	}
	// Hide every box: the key bar stays.
	m, _ = press(t, m, numberKey(m, runsBox))
	lines = strings.Split(screen(t, m), "\n")
	if strings.TrimSpace(lines[0]) != "" || !strings.HasPrefix(lines[62], "╰┘↑↓ select└┘tab box└") || m.focus != "" {
		t.Errorf("no box: %q / %q, focus %q", lines[0], lines[62], m.focus)
	}
}

// borders are the boxes' number and name in their top borders, in the order the screen shows them:
// left to right, then top to bottom.
func borders(t *testing.T, m Model) []string {
	t.Helper()
	var out []string
	for _, l := range strings.Split(screen(t, m), "\n") {
		for _, part := range strings.Split(l, "╭─┐")[1:] {
			out = append(out, part[:strings.Index(part, "┌")])
		}
	}
	return out
}

// tabOrder is the boxes that Tab (dir 1) or Shift+Tab (dir -1) visits from m's focus, one press
// per box, until it is back where it started.
func tabOrder(t *testing.T, m Model, dir int) []boxName {
	t.Helper()
	k := tab
	if dir < 0 {
		k = shiftTab
	}
	var seen []boxName
	for range boxes {
		m, _ = press(t, m, k)
		seen = append(seen, m.focus)
	}
	return seen
}

// TestTheDrawnLayoutNumbersTheBoxesAndDrivesTab: the number in each box's border and the Tab order
// follow the layout on screen, left to right and then top to bottom (F-127 Decision 1).
func TestTheDrawnLayoutNumbersTheBoxesAndDrivesTab(t *testing.T) {
	for _, c := range []struct {
		name    string
		w, h    int
		borders []string
		order   []boxName
	}{
		{"full", 171, 63, []string{"¹runs", "²attention", "³detail", "⁴tokens", "⁵next", "⁶activity"},
			[]boxName{runsBox, attentionBox, detailBox, tokensBox, nextBox, activityBox}},
		{"stacked", 100, 40, []string{"¹runs", "²attention", "³detail", "⁴tokens", "⁵activity", "⁶next"},
			[]boxName{runsBox, attentionBox, detailBox, tokensBox, activityBox, nextBox}},
	} {
		m := sized(t, c.w, c.h)
		if got := borders(t, m); !slices.Equal(got, c.borders) {
			t.Errorf("%s: borders %q, want %q", c.name, got, c.borders)
		}
		// Tab from runs visits the others in order and wraps to runs; Shift+Tab goes back.
		want := append(slices.Clone(c.order[1:]), runsBox)
		if got := tabOrder(t, m, 1); !slices.Equal(got, want) {
			t.Errorf("%s: tab %v, want %v", c.name, got, want)
		}
		back := slices.Clone(c.order)
		slices.Reverse(back)
		if got := tabOrder(t, m, -1); !slices.Equal(got, back) {
			t.Errorf("%s: ⇧tab %v, want %v", c.name, got, back)
		}
		// Tab and Shift+Tab skip a hidden box.
		hidden, _ := press(t, m, numberKey(m, c.order[2]))
		skip := slices.DeleteFunc(slices.Clone(want), func(b boxName) bool { return b == c.order[2] })
		if got := tabOrder(t, hidden, 1)[:len(skip)]; !slices.Equal(got, skip) {
			t.Errorf("%s: tab with %s hidden %v, want %v", c.name, c.order[2], got, skip)
		}
		skipBack := slices.DeleteFunc(slices.Clone(back), func(b boxName) bool { return b == c.order[2] })
		if got := tabOrder(t, hidden, -1)[:len(skipBack)]; !slices.Equal(got, skipBack) {
			t.Errorf("%s: ⇧tab with %s hidden %v, want %v", c.name, c.order[2], got, skipBack)
		}
	}
}

// TestAnotherLayoutTreeRenumbersTheBoxesAndTheTabOrder: a third layout with the same boxes gives
// its own numbers and Tab order, with no other change.
func TestAnotherLayoutTreeRenumbersTheBoxesAndTheTabOrder(t *testing.T) {
	saved := fullLayout
	t.Cleanup(func() { fullLayout = saved })
	// Three columns of two boxes.
	fullLayout = node{across: true, children: []node{
		{weight: 1, children: []node{{box: nextBox, weight: 1}, {box: tokensBox, weight: 1}}},
		{weight: 1, children: []node{{box: detailBox, weight: 1}, {box: runsBox, weight: 1}}},
		{weight: 1, children: []node{{box: activityBox, weight: 1}, {box: attentionBox, weight: 1}}},
	}}
	m := sized(t, 171, 63)
	want := []boxName{nextBox, detailBox, activityBox, tokensBox, runsBox, attentionBox}
	if got := m.order(); !slices.Equal(got, want) {
		t.Fatalf("order %v, want %v", got, want)
	}
	if got := borders(t, m); !slices.Equal(got, []string{"¹next", "²detail", "³activity", "⁴tokens", "⁵runs", "⁶attention"}) {
		t.Errorf("borders %q", got)
	}
	// Tab from runs (the start's focus) goes on to attention, then wraps to next.
	if got := tabOrder(t, m, 1); !slices.Equal(got, []boxName{attentionBox, nextBox, detailBox, activityBox, tokensBox, runsBox}) {
		t.Errorf("tab %v", got)
	}
}

// TestNumberKeysToggleTheBoxAtThatPosition: key n hides and shows the box at position n of the
// drawn layout, and a hidden box stays hidden when a resize gives it another number (F-127
// Decision 3).
func TestNumberKeysToggleTheBoxAtThatPosition(t *testing.T) {
	m, _ := press(t, sized(t, 171, 63), text("5"))
	if !m.hidden[nextBox] || strings.Contains(screen(t, m), "next┌") {
		t.Fatalf("5 at 171x63 did not hide the next box: %v", m.hidden)
	}
	if again, _ := press(t, m, text("5")); again.hidden[nextBox] || !strings.Contains(screen(t, again), "⁵next") {
		t.Errorf("5 twice did not show the next box again: %v", again.hidden)
	}
	// The first press is not undone by a press on a copy of the model (Update copies it).
	if !m.hidden[nextBox] {
		t.Error("a press on a copy changed the model it was copied from")
	}
	m, _ = update(t, m, tea.WindowSizeMsg{Width: 100, Height: 40})
	if out := screen(t, m); strings.Contains(out, "next┌") || !strings.Contains(out, "⁵activity") {
		t.Errorf("after the resize to 100x40, the next box is not hidden:\n%s", out)
	}
	m, _ = press(t, m, text("6"))
	if m.hidden[nextBox] || !strings.Contains(screen(t, m), "⁶next") {
		t.Errorf("6 at 100x40 did not show the next box: %v", m.hidden)
	}
}

// TestTheHelpHeadingsTakeTheBoxesCurrentNumbers: the next box's keys are under ⁵next in the full
// layout and under ⁶next in the stacked one.
func TestTheHelpHeadingsTakeTheBoxesCurrentNumbers(t *testing.T) {
	for _, c := range []struct {
		w, h int
		want string
	}{{171, 63, "⁵next"}, {100, 40, "⁶next"}} {
		m, _ := press(t, sized(t, c.w, c.h), text("h"))
		if out := screen(t, m); !strings.Contains(out, "│  "+c.want) && !strings.Contains(out, c.want+" ") {
			t.Errorf("%dx%d: the help has no heading %s:\n%s", c.w, c.h, c.want, out)
		}
	}
}

func TestBoxGolden(t *testing.T) {
	interval := styleKey.Render("-") + styleText.Render(" 2000ms ") + styleKey.Render("+")
	long := styleError.Render("! capacity not read: the codex app-server did not answer in 20 s")
	content := []string{"a line that is longer than the box is wide, cut with an ellipsis", "short"}
	var out []string
	out = append(out, drawBox(1, "runs", []string{interval}, false, content, 40, 5)...)
	out = append(out, drawBox(4, "tokens", []string{long, interval}, false, nil, 40, 3)...)
	out = append(out, drawBox(2, "attention", nil, true, nil, 40, 2)...)
	for i, l := range out {
		if w := lipgloss.Width(l); w != 40 {
			t.Errorf("line %d is %d cells wide: %q", i, w, ansi.Strip(l))
		}
	}
	golden(t, "box", ansi.Strip(strings.Join(out, "\n")))
}

func TestBoxColorsAreD5s(t *testing.T) {
	plain := strings.Join(drawBox(1, "runs", nil, false, nil, 30, 3), "\n")
	focus := strings.Join(drawBox(1, "runs", nil, true, nil, 30, 3), "\n")
	bar := keyBar(80, nil)
	for _, c := range []struct {
		what, out, color string
	}{
		// The foreground color of an SGR sequence, as red;green;blue in decimal.
		{"border: surface2 #585b70", plain, "38;2;88;91;112m"},
		{"number and name: mauve #cba6f7", plain, "38;2;203;166;247m¹runs"},
		{"focused border: mauve #cba6f7", strings.Split(focus, "\n")[2], "38;2;203;166;247m╰"},
		{"key letters: peach #fab387", bar, "38;2;250;179;135mtab"},
	} {
		if !strings.Contains(c.out, c.color) {
			t.Errorf("%s: no %s in %q", c.what, c.color, c.out)
		}
	}
}

func TestKeyBarFitsItsWidth(t *testing.T) {
	for _, w := range []int{100, 171} {
		if got := ansi.Strip(keyBar(w, nil)); lipgloss.Width(got) != w ||
			!strings.HasPrefix(got, "╰┘↑↓ select└┘tab box└┘↵ detail└┘a act└┘r run└┘s stop└┘o open└┘p PR└┘g agent└┘h help└┘q quit└─") {
			t.Errorf("keyBar(%d) = %q", w, got)
		}
	}
	// At 80 the labels do not fit: the keys alone.
	if got := ansi.Strip(keyBar(80, nil)); lipgloss.Width(got) != 80 || !strings.HasPrefix(got, "╰┘↑↓└┘tab└┘↵└┘a└┘r└┘s└┘o└┘p└┘g└┘h└┘q└─") {
		t.Errorf("keyBar(80) = %q", got)
	}
	if got := ansi.Strip(keyBar(20, nil)); got != "╰┘↑↓└┘tab└┘↵└┘a└───╯" {
		t.Errorf("keyBar(20) = %q, want the keys alone, as many as fit", got)
	}
}

func TestHidingTheFocusedBoxMovesTheFocusOn(t *testing.T) {
	m := focused(t, sized(t, 171, 63), attentionBox)
	if m, _ = press(t, m, numberKey(m, attentionBox)); m.focus != detailBox {
		t.Errorf("hiding the focused attention box: focus %q, want detail", m.focus)
	}
}

func TestPlusAndMinusRestartTheStreamWithTheNewInterval(t *testing.T) {
	m := sized(t, 171, 63)
	m, cmd := press(t, m, text("+"), text("+"))
	if m.interval != 3000 || cmd == nil {
		t.Fatalf("interval %d after + +, cmd %v", m.interval, cmd)
	}
	if !strings.Contains(strings.Split(screen(t, m), "\n")[0], "┐- 3000ms +┌─╮") {
		t.Errorf("the runs box's border does not show 3000ms")
	}
	// The first press's timer finds a newer press, and starts nothing.
	m, cmd = update(t, m, restartMsg{press: 1})
	if m.gen != 1 || cmd != nil {
		t.Errorf("an older press restarted the stream: gen %d", m.gen)
	}
	m, cmd = update(t, m, restartMsg{press: 2})
	if m.gen != 2 || cmd == nil {
		t.Errorf("the newest press did not restart the stream: gen %d", m.gen)
	}
	// A snapshot of the stream it replaced is dropped.
	m, _ = update(t, m, recorded(t, 0))
	if m.snap != nil {
		t.Error("a snapshot of the old stream was drawn")
	}
	for range 30 {
		m, _ = press(t, m, text("+"))
	}
	if m.interval != maxInterval {
		t.Errorf("interval %d after many +, want %d", m.interval, maxInterval)
	}
	for range 30 {
		m, _ = press(t, m, text("-"))
	}
	if m.interval != minInterval {
		t.Errorf("interval %d after many -, want %d", m.interval, minInterval)
	}
	// At either bound a press changes nothing, so it starts no restart.
	for _, c := range []struct {
		key      string
		interval int
	}{{"-", minInterval}, {"+", maxInterval}} {
		m.interval = c.interval
		presses := m.presses
		if m, cmd = press(t, m, text(c.key)); cmd != nil || m.presses != presses || m.interval != c.interval {
			t.Errorf("%s at %dms: cmd %v, presses %d → %d", c.key, c.interval, cmd, presses, m.presses)
		}
	}
}

func TestHelpOpensAndAnyKeyClosesIt(t *testing.T) {
	m, _ := press(t, sized(t, 100, 40), text("h"))
	if !strings.Contains(screen(t, m), "any key closes this help") {
		t.Fatal("h did not open the help")
	}
	m, _ = press(t, m, text("3"))
	if m.help || len(m.hidden) > 0 {
		t.Errorf("a key with the help open: help %v, hidden %v; want the help closed and nothing else", m.help, m.hidden)
	}
}

func TestQuitStopsTheTUI(t *testing.T) {
	for _, k := range []tea.KeyPressMsg{text("q"), {Code: 'c', Mod: tea.ModCtrl}} {
		if _, cmd := press(t, sized(t, 100, 40), k); cmd == nil {
			t.Errorf("%s: no command", k)
		} else if _, ok := cmd().(tea.QuitMsg); !ok {
			t.Errorf("%s: not quit", k)
		}
	}
}

func TestSnapshotRedrawsAndASectionErrorShowsInItsBorder(t *testing.T) {
	m, _ := update(t, sized(t, 171, 63), recorded(t, 1))
	if m.snap == nil {
		t.Fatal("the snapshot was not kept")
	}
	out := m.render()
	if !strings.Contains(out, styleError.Render("! codex app-server timed out")) {
		t.Errorf("the tokens box's border has no red ! with the capacity error:\n%s", ansi.Strip(out))
	}
	// The recorded line's staged copy is in conflict: its message is the first line, the boxes
	// start under it.
	lines := strings.Split(ansi.Strip(out), "\n")
	if !strings.HasPrefix(lines[0], " ! merge conflict in .bl/priority.staged.yaml") {
		t.Errorf("the first line is not the conflict: %q", lines[0])
	}
	clock := m.snap.At.Local().Format("15:04:05")
	if !strings.Contains(lines[1], "┐"+clock+"┌─┐- 2000ms +┌─╮") {
		t.Errorf("the runs box's border has no clock %s", clock)
	}
}

func TestStreamEndQuitsWithItsLastStderrLine(t *testing.T) {
	m, cmd := update(t, sized(t, 100, 40), stream.EndMsg{Gen: 1, Reason: "bl: no backlog here"})
	if m.Ended() != "bl: no backlog here" || cmd == nil {
		t.Fatalf("ended %q", m.Ended())
	}
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Error("the end of the stream did not quit")
	}
	m, cmd = update(t, sized(t, 100, 40), stream.EndMsg{Gen: 0, Reason: "old"})
	if m.Ended() != "" || cmd != nil {
		t.Error("the end of a replaced stream quit")
	}
}
