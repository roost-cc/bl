package ui

import (
	"fmt"

	"charm.land/lipgloss/v2"

	"github.com/roost-cc/bl/top/internal/stream"
)

// updateGroup is the id of the grouped update row. An update item's id is `<repo>:<branch>`, so
// no item has this id.
const updateGroup = "update:*"

// kindTags are the attention box's tag and color of each inbox kind (D5), by the kind `bl inbox`
// writes.
var kindTags = map[string]struct {
	tag   string
	style lipgloss.Style
}{
	"runner":     {"RUN", lipgloss.NewStyle().Foreground(colorTeal)},
	"escalation": {"ESC", styleError},
	"task":       {"TASK", lipgloss.NewStyle().Foreground(colorYellow)},
	"change":     {"CHG", lipgloss.NewStyle().Foreground(colorBlue)},
	"update":     {"UPD", styleWarn},
}

// attentionRow is a row of the attention box: an inbox item, or the grouped row of updates.
type attentionRow struct {
	item    *stream.Item
	updates int // for the grouped row: how many update items it holds
}

// id is the row's id: its item's, or updateGroup.
func (r attentionRow) id() string {
	if r.item == nil {
		return updateGroup
	}
	return r.item.ID
}

// attentionRows are the attention box's rows: the inbox items in their order. In the stacked layout
// (Mockup B) two or more update items fold into one grouped row, and the items follow it while the
// group is open.
func (m Model) attentionRows() []attentionRow {
	items := m.snap.Attention.Items
	var rows, updates []attentionRow
	for i := range items {
		r := attentionRow{item: &items[i]}
		if items[i].Kind == "update" {
			updates = append(updates, r)
		} else {
			rows = append(rows, r)
		}
	}
	if !m.stacked() || len(updates) < 2 {
		return append(rows, updates...)
	}
	rows = append(rows, attentionRow{updates: len(updates)})
	if m.updatesOpen {
		rows = append(rows, updates...)
	}
	return rows
}

// drawAttention draws the attention box (D4, Mockups A and B) in w×h inner cells: a row per item
// with its kind tag, id, unit and line, and the selected item's `next:` on the last line.
func (m Model) drawAttention(w, h int) []string {
	rows := m.attentionRows()
	sel := m.selected(attentionBox)
	draw := func(i int) string {
		r := rows[i]
		if r.item == nil {
			hint := "↵ open"
			if m.updatesOpen {
				hint = "↵ close"
			}
			return row(w, i == sel, cell{"UPD   ", kindTags["update"].style},
				cell{fit(fmt.Sprintf("%d red updates", r.updates), max(w-1-6-len([]rune(hint))-1, 1)) + " ", styleText},
				cell{hint, styleDim})
		}
		tag := kindTags[r.item.Kind]
		return row(w, i == sel, cell{fit(dash(tag.tag), 5) + " ", tag.style},
			cell{fit(r.item.ID, 13) + " " + fit(r.item.Unit, 7) + " " + r.item.Line, styleText})
	}
	foot := ""
	switch {
	case sel < 0:
	case rows[sel].item == nil:
		foot = row(w, false, cell{"next: ↵ shows the updates", styleDim})
	default:
		foot = row(w, false, cell{"next: " + rows[sel].item.Next, styleDim})
	}
	head := row(w, false, cell{"Kind  Id            For     Line", styleDim})
	return rowsAndFoot(head, len(rows), sel, h, draw, foot, true)
}
