package ui

import (
	"cmp"
	"fmt"
	"slices"
	"strings"
)

// The screen sizes of D4: the full layout from fullWidth×fullHeight, the stacked one below it, and
// the size message below minWidth×minHeight.
const (
	fullWidth   = 171
	fullHeight  = 50
	minWidth    = 80
	minHeight   = 24
	sizeMessage = "bl top needs at least 80x24"
)

// boxName is a box's name, which is its identity (F-127 Decision 1). Its number is its position
// in the layout that is drawn (Model.number).
type boxName string

// The boxes of D4, by purpose.
const (
	runsBox      boxName = "runs"
	attentionBox boxName = "attention"
	nextBox      boxName = "next"
	tokensBox    boxName = "tokens"
	activityBox  boxName = "activity"
	detailBox    boxName = "detail"
)

// box is one of D4's boxes: the snapshot sections it draws, the option at the right of its top
// border, and the drawer of its content in its inner w×h cells, which runs once there is a
// snapshot. A section whose last read failed puts a red `!` and its error in the box's top border.
type box struct {
	sections []string
	option   string
	draw     func(m Model, w, h int) []string
}

// boxes are D4's boxes by name. The detail box's option is the id of the run it shows (boxLines).
var boxes = map[boxName]box{
	runsBox:      {sections: []string{"runs"}, draw: Model.drawRuns},
	attentionBox: {sections: []string{"attention"}, draw: Model.drawAttention},
	nextBox:      {sections: []string{"next"}, option: "bl next", draw: Model.drawNext},
	tokensBox: {sections: []string{"tokens", "capacity"}, option: "2h", draw: func(m Model, w, h int) []string {
		return drawTokens(m.snap, w, h)
	}},
	activityBox: {sections: []string{"activity", "history"}, option: "30d", draw: func(m Model, w, h int) []string {
		return drawActivity(m.snap, w, h)
	}},
	detailBox: {sections: []string{"runs"}, draw: Model.drawDetail},
}

// node is a box (box not empty), or a split of nodes side by side (across) or stacked. Each node
// takes its weight's share of its parent's width (across) or height. A hidden box takes none: its
// share goes to the nodes left in its split.
type node struct {
	box      boxName
	weight   int
	across   bool
	children []node
}

// fullLayout is Mockup A: the weights are the mockup's widths and heights at 171×63.
var fullLayout = node{across: true, children: []node{
	{weight: 106, children: []node{{box: runsBox, weight: 13}, {box: detailBox, weight: 24}, {box: nextBox, weight: 26}}},
	{weight: 65, children: []node{{box: attentionBox, weight: 13}, {box: tokensBox, weight: 24}, {box: activityBox, weight: 26}}},
}}

// stackedLayout is Mockup B, with the detail box under the attention box and the next box at the
// bottom (F-127 Decision 1): each box keeps the mockup's height at 100×40, and the tokens and
// activity boxes their widths.
var stackedLayout = node{children: []node{
	{box: runsBox, weight: 7},
	{box: attentionBox, weight: 9},
	{box: detailBox, weight: 7},
	{weight: 9, across: true, children: []node{{box: tokensBox, weight: 48}, {box: activityBox, weight: 52}}},
	{box: nextBox, weight: 8},
}}

// layout is the layout tree that is drawn: the full layout, or the stacked one on a smaller
// screen.
func (m Model) layout() node {
	if m.stacked() {
		return stackedLayout
	}
	return fullLayout
}

// conflictLine is the red line at the top of the screen while the staged copy is in conflict
// (F-113 Decision A3), or no line. The layout is drawn under it, so render and order both take
// their height from it.
func (m Model) conflictLine() []string {
	if m.snap == nil || m.snap.Next.Conflict == "" {
		return nil
	}
	return []string{styleError.Render(fit(" ! "+m.snap.Next.Conflict, m.width))}
}

// order is the boxes of the drawn layout left to right, then top to bottom: each box's top-left
// cell in the cells the layout is drawn in (under the conflict line), as if no box were hidden,
// sorted by its row and then its column. It gives each box its number and the Tab order (F-127
// Decisions 1 and 3).
func (m Model) order() []boxName {
	type place struct {
		box      boxName
		row, col int
	}
	var places []place
	var walk func(n node, row, col, w, h int)
	walk = func(n node, row, col, w, h int) {
		if n.box != "" {
			places = append(places, place{n.box, row, col})
			return
		}
		weights := make([]int, len(n.children))
		for i, c := range n.children {
			weights[i] = c.weight
		}
		total := h
		if n.across {
			total = w
		}
		for i, size := range split(total, weights) {
			if n.across {
				walk(n.children[i], row, col, size, h)
				col += size
			} else {
				walk(n.children[i], row, col, w, size)
				row += size
			}
		}
	}
	walk(m.layout(), 0, 0, m.width, m.height-len(m.conflictLine()))
	slices.SortStableFunc(places, func(a, b place) int {
		return cmp.Or(cmp.Compare(a.row, b.row), cmp.Compare(a.col, b.col))
	})
	out := make([]boxName, len(places))
	for i, p := range places {
		out[i] = p.box
	}
	return out
}

// number is box b's number: its position in the drawn layout (order), from 1.
func (m Model) number(b boxName) int {
	return slices.Index(m.order(), b) + 1
}

// shown reports whether n holds a box that is not hidden.
func (m Model) shown(n node) bool {
	if n.box != "" {
		return !m.hidden[n.box]
	}
	for _, c := range n.children {
		if m.shown(c) {
			return true
		}
	}
	return false
}

// split cuts total into parts by weight, rounding at each running sum, so the parts add up to
// total.
func split(total int, weights []int) []int {
	sum := 0
	for _, w := range weights {
		sum += w
	}
	parts := make([]int, len(weights))
	cum, edge := 0, 0
	for i, w := range weights {
		cum += w
		next := (total*cum + sum/2) / sum
		parts[i], edge = next-edge, next
	}
	return parts
}

// draw draws n in w×h cells as h lines.
func (m Model) draw(n node, w, h int) []string {
	if n.box != "" {
		return m.boxLines(n.box, w, h)
	}
	var kids []node
	var weights []int
	for _, c := range n.children {
		if m.shown(c) {
			kids = append(kids, c)
			weights = append(weights, c.weight)
		}
	}
	if len(kids) == 0 {
		return blank(w, h)
	}
	var lines []string
	if n.across {
		lines = make([]string, h)
		for i, size := range split(w, weights) {
			for r, line := range m.draw(kids[i], size, h) {
				lines[r] += line
			}
		}
		return lines
	}
	for i, size := range split(h, weights) {
		lines = append(lines, m.draw(kids[i], w, size)...)
	}
	return lines
}

// boxLines draws box name with its number: the error of its first section that failed, then its
// options, and its content once there is a snapshot.
func (m Model) boxLines(name boxName, w, h int) []string {
	b := boxes[name]
	var options []string
	if m.snap != nil {
		for _, name := range b.sections {
			if e := m.snap.Section(name).Error; e != "" {
				options = append(options, styleError.Render("! "+strings.Join(strings.Fields(e), " ")))
				break
			}
		}
	}
	if name == runsBox {
		if m.snap != nil {
			options = append(options, styleText.Render(m.snap.At.Local().Format("15:04:05")))
		}
		options = append(options, styleKey.Render("-")+styleText.Render(fmt.Sprintf(" %dms ", m.interval))+styleKey.Render("+"))
	}
	if b.option != "" {
		options = append(options, styleText.Render(b.option))
	}
	if name == detailBox && m.detail != "" {
		options = append(options, styleText.Render(m.detail))
	}
	title := string(name)
	if name == nextBox && m.snap != nil && m.snap.Next.Staged != nil {
		// F-113 D4: the operator sees that staged edits exist, also without the focus.
		title += " · staged edits"
	}
	var content []string
	if m.snap != nil && b.draw != nil {
		content = b.draw(m, w-2, h-2)
	}
	return drawBox(m.number(name), title, options, m.focus == name, content, w, h)
}

// blank is h lines of w spaces.
func blank(w, h int) []string {
	lines := make([]string, h)
	for i := range lines {
		lines[i] = strings.Repeat(" ", w)
	}
	return lines
}

// stacked reports whether the screen is below the full layout's size, so the boxes stack as in
// Mockup B.
func (m Model) stacked() bool {
	return m.width < fullWidth || m.height < fullHeight
}

// render draws the screen: the size message on a small terminal; else the conflict line while the
// staged copy is in conflict (F-113 Decision A3), the layout for its size under it, the key bar in
// its bottom line, and the help over it when it is open.
func (m Model) render() string {
	if m.width == 0 {
		return ""
	}
	if m.width < minWidth || m.height < minHeight {
		return sizeMessage
	}
	layout := m.layout()
	top := m.conflictLine()
	h := m.height - len(top)
	lines := blank(m.width, h)
	if m.shown(layout) {
		lines = m.draw(layout, m.width, h)
	}
	lines = append(top, lines...)
	lines[len(lines)-1] = keyBar(m.width, m.barKeys(), m.warnings())
	if m.dialog != nil {
		lines = overlay(lines, m.dialogBox(m.width))
	}
	if m.help {
		lines = overlay(lines, m.helpBox(m.width, m.height))
	}
	return strings.Join(lines, "\n")
}
