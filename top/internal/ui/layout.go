package ui

import (
	"fmt"
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

// box is one of D4's boxes: its number and name, the snapshot sections it draws, the option at
// the right of its top border, and the drawer of its content in its inner w×h cells, which runs
// once there is a snapshot. A section whose last read failed puts a red `!` and its error in the
// box's top border.
type box struct {
	name     string
	sections []string
	option   string
	draw     func(m Model, w, h int) []string
}

// boxes are D4's boxes by number. Box ⁶'s option is the id of the run it shows (boxLines).
var boxes = map[int]box{
	1: {name: "runs", sections: []string{"runs"}, draw: Model.drawRuns},
	2: {name: "attention", sections: []string{"attention"}, draw: Model.drawAttention},
	3: {name: "next", sections: []string{"next"}, option: "bl next", draw: Model.drawNext},
	4: {name: "tokens", sections: []string{"tokens", "capacity"}, option: "2h", draw: func(m Model, w, h int) []string {
		return drawTokens(m.snap, w, h)
	}},
	5: {name: "activity", sections: []string{"activity", "history"}, option: "30d", draw: func(m Model, w, h int) []string {
		return drawActivity(m.snap, w, h)
	}},
	6: {name: "detail", sections: []string{"runs"}, draw: Model.drawDetail},
}

// node is a box (box > 0), or a split of nodes side by side (across) or stacked. Each node takes
// its weight's share of its parent's width (across) or height. A hidden box takes none: its share
// goes to the nodes left in its split.
type node struct {
	box      int
	weight   int
	across   bool
	children []node
}

// fullLayout is Mockup A: the weights are the mockup's widths and heights at 171×63.
var fullLayout = node{across: true, children: []node{
	{weight: 106, children: []node{{box: 1, weight: 13}, {box: 6, weight: 24}, {box: 3, weight: 26}}},
	{weight: 65, children: []node{{box: 2, weight: 13}, {box: 4, weight: 24}, {box: 5, weight: 26}}},
}}

// stackedLayout is Mockup B: the weights are the mockup's heights and widths at 100×40.
var stackedLayout = node{children: []node{
	{box: 1, weight: 7},
	{box: 2, weight: 9},
	{box: 3, weight: 8},
	{weight: 9, across: true, children: []node{{box: 4, weight: 48}, {box: 5, weight: 52}}},
	{box: 6, weight: 7},
}}

// shown reports whether n holds a box that is not hidden.
func (m Model) shown(n node) bool {
	if n.box > 0 {
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
	if n.box > 0 {
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

// boxLines draws box num: the error of its first section that failed, then its options, and its
// content once there is a snapshot.
func (m Model) boxLines(num, w, h int) []string {
	b := boxes[num]
	var options []string
	if m.snap != nil {
		for _, name := range b.sections {
			if e := m.snap.Section(name).Error; e != "" {
				options = append(options, styleError.Render("! "+strings.Join(strings.Fields(e), " ")))
				break
			}
		}
	}
	if num == 1 {
		if m.snap != nil {
			options = append(options, styleText.Render(m.snap.At.Local().Format("15:04:05")))
		}
		options = append(options, styleKey.Render("-")+styleText.Render(fmt.Sprintf(" %dms ", m.interval))+styleKey.Render("+"))
	}
	if b.option != "" {
		options = append(options, styleText.Render(b.option))
	}
	if num == 6 && m.detail != "" {
		options = append(options, styleText.Render(m.detail))
	}
	var content []string
	if m.snap != nil && b.draw != nil {
		content = b.draw(m, w-2, h-2)
	}
	return drawBox(num, b.name, options, m.focus == num, content, w, h)
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

// render draws the screen: the size message on a small terminal; else the layout for its size,
// the key bar in its bottom line, and the help over it when it is open.
func (m Model) render() string {
	if m.width == 0 {
		return ""
	}
	if m.width < minWidth || m.height < minHeight {
		return sizeMessage
	}
	layout := fullLayout
	if m.stacked() {
		layout = stackedLayout
	}
	lines := blank(m.width, m.height)
	if m.shown(layout) {
		lines = m.draw(layout, m.width, m.height)
	}
	lines[len(lines)-1] = keyBar(m.width, m.warnings())
	if m.dialog != nil {
		lines = overlay(lines, m.dialogBox(m.width))
	}
	if m.help {
		lines = overlay(lines, helpBox())
	}
	return strings.Join(lines, "\n")
}
