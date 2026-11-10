package ui

import (
	"fmt"
	"strings"

	"github.com/roost-cc/bl/top/internal/stream"
)

// drawNext draws box ³ (D4, Mockups A and B) in w×h inner cells: `bl next`'s ranked units with
// their rank, id, status, points, holders and title, then the pick line.
func (m Model) drawNext(w, h int) []string {
	ranked := m.snap.Next.Ranked
	sel := m.selected(3)
	draw := func(i int) string {
		r := ranked[i]
		points := "-"
		if r.Points > 0 {
			points = fmt.Sprintf("%g", r.Points)
		}
		return row(w, i == sel, cell{fmt.Sprintf("%3d   ", r.Position) + fit(r.ID, 6) + " " + fit(r.Status, 9) + " " +
			fmt.Sprintf("%3s", points) + "  " + fit(strings.Join(r.HeldBy, ","), 7) + "  " + r.Title, styleText})
	}
	head := row(w, false, cell{"Rank  Id     Status    Pts  Held by  Title", styleDim})
	foot := row(w, false, cell{pickLine(m.snap.Next), styleText})
	return rowsAndFoot(head, len(ranked), sel, h, draw, foot, false)
}

// pickLine is box ³'s line under the list: the unit `bl next` picks and its status, the ranked
// unit it unblocks when that is another, and how many units are not ranked.
func pickLine(n stream.Next) string {
	if n.Pick == nil {
		return "bl next → nothing can run"
	}
	line := fmt.Sprintf("bl next → %s (%s)", n.Pick.ID, n.Pick.Status)
	if n.Pick.From != "" && n.Pick.From != n.Pick.ID {
		line += " · it unblocks " + n.Pick.From
	}
	if n.UnrankedCount > 0 {
		line += fmt.Sprintf(" · %d work units not ranked", n.UnrankedCount)
	}
	return line
}
