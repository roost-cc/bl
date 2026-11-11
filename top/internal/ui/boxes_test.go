package ui

import (
	"bytes"
	"fmt"
	"image/color"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"

	"github.com/roost-cc/bl/top/internal/stream"
)

// sgr is the foreground SGR of c, as red;green;blue in decimal, as lipgloss writes it.
func sgr(c color.Color) string {
	r, g, b, _ := c.RGBA()
	return fmt.Sprintf("38;2;%d;%d;%dm", r>>8, g>>8, b>>8)
}

func TestGraphKnownGlyphs(t *testing.T) {
	// One cell: the left sample fills all 4 dots, the right one the bottom 2.
	if got := graph([]float64{4, 2}, 1, 1); !reflect.DeepEqual(got, []string{"⣧"}) {
		t.Errorf("graph(4 2) = %q", got)
	}
	// Two cells, two rows (8 dots high): 8 fills the left column of both rows; 1 fills one dot,
	// the least a value above 0 fills; 4 fills the bottom row's right column; 0 is a space.
	if got := graph([]float64{8, 0, 1, 4}, 2, 2); !reflect.DeepEqual(got, []string{"⡇ ", "⡇⣸"}) {
		t.Errorf("graph(8 0 1 4) = %q", got)
	}
	// Nothing to show: spaces.
	if got := graph([]float64{0, 0}, 3, 2); !reflect.DeepEqual(got, []string{"   ", "   "}) {
		t.Errorf("graph(0 0) = %q", got)
	}
	if got := graph(nil, 2, 1); !reflect.DeepEqual(got, []string{"  "}) {
		t.Errorf("graph(nil) = %q", got)
	}
}

func TestResampleKeepsPeaksAndSpreadsFewValues(t *testing.T) {
	values := make([]float64, 120)
	values[31], values[119] = 5, 9
	if got := resample(values, 4); !reflect.DeepEqual(got, []float64{0, 5, 0, 9}) {
		t.Errorf("120 into 4 = %v", got)
	}
	if got := resample([]float64{1, 2}, 4); !reflect.DeepEqual(got, []float64{1, 1, 2, 2}) {
		t.Errorf("2 into 4 = %v", got)
	}
}

func TestGraphColorsGoGreenYellowRedByHeight(t *testing.T) {
	for _, c := range []struct {
		t    float64
		want color.Color
	}{{0, colorGreen}, {0.5, colorYellow}, {1, colorRed}} {
		if got := sgr(gradient(c.t)); got != sgr(c.want) {
			t.Errorf("gradient(%v) = %s, want %s", c.t, got, sgr(c.want))
		}
	}
	lines := colorGraph([]string{"⣿", "⣿", "⣿"})
	for i, want := range []color.Color{colorRed, colorYellow, colorGreen} {
		if !strings.Contains(lines[i], sgr(want)) {
			t.Errorf("line %d of 3 is not %s: %q", i, sgr(want), lines[i])
		}
	}
}

func TestMeterAtD5Thresholds(t *testing.T) {
	for _, c := range []struct {
		left  float64
		cells string
		color color.Color
	}{
		{0, "··········", colorRed},
		{20, "■■········", colorYellow},
		{50, "■■■■■·····", colorYellow},
		{100, "■■■■■■■■■■", colorGreen},
	} {
		got := meter(c.left, 10)
		if ansi.Strip(got) != c.cells {
			t.Errorf("meter(%v) = %q, want %q", c.left, ansi.Strip(got), c.cells)
		}
		if sgr(meterColor(c.left)) != sgr(c.color) {
			t.Errorf("meterColor(%v) = %s, want %s", c.left, sgr(meterColor(c.left)), sgr(c.color))
		}
		if c.left > 0 && !strings.Contains(got, sgr(c.color)+"■") {
			t.Errorf("meter(%v) is not drawn in %s: %q", c.left, sgr(c.color), got)
		}
	}
}

// snapshot is the recorded snapshot testdata/snapshot.json, with the local zone fixed for the test
// (fixedLocal).
func snapshot(t *testing.T) stream.SnapshotMsg {
	t.Helper()
	fixedLocal(t)
	data, err := os.ReadFile("testdata/snapshot.json")
	if err != nil {
		t.Fatal(err)
	}
	snap, err := stream.Decode(bytes.TrimSpace(data))
	if err != nil {
		t.Fatal(err)
	}
	return stream.SnapshotMsg{Gen: 1, Snapshot: snap}
}

// TestBoxesGolden draws the recorded snapshot (Mockup A's data) in every box, with a row selected
// in boxes ¹ to ³: S-1330 in ¹, S-1330:change in ², F-84 in ³.
func TestBoxesGolden(t *testing.T) {
	msg := snapshot(t)
	for _, size := range []struct {
		name string
		w, h int
	}{{"boxes-171x63", 171, 63}, {"boxes-100x40", 100, 40}} {
		m, _ := update(t, sized(t, size.w, size.h), msg)
		m, _ = press(t, m, down, tab, down, down, down, down, down, tab, down)
		golden(t, size.name, screen(t, m))
	}
}

func TestBoxFourShowsGraphMetersAndTotals(t *testing.T) {
	m, _ := update(t, sized(t, 171, 63), snapshot(t))
	out := screen(t, m)
	for _, want := range []string{
		"output tokens / min · ended sessions",
		"peak 8.7k",
		// The axis: the local half hours, and now.
		"16:30", "17:00", "17:30", "18:00", "now",
		// One meter per window, once though two codex models report it; the reset in local time,
		// or its date when it is more than a day away.
		"codex 5h ", " 80% 19:52",
		"codex 7d ", " 13% Nov 12",
		// One line for claude, though four configurations say the same.
		"claude   unknown: claude cannot report capacity",
		"today  in 1.2M · out 640k · cache r 51M · w 2.3M",
		"capacity read 18:14",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("box ⁴ has no %q:\n%s", want, out)
		}
	}
	// In the stacked layout's narrow box ⁴, the short label leaves room for the peak.
	m, _ = update(t, sized(t, 100, 40), snapshot(t))
	if narrow := screen(t, m); !strings.Contains(narrow, "out tok / min · ended sessions") || !strings.Contains(narrow, "peak 8.7k") {
		t.Errorf("box ⁴ at 100x40 has no short label and peak:\n%s", narrow)
	}
	if n := strings.Count(out, "codex 5h"); n != 1 {
		t.Errorf("codex 5h shown %d times", n)
	}
	if n := strings.Count(out, "claude cannot report capacity"); n != 1 {
		t.Errorf("the claude line shown %d times", n)
	}
}

func TestBoxFiveShowsPointsAndEventsInLocalTime(t *testing.T) {
	m, _ := update(t, sized(t, 171, 63), snapshot(t))
	out := screen(t, m)
	for _, want := range []string{
		"points done / UTC day · 30 days",
		"last 7 days 41",
		"Oct 12", "Oct 26", "Nov 09",
		// 23:16 UTC is 18:16 in the test's zone.
		"18:16  F-81    implement S-1310  ✓ 3m    claude opus low",
		// A round entry: its round, and its note, since it names no agent, cut at the box's edge.
		"18:01  S-1330  review:round r1   ✓       round 1 reviewed by …│",
		// A failed session: its note, not its agent.
		"17:45  F-81    implement S-1309  ✗ 11m   denied: Bash(cd",
		"18:05  S-1330  review:verify     ✓ 9m    codex gpt-6-sol",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("box ⁵ has no %q:\n%s", want, out)
		}
	}
	// Newest first.
	if strings.Index(out, "18:16  F-81") > strings.Index(out, "18:05  S-1330") {
		t.Error("the events are not newest first")
	}
}

func TestCKeyWritesCapacityToTheStream(t *testing.T) {
	m := sized(t, 100, 40)
	if _, cmd := press(t, m, text("c")); cmd != nil {
		t.Error("c with no stream returned a command")
	}
	// The script echoes its first stdin line to stderr, which the end message carries.
	s, err := stream.Start([]string{"sh", "-c", `read line; echo "$line" >&2; exit 1`}, 1)
	if err != nil {
		t.Fatal(err)
	}
	m.stream = s
	_, cmd := press(t, m, text("c"))
	if cmd == nil {
		t.Fatal("c returned no command")
	}
	cmd()
	got := make(chan any, 1)
	go func() { got <- s.Next() }()
	select {
	case msg := <-got:
		if !reflect.DeepEqual(msg, stream.EndMsg{Gen: 1, Reason: "capacity"}) {
			t.Errorf("the stream read %#v, want a capacity line", msg)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no message from the stream in 10 s")
	}
}

func TestCountPicksTheUnitAfterRounding(t *testing.T) {
	for n, want := range map[float64]string{
		0: "0", 999.4: "999", 999.6: "1.0k", 9949: "9.9k", 9999.9: "10k", 412000: "412k",
		999499: "999k", 999999: "1.0M", 9.94e6: "9.9M", 9.96e6: "10M", 2.3e7: "23M",
	} {
		if got := count(n); got != want {
			t.Errorf("count(%v) = %q, want %q", n, got, want)
		}
	}
}
