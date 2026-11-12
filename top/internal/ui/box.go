package ui

import (
	"cmp"
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

// keyBar draws the bottom border of the screen, w cells wide, with the notes and the sender
// warnings, styled strings (Model.warnings), at its right (`┐desktop failed: …┌─╯`, D8), and the key
// bar of keys in the room they leave (`╰┘tab box└┘h help└──╯`). The notes and the warnings come
// first: they share the bar (share), and one longer than its share is cut with `…`. A note clears
// when its job ends or at the next key, so the notes may take the whole bar. A sender warning stays
// until its sender succeeds, so with no note the sender warnings share only the room that every key
// without its label leaves: `h` and `q`, at the end, always show. When the labels do not fit, the
// bar shows the keys alone; when those do not fit either, it leaves out the keys at the end.
func keyBar(w int, keys []barKey, notes, senders []string) string {
	// `╰`, the entries, at least one `─`, the warnings, `╯`.
	room := w - 3
	if len(notes) == 0 {
		_, _, left := keyEntries(keys, w, false)
		room -= w - left
	}
	warnings := slices.Clone(notes)
	for i, n := range share(senders, room) {
		warnings = append(warnings, ansi.Truncate(senders[i], max(n, 0), "…"))
	}
	right := ""
	for i, n := range share(warnings, w-3) {
		warn := warnings[i]
		if n < 2 {
			continue
		}
		if n < lipgloss.Width(warn) {
			warn = ansi.Truncate(warn, n, "…")
		}
		right += styleBorder.Render("┐") + warn + styleBorder.Render("┌─")
	}
	rw := lipgloss.Width(right)
	bar, shown, room := keyEntries(keys, w-3-rw, true)
	if shown < len(keys) {
		bar, _, room = keyEntries(keys, w-3-rw, false)
	}
	return styleBorder.Render("╰") + bar + styleBorder.Render(strings.Repeat("─", room+1)) + right + styleBorder.Render("╯")
}

// share is the width of each warning in room cells, less the 3 border cells around each: from the
// shortest warning up, each gets its whole width when that fits an equal share of the room left,
// else that share, so a long warning never hides a short one.
func share(warnings []string, room int) []int {
	order := make([]int, len(warnings))
	for i := range order {
		order[i] = i
	}
	slices.SortStableFunc(order, func(a, b int) int {
		return cmp.Compare(lipgloss.Width(warnings[a]), lipgloss.Width(warnings[b]))
	})
	out := make([]int, len(warnings))
	left := room - 3*len(warnings)
	for k, i := range order {
		out[i] = min(lipgloss.Width(warnings[i]), left/(len(order)-k))
		left -= out[i]
	}
	return out
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
