package ui

import (
	"bytes"
	"flag"
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
	m, _ := press(t, sized(t, 171, 63), text("3"))
	lines := strings.Split(screen(t, m), "\n")
	if s := strings.Join(lines, "\n"); strings.Contains(s, "³next") {
		t.Fatal("box ³ is drawn while hidden")
	}
	// Box ¹ takes the whole left column: its side runs to the line above the key bar.
	if !strings.HasPrefix(lines[61], "│") || !strings.HasPrefix(lines[62], "╰┘↑↓ select└┘tab box└") {
		t.Errorf("left column ends: %q / %q", lines[61], lines[62])
	}
	// Hide the right column too: box ¹ takes the whole width.
	m, _ = press(t, m, text("2"), text("4"), text("5"))
	lines = strings.Split(screen(t, m), "\n")
	if !strings.HasSuffix(lines[0], "┌─╮") || strings.Count(lines[0], "╮") != 1 {
		t.Errorf("box ¹ alone: %q", lines[0])
	}
	// Hide every box: the key bar stays.
	m, _ = press(t, m, text("1"))
	lines = strings.Split(screen(t, m), "\n")
	if strings.TrimSpace(lines[0]) != "" || !strings.HasPrefix(lines[62], "╰┘↑↓ select└┘tab box└") || m.focus != 0 {
		t.Errorf("no box: %q / %q, focus %d", lines[0], lines[62], m.focus)
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
	for _, w := range []int{80, 100, 171} {
		if got := ansi.Strip(keyBar(w, nil)); lipgloss.Width(got) != w || !strings.HasPrefix(got, "╰┘↑↓ select└┘tab box└┘+- interval└┘h help└┘q quit└─") {
			t.Errorf("keyBar(%d) = %q", w, got)
		}
	}
	if got := ansi.Strip(keyBar(20, nil)); got != "╰┘↑↓└┘tab└┘+-└┘h└──╯" {
		t.Errorf("keyBar(20) = %q, want the keys alone, as many as fit", got)
	}
}

func TestTabMovesTheFocusOverShownBoxes(t *testing.T) {
	m := sized(t, 171, 63)
	var seen []int
	for range 6 {
		m, _ = press(t, m, tab)
		seen = append(seen, m.focus)
	}
	if want := []int{2, 3, 4, 5, 1, 2}; !slices.Equal(seen, want) {
		t.Errorf("tab: %v, want %v", seen, want)
	}
	m, _ = press(t, m, shiftTab, shiftTab)
	if m.focus != 5 {
		t.Errorf("⇧tab twice from 2: %d, want 5", m.focus)
	}
	m, _ = press(t, m, text("1"), shiftTab)
	if m.focus != 4 {
		t.Errorf("⇧tab from 5 with ¹ hidden: %d, want 4", m.focus)
	}
	m, _ = press(t, m, tab, tab)
	if m.focus != 2 {
		t.Errorf("tab twice from 4 with ¹ hidden: %d, want 2", m.focus)
	}
	m, _ = press(t, m, text("2"))
	if m.focus != 3 {
		t.Errorf("hiding the focused ²: focus %d, want 3", m.focus)
	}
}

func TestPlusAndMinusRestartTheStreamWithTheNewInterval(t *testing.T) {
	m := sized(t, 171, 63)
	m, cmd := press(t, m, text("+"), text("+"))
	if m.interval != 3000 || cmd == nil {
		t.Fatalf("interval %d after + +, cmd %v", m.interval, cmd)
	}
	if !strings.Contains(strings.Split(screen(t, m), "\n")[0], "┐- 3000ms +┌─╮") {
		t.Errorf("¹ border does not show 3000ms")
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
	if m.help || m.hidden[3] {
		t.Errorf("a key with the help open: help %v, ³ hidden %v; want the help closed and nothing else", m.help, m.hidden[3])
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
		t.Errorf("box ⁴'s border has no red ! with the capacity error:\n%s", ansi.Strip(out))
	}
	clock := m.snap.At.Local().Format("15:04:05")
	if !strings.Contains(strings.Split(ansi.Strip(out), "\n")[0], "┐"+clock+"┌─┐- 2000ms +┌─╮") {
		t.Errorf("¹ border has no clock %s", clock)
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
