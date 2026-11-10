package ui

import (
	"fmt"
	"strings"
	"time"

	"charm.land/lipgloss/v2"

	"github.com/roost-cc/bl/top/internal/stream"
)

// agentColumnFrom is the inner width from which box ¹ has its Agent column: Mockup A has it,
// Mockup B (100 wide) does not.
const agentColumnFrom = 103

// runState is how box ¹ shows a run status (D4, D5): its glyph and word, their style, and whether
// the row is dim. Every status that is not running, stale, stopped, escalated or failed is a run
// that ended well (`done`, `clean`, `no-change`).
func runState(status string) (string, lipgloss.Style, bool) {
	switch status {
	case "running":
		return "● run", styleOK, false
	case "stale":
		return "◌ stale", styleWarn, false
	case "stopped":
		return "■ stop", styleWarn, false
	case "escalated":
		return "✗ esc", styleError, false
	case "failed":
		return "✗ fail", styleError, false
	}
	return "✓ done", styleOK, true
}

// drawRuns draws box ¹ (D4, Mockups A and B) in w×h inner cells: a row per run with its state,
// step, story, round, elapsed time, output tokens, agent (when the box is wide enough) and pull
// request, then the summary line.
func (m Model) drawRuns(w, h int) []string {
	s := m.snap
	agent := w >= agentColumnFrom
	head := []cell{{"Id      ", styleDim}, {"State   ", styleDim}, {"Step            ", styleDim}, {"Story   ", styleDim},
		{"Round  ", styleDim}, {"Elapsed  ", styleDim}, {"Out tok  ", styleDim}}
	if agent {
		head = append(head, cell{"Agent              ", styleDim})
	}
	head = append(head, cell{"Pull request", styleDim})
	rows := s.Runs.Rows
	sel := m.selected(1)
	draw := func(i int) string {
		r := rows[i]
		glyph, style, dim := runState(r.Status)
		text := styleText
		if dim {
			text = styleDim
		}
		round := "-"
		if r.Round > 0 && r.MaxRounds > 0 {
			round = fmt.Sprintf("%d/%d", r.Round, r.MaxRounds)
		}
		cells := []cell{{fit(r.ID, 7) + " ", text}, {fit(glyph, 7) + " ", style},
			{fit(r.Step, 15) + " " + fit(dash(r.Story), 7) + " " + fit(round, 6) + " " + fit(elapsed(r, s.At), 8) + " " +
				fit(count(float64(r.Usage.Output)), 8) + " ", text}}
		if agent {
			who := strings.Join(strings.Fields(r.Agent+" "+r.Model+" "+r.Effort), " ")
			cells = append(cells, cell{fit(dash(who), 18) + " ", text})
		}
		cells = append(cells, cell{prLabel(r.PR), text})
		return row(w, i == sel, cells...)
	}
	return rowsAndFoot(row(w, false, head...), len(rows), sel, h, draw, row(w, false, cell{runSummary(s), styleText}), false)
}

// runSummary is box ¹'s summary line: how many runs are running, stopped and stale, and the
// stories and points done today (the newest day of `history`).
func runSummary(s *stream.Snapshot) string {
	n := map[string]int{}
	for _, r := range s.Runs.Rows {
		n[r.Status]++
	}
	stories, points := 0, 0.0
	if days := s.History.Days; len(days) > 0 {
		stories, points = len(days[len(days)-1].Stories), days[len(days)-1].Points
	}
	return fmt.Sprintf("%d running · %d stopped · %d stale · done today: %d stories, %g points",
		n["running"], n["stopped"], n["stale"], stories, points)
}

// elapsed is how long a run has taken: from its start to the snapshot while it runs (or is stale),
// else to its last update; `-` when a time is missing.
func elapsed(r stream.Run, now time.Time) string {
	start, err := time.Parse(time.RFC3339, r.StartedAt)
	if err != nil {
		return "-"
	}
	end := now
	if r.Status != "running" && r.Status != "stale" {
		if end, err = time.Parse(time.RFC3339, r.UpdatedAt); err != nil {
			return "-"
		}
	}
	return duration(end.Sub(start))
}

// prLabel is a pull request as `<repo>#<number>`, the repo taken from its URL
// (`…/<repo>/pull/<number>`); `-` for none.
func prLabel(pr *stream.PR) string {
	if pr == nil {
		return "-"
	}
	path := strings.Split(strings.TrimSuffix(pr.URL, "/"), "/")
	for i := len(path) - 2; i > 0; i-- {
		if path[i] == "pull" {
			return path[i-1] + "#" + path[i+1]
		}
	}
	return "#" + pr.Number
}

// dash is s, or `-` when s is empty.
func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}
