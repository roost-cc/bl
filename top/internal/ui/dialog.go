package ui

import (
	"errors"
	"fmt"
	"runtime"
	"slices"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/roost-cc/bl/top/internal/actions"
	"github.com/roost-cc/bl/top/internal/stream"
)

// The stages of the action dialog (F-87 D7, Mockup C), its only two (F-127 Decision 2).
const (
	stageMenu  = iota // the row's actions; a key or ↵ picks one
	stageInput        // the text of an action with input
)

// dialogWidth is the dialog's width, as in Mockup C, when the screen and its lines allow.
const dialogWidth = 60

// goos is the system the view runs on, which picks the command that opens a URL; a test replaces
// it.
var goos = runtime.GOOS

// dialog is the action dialog over the screen.
type dialog struct {
	stage   int
	row     string          // the selected row's id
	line    string          // a line about the row
	actions []stream.Action // the row's actions (the menu)
	cursor  int             // the menu's selected action
	action  stream.Action   // the action picked, its argv rendered
	text    string          // the typed note or reason
	refused bool            // whether ↵ refused an empty reason
	puts    bool            // whether the action puts the yanked unit (its argv takes Yanked)
}

// target is the selected row of the box with the focus, for an action: its id, a line about it,
// and its actions; the detail box's row is the run it shows. ok is false when there is no such row
// (the grouped update row is none).
func (m Model) target() (id, line string, list []stream.Action, ok bool) {
	if m.snap == nil {
		return "", "", nil, false
	}
	if m.focus == detailBox {
		if r := m.run(m.detail); r != nil {
			return r.ID, runLine(*r, m.snap.At), r.Actions, true
		}
		return "", "", nil, false
	}
	i := m.selected(m.focus)
	if i < 0 {
		return "", "", nil, false
	}
	switch m.focus {
	case runsBox:
		r := m.snap.Runs.Rows[i]
		return r.ID, runLine(r, m.snap.At), r.Actions, true
	case attentionBox:
		if it := m.attentionRows()[i].item; it != nil {
			return it.ID, strings.Join([]string{it.ID, it.Unit, it.Line}, " · "), it.Actions, true
		}
	case nextBox:
		r := m.nextUnits()[i]
		return r.ID, strings.Join([]string{r.ID, r.Status, r.Title}, " · "), r.Actions, true
	}
	return "", "", nil, false
}

// runLine is a line about a run: a live run's step, agent and time in its stage (Mockup C), or
// another run's status and step.
func runLine(r stream.Run, now time.Time) string {
	if r.Status != "running" {
		return strings.Join(strings.Fields(r.ID+" · "+dash(r.Status)+" · "+dash(r.Step)), " ")
	}
	step := r.Step
	if r.Round > 0 {
		step += fmt.Sprintf(" r%d", r.Round)
	}
	in := elapsed(r, now)
	for _, s := range r.Timeline {
		if s.State == "current" && s.DurationMs != nil {
			in = duration(time.Duration(*s.DurationMs) * time.Millisecond)
		}
	}
	line := r.ID + " is in " + step
	if who := strings.Join(strings.Fields(r.Agent+" "+r.Model), " "); who != "" {
		line += " (" + who + ")"
	}
	return line + ", " + in + " in."
}

// openMenu opens the action menu of the selected row (key a).
func (m Model) openMenu() (Model, tea.Cmd) {
	id, line, list, ok := m.target()
	switch {
	case !ok:
		m.note = "a: select a row first"
	case len(list) == 0:
		m.note = "a: " + id + " has no actions"
	default:
		m.dialog = &dialog{stage: stageMenu, row: id, line: line, actions: list}
	}
	return m, nil
}

// actKey picks the action with key k of the selected row, as the menu does (F-127, "Three kinds of
// keys"). A key that none of the row's actions has does nothing: the key bar shows the row's keys.
func (m Model) actKey(k string) (Model, tea.Cmd) {
	id, _, list, _ := m.target()
	if i := slices.IndexFunc(list, func(a stream.Action) bool { return a.Key == k }); i >= 0 {
		return m.pick(list[i], id)
	}
	return m, nil
}

// yankFirst is the refusal of an action that puts the yanked unit while none is yanked (F-113 D7).
const yankFirst = "yank a work unit first (y)"

// renderAction is action a with its argv templates rendered for the row selected (F-113 D7): with its id,
// and the yanked unit's id while one is yanked. puts says whether the argv took the yanked unit. A
// template that needs the yanked unit while none is yanked fails with yankFirst.
func (m Model) renderAction(a stream.Action, selected string) (out stream.Action, puts bool, err error) {
	vars := map[string]string{"Selected": selected}
	argv, err := actions.Render(a.Argv, vars)
	if err != nil && m.yanked == "" {
		return a, false, errors.New(yankFirst)
	}
	if err != nil {
		vars["Yanked"] = m.yanked
		if argv, err = actions.Render(a.Argv, vars); err != nil {
			return a, false, err
		}
		puts = true
	}
	a.Argv = argv
	return a, puts, nil
}

// rankKey handles a ranking key of the next box (F-113 D6): y yanks the selected unit and esc
// cancels the yank; p, P, x, C and R pick the action of that key, the selected row's or else the
// box's (next.actions). A key with no such action does nothing. While the staged copy is in
// conflict, every key but R refuses with the conflict's text (Decision A3).
func (m Model) rankKey(k string) (Model, tea.Cmd) {
	if m.snap == nil {
		return m, nil
	}
	if c := m.snap.Next.Conflict; c != "" && k != "R" {
		m.note = c
		return m, nil
	}
	switch k {
	case "y":
		if id := m.selectedUnit(nextBox); id != "" {
			m.yanked = id
		}
		return m, nil
	case "esc":
		m.yanked = ""
		return m, nil
	}
	id, _, list, _ := m.target()
	if i := slices.IndexFunc(list, func(a stream.Action) bool { return a.Key == k }); i >= 0 {
		return m.pick(list[i], id)
	}
	// The box's own actions are about no row.
	if i := slices.IndexFunc(m.snap.Next.Actions, func(a stream.Action) bool { return a.Key == k }); i >= 0 {
		return m.pick(m.snap.Next.Actions[i], "")
	}
	return m, nil
}

// pick runs action a of row at once (F-127 Decision 2), its argv rendered (renderAction): a menu
// pick, a row action key and a ranking key all come here. It closes the dialog. An action with
// input opens its text box first. An argv that does not render says why on the note line. Outside
// tmux an action that opens a tmux window does nothing and says `<key> needs tmux`.
func (m Model) pick(a stream.Action, row string) (Model, tea.Cmd) {
	m.dialog = nil
	if a.Window != "" && getenv("TMUX") == "" {
		m.note = a.Key + " needs tmux"
		return m, nil
	}
	a, puts, err := m.renderAction(a, row)
	if err != nil {
		m.note = err.Error()
		return m, nil
	}
	if a.Input != "" {
		m.dialog = &dialog{stage: stageInput, action: a, puts: puts}
		return m, nil
	}
	return m.act(a, "", puts)
}

// act queues action a, its argv rendered, with text as its last word (enqueue). A put ends the yank
// at once: the put took the yanked id when it was rendered.
func (m Model) act(a stream.Action, text string, puts bool) (Model, tea.Cmd) {
	if puts {
		m.yanked = ""
	}
	return m.enqueue(m.jobOf(a, text))
}

// dialogKey handles a key while the dialog is open: ctrl+c quits, esc cancels, and each stage takes
// its keys.
func (m Model) dialogKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	k := msg.String()
	if k == "ctrl+c" {
		m.dialog = nil
		return m.key(msg)
	}
	d := *m.dialog
	if k == "esc" {
		m.dialog = nil
		return m, nil
	}
	switch d.stage {
	case stageMenu:
		switch k {
		case "up":
			d.cursor = max(d.cursor-1, 0)
		case "down":
			d.cursor = min(d.cursor+1, len(d.actions)-1)
		case "enter":
			return m.pick(d.actions[d.cursor], d.row)
		default:
			for _, a := range d.actions {
				if a.Key == k {
					return m.pick(a, d.row)
				}
			}
		}
	case stageInput:
		switch {
		case k == "enter":
			if d.action.Input != "reason" || strings.TrimSpace(d.text) != "" {
				m.dialog = nil
				return m.act(d.action, strings.TrimSpace(d.text), d.puts)
			}
			d.refused = true
		case k == "backspace":
			if r := []rune(d.text); len(r) > 0 {
				d.text = string(r[:len(r)-1])
			}
		case msg.Text != "":
			d.text += msg.Text
		}
	}
	m.dialog = &d
	return m, nil
}

// command is the command of action a as the menu, the input box and the note line show it: its
// words with the text, and `(new tmux window)` for a window. The menu, before there is text, shows
// `[note]` or `<reason>` in its place.
func command(a stream.Action, text string, menu bool) string {
	s := actions.Show(actions.Words(a, text, goos))
	if menu {
		switch a.Input {
		case "note":
			s += " [note]"
		case "reason":
			s += " <reason>"
		}
	}
	if a.Window != "" {
		s += "  (new tmux window)"
	}
	return s
}

// dialogBox draws the dialog (Mockup C), at most w cells wide.
func (m Model) dialogBox(w int) []string {
	d := m.dialog
	pad := func(s string) string { return "  " + s }
	text := func(s string) string { return styleText.Render(pad(s)) }
	keys := func(pairs ...string) string {
		var parts []string
		for i := 0; i+1 < len(pairs); i += 2 {
			parts = append(parts, styleKey.Render(pairs[i])+styleText.Render("  "+pairs[i+1]))
		}
		return pad(strings.Join(parts, "     "))
	}
	var title string
	lines := []string{""}
	switch d.stage {
	case stageMenu:
		title = "act on " + d.row
		lines = append(lines, text(d.line), "")
		lw := 0
		for _, a := range d.actions {
			lw = max(lw, lipgloss.Width(a.Label))
		}
		for i, a := range d.actions {
			mark := "  "
			if i == d.cursor {
				mark = "▶ "
			}
			// An action that cannot render yet (a put with nothing yanked) shows why in place of its command.
			cmd := yankFirst
			if r, _, err := m.renderAction(a, d.row); err == nil {
				cmd = command(r, "", true)
			}
			lines = append(lines, styleText.Render(pad(mark))+styleKey.Render(a.Key)+styleText.Render("  "+fit(a.Label, lw)+"  "+cmd))
		}
		lines = append(lines, "", keys("↑↓ ↵", "pick", "esc", "cancel"))
	case stageInput:
		title = actions.Show(actions.Words(d.action, "", goos))
		prompt := "note (optional, enter to skip):"
		if d.action.Input == "reason" {
			prompt = "reason (needed):"
		}
		lines = append(lines, text(prompt), text("> "+d.text+"_"))
		if d.refused {
			lines = append(lines, styleError.Render(pad("a reason is needed")))
		}
		lines = append(lines, "", text("runs: "+command(d.action, d.text, false)), "", keys("enter", "run", "esc", "cancel"))
	}
	lines = append(lines, "")
	bw := dialogWidth
	for _, l := range lines {
		bw = max(bw, lipgloss.Width(l)+3)
	}
	return drawBox(0, title, nil, true, lines, min(bw, w), len(lines)+2)
}
