package ui

import (
	"maps"
	"slices"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// selection is the selected row of a box: its id, and its place, where the selection falls back
// to when no row has that id any more.
type selection struct {
	id    string
	index int
}

// in is the index of the selected row in ids, the ids of a box's rows: the row with the
// selection's id, else the row at its place, or the last row when there are fewer; -1 when there
// is no row.
func (s selection) in(ids []string) int {
	if i := slices.Index(ids, s.id); i >= 0 {
		return i
	}
	return min(s.index, len(ids)-1)
}

// rowIDs are the ids of box b's rows, top to bottom, as the box draws them. Only the runs, the
// attention and the next box have rows. The next box's divider is no row, so ↑ and ↓ pass over
// it.
func (m Model) rowIDs(b boxName) []string {
	if m.snap == nil {
		return nil
	}
	var ids []string
	switch b {
	case runsBox:
		for _, r := range m.snap.Runs.Rows {
			ids = append(ids, r.ID)
		}
	case attentionBox:
		for _, r := range m.attentionRows() {
			ids = append(ids, r.id())
		}
	case nextBox:
		for _, r := range m.nextUnits() {
			ids = append(ids, r.ID)
		}
	}
	return ids
}

// selected is the index of the selected row of box b, or -1.
func (m Model) selected(b boxName) int {
	return m.sel[b].in(m.rowIDs(b))
}

// keepSelection makes each box's selection the row it falls on now, after a new snapshot or a
// change of the rows: the same row while its id is still there. It writes a new map, as Update
// copies the model.
func (m *Model) keepSelection() {
	sel := map[boxName]selection{}
	maps.Copy(sel, m.sel)
	for b := range boxes {
		ids := m.rowIDs(b)
		if i := sel[b].in(ids); i >= 0 {
			sel[b] = selection{ids[i], i}
		}
	}
	m.sel = sel
}

// move selects the row dir rows below (dir 1) or above (dir -1) the selected row of the box with
// the focus, and stops at the first and the last row. It writes a new map, as Update copies the
// model.
func (m *Model) move(dir int) {
	ids := m.rowIDs(m.focus)
	if len(ids) == 0 {
		return
	}
	i := min(max(m.sel[m.focus].in(ids)+dir, 0), len(ids)-1)
	sel := map[boxName]selection{}
	maps.Copy(sel, m.sel)
	sel[m.focus] = selection{ids[i], i}
	m.sel = sel
}

// window is the index of the first of n rows to draw in room lines, so that row sel shows.
func window(n, sel, room int) int {
	return max(min(sel-room+1, n-room), 0)
}

// cell is one column of a row: its text, with the spaces after it, and its style.
type cell struct {
	text  string
	style lipgloss.Style
}

// row draws cells as a content line of w cells, after the one-cell margin. A cell that does not
// fit is cut with `…`, and the cells after it are left out. The selected row has D5's surface0
// background over its whole width.
func row(w int, selected bool, cells ...cell) string {
	paint := func(st lipgloss.Style, s string) string {
		if selected {
			st = st.Background(colorSurface0)
		}
		return st.Render(s)
	}
	out, used := paint(styleText, " "), 1
	for _, c := range cells {
		if used >= w {
			break
		}
		t := ansi.Truncate(c.text, w-used, "…")
		out += paint(c.style, t)
		used += lipgloss.Width(t)
	}
	return out + paint(styleText, strings.Repeat(" ", max(w-used, 0)))
}

// rowsAndFoot lays out a box of h lines: the header, as many of n rows as fit with the selected
// row sel among them, then the foot. The foot goes on the box's last line when bottom is true;
// else it follows the rows, after a blank line when there is room for one, as in Mockup A. draw
// draws row i.
func rowsAndFoot(header string, n, sel, h int, draw func(i int) string, foot string, bottom bool) []string {
	room := max(h-2, 0)
	lines := []string{header}
	for i := window(n, sel, room); i < n && len(lines) < 1+room; i++ {
		lines = append(lines, draw(i))
	}
	for len(lines) < h-1 && (bottom || len(lines) == n+1) {
		lines = append(lines, "")
		if !bottom {
			break
		}
	}
	return append(lines, foot)
}
