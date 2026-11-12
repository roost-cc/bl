package ui

import (
	"slices"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// superscript is a box number as btop writes it in the top border. A box with no number (the
// help) has number 0.
var superscript = []string{"", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"}

// drawBox draws one box of w×h cells as h lines (D5): rounded corners, the number and name at the
// left of the top border (`╭─┐¹runs┌──`), and each option at its right (`┐- 2000ms +┌─╮`).
// Options are styled strings. An option that does not fit is cut with `…`, and the options after
// it are left out. Each content line is cut with `…` to the box's inner width.
func drawBox(num int, name string, options []string, focus bool, content []string, w, h int) []string {
	border := styleBorder
	if focus {
		border = styleFocus
	}
	title := styleName.Render(superscript[num] + name)
	// `╭─┐` title `┌`, at least one `─`, then `┐` option `┌─` for each option, then `╮`.
	room := w - 4 - lipgloss.Width(title) - 1 - 1
	right := ""
	for _, opt := range options {
		ow := lipgloss.Width(opt)
		if 3+ow > room {
			if room-3 < 2 {
				break
			}
			opt, ow = ansi.Truncate(opt, room-3, "…"), room-3
		}
		right += border.Render("┐") + opt + border.Render("┌─")
		room -= 3 + ow
	}
	fill := w - 4 - lipgloss.Width(title) - lipgloss.Width(right) - 1
	lines := make([]string, 0, h)
	lines = append(lines, border.Render("╭─┐")+title+border.Render("┌"+strings.Repeat("─", fill))+right+border.Render("╮"))
	side := border.Render("│")
	for i := range h - 2 {
		line := ""
		if i < len(content) {
			line = ansi.Truncate(content[i], w-2, "…")
		}
		lines = append(lines, side+line+strings.Repeat(" ", w-2-lipgloss.Width(line))+side)
	}
	return append(lines, border.Render("╰"+strings.Repeat("─", w-2)+"╯"))
}

// barKey is one entry of the key bar: a key and what it does, in a word.
type barKey struct{ key, label string }

// barKeys are the keys the key bar shows (F-127 Decision 5): the box keys of the box with the
// focus, then the keys of the selected row's actions by their short label, then the global keys
// that have a word on the bar. A row action key that is also a box key or a global key shows once,
// as that key. The help overlay lists every key.
func (m Model) barKeys() []barKey {
	own, global := m.boxKeys(), groupKeys("")
	var out []barKey
	for _, k := range own {
		out = append(out, barKey{k.Help().Key, k.short})
	}
	_, _, list, _ := m.target()
	for _, a := range list {
		if !bound(a.Key, own) && !bound(a.Key, global) && !slices.ContainsFunc(out, func(b barKey) bool { return b.key == a.Key }) {
			out = append(out, barKey{a.Key, a.Short})
		}
	}
	for _, k := range global {
		if k.short != "" {
			out = append(out, barKey{k.Help().Key, k.short})
		}
	}
	return out
}

// keyBar draws the bottom border of the screen, w cells wide, with the key bar of keys in it
// (`╰┘tab box└┘h help└──╯`), and the warnings, styled strings (Model.warnings), at its right
// (`┐desktop failed: …┌─╯`, D8). When the labels do not fit, it shows the keys alone; when those do
// not fit either, it leaves out the keys at the end. The warnings come before the labels: they take
// the room the keys alone leave, and a warning that does not fit is cut with `…`.
func keyBar(w int, keys []barKey, warnings []string) string {
	// `╰`, the entries, at least one `─`, the warnings, `╯`.
	_, _, room := keyEntries(keys, w-3, false)
	right := ""
	for _, warn := range warnings {
		if room-3 < 2 {
			break
		}
		if 3+lipgloss.Width(warn) > room {
			warn = ansi.Truncate(warn, room-3, "…")
		}
		right += styleBorder.Render("┐") + warn + styleBorder.Render("┌─")
		room -= 3 + lipgloss.Width(warn)
	}
	rw := lipgloss.Width(right)
	bar, shown, room := keyEntries(keys, w-3-rw, true)
	if shown < len(keys) {
		bar, _, room = keyEntries(keys, w-3-rw, false)
	}
	return styleBorder.Render("╰") + bar + styleBorder.Render(strings.Repeat("─", room+1)) + right + styleBorder.Render("╯")
}

// keyEntries draws the keys that fit in room cells, each as `┘key label└`, or `┘key└` without
// labels. It returns them, how many fit, and the room left.
func keyEntries(keys []barKey, room int, labels bool) (string, int, int) {
	bar := ""
	for i, k := range keys {
		entry := styleKey.Render(k.key)
		if labels {
			entry += styleText.Render(" " + k.label)
		}
		ew := lipgloss.Width(entry) + 2
		if ew > room {
			return bar, i, room
		}
		bar += styleBorder.Render("┘") + entry + styleBorder.Render("└")
		room -= ew
	}
	return bar, len(keys), room
}
