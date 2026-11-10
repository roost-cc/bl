package ui

import (
	"fmt"
	"strings"
	"time"

	"github.com/roost-cc/bl/top/internal/stream"
)

// weekDays is how many of the newest days the `last 7 days` total of box ⁵ adds.
const weekDays = 7

// drawActivity draws box ⁵ (D4) in w×h inner cells: the braille graph of points done per UTC day
// (section `history`) with the last 7 days' total and a date axis, then the newest run events
// (section `activity`, D3c) in local time, as many as fit.
func drawActivity(s *stream.Snapshot, w, h int) []string {
	cw := w - 2
	compact := h < compactHeight
	days := s.History.Days
	points := make([]float64, len(days))
	week := 0.0
	for i, d := range days {
		points[i] = d.Points
		if i >= len(days)-weekDays {
			week += d.Points
		}
	}
	rows := min(max((h-2)/3, 2), 6)
	lines := []string{spread(
		styleText.Render(fmt.Sprintf("points done / UTC day · %d days", len(days))),
		styleDim.Render(fmt.Sprintf("last %d days %g", weekDays, week)), cw)}
	lines = append(lines, colorGraph(graph(points, cw, rows))...)
	if !compact {
		lines = append(lines, dayAxis(days, cw), "")
	}
	for _, e := range s.Activity.Events {
		if len(lines) >= h {
			break
		}
		lines = append(lines, eventLine(e))
	}
	return margin(lines)
}

// dayAxis is the date axis of box ⁵'s graph, w cells wide: today's date and every 14th day
// before it.
func dayAxis(days []stream.Day, w int) string {
	var marks []mark
	for i, d := range days {
		if (len(days)-1-i)%14 != 0 {
			continue
		}
		if t, err := time.Parse(time.DateOnly, d.Date); err == nil {
			marks = append(marks, mark{i * w / len(days), t.Format("Jan 02")})
		}
	}
	return axis(marks, w)
}

// eventLine is one run event of box ⁵: its local time, work unit, step with its story or round,
// ✓ or ✗ and its duration, then the agent, model and effort of a session that did not fail, or
// else the note.
func eventLine(e stream.Event) string {
	step := e.Step
	if e.Story != "" {
		step += " " + e.Story
	} else if e.Round > 0 {
		step += fmt.Sprintf(" r%d", e.Round)
	}
	ok := " "
	switch {
	case e.OK == nil:
	case *e.OK:
		ok = styleOK.Render("✓")
	default:
		ok = styleError.Render("✗")
	}
	took := ""
	if e.DurationMs != nil {
		took = duration(time.Duration(*e.DurationMs) * time.Millisecond)
	}
	rest := e.Note
	if e.Agent != "" && (e.OK == nil || *e.OK || e.Note == "") {
		rest = strings.Join(strings.Fields(strings.Join([]string{e.Agent, e.Model, e.Effort}, " ")), " ")
	}
	return styleDim.Render(e.At.Local().Format("15:04")) + "  " + styleText.Render(fit(e.Unit, 7)+" "+fit(step, 17)) + " " +
		ok + " " + styleText.Render(fit(took, 5)+" "+strings.Join(strings.Fields(rest), " "))
}

// duration is a time span in a few characters: 45s, 3m, 1h02m.
func duration(d time.Duration) string {
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
}
