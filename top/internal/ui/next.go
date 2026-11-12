package ui

import (
	"fmt"
	"slices"
	"strings"

	"charm.land/lipgloss/v2"

	"github.com/roost-cc/bl/top/internal/stream"
)

// staging reports whether box ³ shows the staged order (F-113 D4): it has the focus and a staged
// copy exists.
func (m Model) staging() bool {
	return m.focus == 3 && m.snap.Next.Staged != nil
}

// nextOrder is the order box ³ shows: the staged order while staging, else the committed order. Its
// unranked units are newest first after `d` (F-113 Decision A1); the snapshot sends them oldest
// first.
func (m Model) nextOrder() stream.Order {
	o := m.snap.Next.Order
	if m.staging() {
		o = *m.snap.Next.Staged
	}
	if m.newestFirst {
		o.Unranked = slices.Clone(o.Unranked)
		slices.Reverse(o.Unranked)
	}
	return o
}

// nextUnits are box ³'s units, top to bottom as it draws them: the ranked, then the unranked.
func (m Model) nextUnits() []stream.Unit {
	o := m.nextOrder()
	return slices.Concat(o.Ranked, o.Unranked)
}

// markStyles color the staged order's marker column (F-113 D4): newly ranked, moved, taken out.
var markStyles = map[string]lipgloss.Style{"+": styleOK, "~": styleWarn, "-": styleError}

// drawNext draws box ³ (D4, Mockups A and B; F-113 D4, D5) in w×h inner cells: every ranked unit
// with its rank, id, status, points, holders and title, the divider, every unranked unit, then the
// pick line. While staging, a marker column comes first. The yanked unit has a peach `↕` after its
// rank (F-113 D6). The rows scroll to keep the selected one shown.
func (m Model) drawNext(w, h int) []string {
	o := m.nextOrder()
	units := slices.Concat(o.Ranked, o.Unranked)
	staging := m.staging()
	sel := m.selected(3)
	// The divider is line len(o.Ranked) of the list; the units after it are one line lower.
	divider, line := len(o.Ranked), sel
	if sel >= divider {
		line++
	}
	draw := func(i int) string {
		if i == divider {
			return row(w, false, cell{dividerLine(m.newestFirst, w), styleDim})
		}
		if i > divider {
			i--
		}
		u := units[i]
		var cells []cell
		if staging {
			cells = append(cells, cell{fmt.Sprintf("%-2s", u.Mark), markStyles[u.Mark]})
		}
		rank := "   "
		if u.Position > 0 {
			rank = fmt.Sprintf("%3d", u.Position)
		}
		yank := "   "
		if u.ID == m.yanked {
			yank = " ↕ "
		}
		points := "-"
		if u.Points > 0 {
			points = fmt.Sprintf("%g", u.Points)
		}
		cells = append(cells, cell{rank, styleText}, cell{yank, styleKey}, cell{fit(u.ID, 6) + " " + fit(u.Status, 9) + " " +
			fmt.Sprintf("%3s", points) + "  " + fit(strings.Join(u.HeldBy, ","), 7) + "  " + u.Title, styleText})
		return row(w, i == sel, cells...)
	}
	header := "Rank  Id     Status    Pts  Held by  Title"
	if staging {
		header = "  " + header
	}
	head := row(w, false, cell{header, styleDim})
	foot := row(w, false, cell{pickLine(m.snap.Next), styleText})
	return rowsAndFoot(head, len(units)+1, line, h, draw, foot, false)
}

// dividerLine is the line between box ³'s ranked and unranked units, w cells with the row's margin:
// it names the unranked units' order (F-113 Decision A1).
func dividerLine(newestFirst bool, w int) string {
	order := "oldest first"
	if newestFirst {
		order = "newest first"
	}
	label := "── not ranked · " + order + " "
	return label + strings.Repeat("─", max(w-1-lipgloss.Width(label), 0))
}

// pickLine is box ³'s line under the list: the unit `bl next` picks and its status, the ranked
// unit it unblocks when that is another.
func pickLine(n stream.Next) string {
	if n.Pick == nil {
		return "bl next → nothing can run"
	}
	line := fmt.Sprintf("bl next → %s (%s)", n.Pick.ID, n.Pick.Status)
	if n.Pick.From != "" && n.Pick.From != n.Pick.ID {
		line += " · it unblocks " + n.Pick.From
	}
	return line
}
