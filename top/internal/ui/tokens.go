package ui

import (
	"fmt"
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/roost-cc/bl/top/internal/stream"
)

// compactHeight is the inner height below which the tokens and the activity box leave out their
// time axis and their blank lines, as in Mockup B.
const compactHeight = 12

// capacityNameWidth is the width of the name column of the tokens box's capacity lines
// (`codex 5h`).
const capacityNameWidth = 9

// maxMeterWidth is the most cells a quota window's meter takes.
const maxMeterWidth = 30

// drawTokens draws the tokens box (D4) in w×h inner cells: the braille graph of output tokens per
// minute of ended sessions (D3b) with its peak and time axis, one meter per quota window of `bl
// capacity`, today's totals, and when capacity was last read.
func drawTokens(s *stream.Snapshot, w, h int) []string {
	cw := w - 2
	compact := h < compactHeight
	var tail []string
	if !compact {
		tail = append(tail, "")
	}
	tail = append(tail, capacityLines(s, cw)...)
	if !compact {
		tail = append(tail, "")
	}
	u := s.Tokens.Today
	tail = append(tail,
		styleText.Render(fmt.Sprintf("today  in %s · out %s · cache r %s · w %s",
			count(float64(u.Input)), count(float64(u.Output)), count(float64(u.CacheRead)), count(float64(u.CacheCreation)))),
		styleDim.Render("capacity read "+clock(s.Capacity.ReadAt)+" · c reads it now"))
	rows := h - 1 - len(tail)
	if !compact {
		rows-- // the time axis
	}
	rows = max(rows, 1)
	minutes := s.Tokens.Minutes
	peak := 0.0
	for _, v := range minutes {
		peak = max(peak, v)
	}
	// The short label leaves room for the peak in a narrow box (Mockup B).
	label, top := "output tokens / min · ended sessions", "peak "+count(peak)
	if len([]rune(label))+1+len(top) > cw {
		label = "out tok / min · ended sessions"
	}
	lines := []string{spread(styleText.Render(label), styleDim.Render(top), cw)}
	lines = append(lines, colorGraph(graph(minutes, cw, rows))...)
	if !compact {
		lines = append(lines, tokenAxis(s.Tokens, cw))
	}
	lines = append(lines, tail...)
	return margin(lines)
}

// tokenAxis is the time axis of the tokens box's graph, w cells wide: the local time of each half
// hour, and `now` at the right end.
func tokenAxis(t stream.Tokens, w int) string {
	n := len(t.Minutes)
	const now = "now"
	var marks []mark
	for i := range n {
		at := t.From.Add(time.Duration(i) * time.Minute).Local()
		col := i * w / n
		if at.Minute()%30 == 0 && col+len("15:04") < w-len(now) {
			marks = append(marks, mark{col, at.Format("15:04")})
		}
	}
	return axis(append(marks, mark{w, now}), w)
}

// capacityLines are the tokens box's lines for the `capacity` section, w cells wide: one meter per
// quota window, with its percent left and its reset, and `<agent>  <state>: <message>` for a
// configuration that reads no window (an agent that cannot report capacity says `unknown`). A
// window or line that an earlier configuration showed is not shown again: an agent whose quota is
// the account's reports the same windows for every model.
func capacityLines(s *stream.Snapshot, w int) []string {
	seen := map[string]bool{}
	var lines []string
	for _, c := range s.Capacity.Configurations {
		if len(c.Windows) == 0 {
			text := c.State
			if c.Message != "" {
				text += ": " + c.Message
			}
			line := fit(c.Agent, capacityNameWidth) + text
			if !seen[line] {
				seen[line] = true
				lines = append(lines, styleText.Render(line))
			}
			continue
		}
		for _, win := range c.Windows {
			if seen[win.Name] {
				continue
			}
			seen[win.Name] = true
			reset := resetLabel(win.ResetsAt, s.At)
			// The name, the meter, ` 80% ` and the reset.
			mw := min(maxMeterWidth, w-capacityNameWidth-6-len(reset))
			lines = append(lines, styleText.Render(fit(win.Name, capacityNameWidth))+meter(win.RemainingPercent, max(mw, 1))+
				styleText.Render(fmt.Sprintf(" %3.0f%% ", win.RemainingPercent))+styleDim.Render(reset))
		}
	}
	return lines
}

// resetLabel is when a quota window resets, in local time: `15:04` within a day of now, else
// `Jan 02`; empty when the window names no reset.
func resetLabel(resetsAt string, now time.Time) string {
	t, err := time.Parse(time.RFC3339, resetsAt)
	if err != nil {
		return ""
	}
	if t.Sub(now) < 24*time.Hour {
		return t.Local().Format("15:04")
	}
	return t.Local().Format("Jan 02")
}

// count is a token count in a few characters: 950, 9.1k, 640k, 2.3M, 51M.
func count(n float64) string {
	// Each bound is where the rounded number reaches the next unit: 999.5 shows as 1.0k, not 1000.
	switch {
	case n < 999.5:
		return fmt.Sprintf("%.0f", n)
	case n < 9950:
		return fmt.Sprintf("%.1fk", n/1e3)
	case n < 999500:
		return fmt.Sprintf("%.0fk", n/1e3)
	case n < 9.95e6:
		return fmt.Sprintf("%.1fM", n/1e6)
	}
	return fmt.Sprintf("%.0fM", n/1e6)
}

// clock is a time as the local `15:04`, or `never` for the zero time.
func clock(t time.Time) string {
	if t.IsZero() {
		return "never"
	}
	return t.Local().Format("15:04")
}

// fit cuts s with `…`, or pads it with spaces, to w cells.
func fit(s string, w int) string {
	s = ansi.Truncate(s, w, "…")
	return s + strings.Repeat(" ", w-lipgloss.Width(s))
}

// spread puts left at the start of a line of w cells and right at its end; with no room for
// right, the line is left alone.
func spread(left, right string, w int) string {
	gap := w - lipgloss.Width(left) - lipgloss.Width(right)
	if gap < 1 {
		return left
	}
	return left + strings.Repeat(" ", gap) + right
}

// margin puts the one-cell left margin of a box's content before each line.
func margin(lines []string) []string {
	for i, l := range lines {
		lines[i] = " " + l
	}
	return lines
}
