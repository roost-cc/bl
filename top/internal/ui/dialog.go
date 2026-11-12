package ui

import (
	"fmt"
	"runtime"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/roost-cc/bl/top/internal/actions"
	"github.com/roost-cc/bl/top/internal/stream"
)

// The stages of the action dialog (F-87 D7, Mockup C).
const (
	stageMenu    = iota // the row's actions; a key or ↵ picks one
	stageInput          // the text of an action with input
	stageAsk            // the exact command, and y/n
	stageRunning        // the child runs
	stageResult         // its exit code and last stderr line
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
	action  stream.Action   // the action picked
	text    string          // the typed note or reason
	refused bool            // whether ↵ refused an empty reason
	words   []string        // the command that runs or ran
	result  actions.Result
}

// actionDoneMsg is the end of an action's child command.
type actionDoneMsg struct {
	words  []string
	result actions.Result
}

// target is the selected row of the box with the focus, for an action: its id, a line about it,
// and its actions; box ⁶'s row is the run it shows. ok is false when there is no such row (the
// grouped update row is none).
func (m Model) target() (id, line string, list []stream.Action, ok bool) {
	if m.snap == nil {
		return "", "", nil, false
	}
	if m.focus == 6 {
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
	case 1:
		r := m.snap.Runs.Rows[i]
		return r.ID, runLine(r, m.snap.At), r.Actions, true
	case 2:
		if it := m.attentionRows()[i].item; it != nil {
			return it.ID, strings.Join([]string{it.ID, it.Unit, it.Line}, " · "), it.Actions, true
		}
	case 3:
		r := m.snap.Next.Ranked[i]
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

// actKey picks the action with key k of the selected row (keys r, s, o, p, g), as the menu does.
func (m Model) actKey(k string) (Model, tea.Cmd) {
	id, line, list, ok := m.target()
	if !ok {
		m.note = k + ": select a row first"
		return m, nil
	}
	for _, a := range list {
		if a.Key == k {
			m.dialog = &dialog{row: id, line: line, actions: list}
			return m.pick(a)
		}
	}
	m.note = k + ": " + id + " has no such action (a lists its actions)"
	return m, nil
}

// pick goes on with action a: to its text, else to the y/n question. Outside tmux an action that
// opens a tmux window does nothing and says `<key> needs tmux`.
func (m Model) pick(a stream.Action) (Model, tea.Cmd) {
	if a.Window != "" && getenv("TMUX") == "" {
		m.dialog = nil
		m.note = a.Key + " needs tmux"
		return m, nil
	}
	d := *m.dialog
	d.action, d.stage = a, stageAsk
	if a.Input != "" {
		d.stage = stageInput
	}
	m.dialog = &d
	return m, nil
}

// dialogKey handles a key while the dialog is open: ctrl+c quits, esc cancels (or hides a running
// command's box), and each stage takes its keys.
func (m Model) dialogKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	k := msg.String()
	if k == "ctrl+c" {
		m.dialog = nil
		return m.key(msg)
	}
	d := *m.dialog
	if k == "esc" && d.stage != stageResult {
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
			return m.pick(d.actions[d.cursor])
		default:
			for _, a := range d.actions {
				if a.Key == k {
					return m.pick(a)
				}
			}
		}
	case stageInput:
		switch {
		case k == "enter":
			if d.action.Input == "reason" && strings.TrimSpace(d.text) == "" {
				d.refused = true
			} else {
				d.text, d.stage = strings.TrimSpace(d.text), stageAsk
			}
		case k == "backspace":
			if r := []rune(d.text); len(r) > 0 {
				d.text = string(r[:len(r)-1])
			}
		case msg.Text != "":
			d.text += msg.Text
		}
	case stageAsk:
		switch k {
		case "y":
			return m.runAction(d)
		case "n":
			m.dialog = nil
			return m, nil
		}
	case stageResult:
		m.dialog = nil
		return m, nil
	}
	m.dialog = &d
	return m, nil
}

// runAction runs the action of d after its y: in a new tmux window, or as a child whose result box
// follows. A stop marks its run, so the run's `stopped` end does not notify (D8).
func (m Model) runAction(d dialog) (Model, tea.Cmd) {
	words := actions.Words(d.action, d.text, goos)
	argv := actions.Argv(words, m.blArgv)
	if d.action.Window != "" {
		m.dialog = nil
		return m, tmuxWindow(d.action.Window, argv)
	}
	if d.action.Stops != "" {
		m.differ.Quiet(d.action.Stops)
	}
	d.stage, d.words = stageRunning, words
	m.dialog = &d
	return m, func() tea.Msg { return actionDoneMsg{words: words, result: actions.Run(argv)} }
}

// actionDone shows the result box of a child that ended, over any dialog.
func (m Model) actionDone(msg actionDoneMsg) Model {
	m.dialog = &dialog{stage: stageResult, words: msg.words, result: msg.result}
	return m
}

// command is the command of action a as the menu and the questions show it: its words with the
// text, and `(new tmux window)` for a window. The menu, before there is text, shows `[note]` or
// `<reason>` in its place.
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
			lines = append(lines, styleText.Render(pad(mark))+styleKey.Render(a.Key)+styleText.Render("  "+fit(a.Label, lw)+"  "+command(a, "", true)))
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
		lines = append(lines, "", text("runs: "+command(d.action, d.text, false)), "", keys("enter", "go on", "esc", "cancel"))
	case stageAsk:
		title = actions.Show(actions.Words(d.action, "", goos))
		lines = append(lines, text(d.line))
		for _, l := range d.action.About {
			lines = append(lines, text(l))
		}
		lines = append(lines, "", text("runs: "+command(d.action, d.text, false)), "", keys("y", d.action.Label, "n", "cancel"))
	case stageRunning:
		title = "running"
		lines = append(lines, text(actions.Show(d.words)), styleDim.Render(pad("running · esc hides this box; its result shows when it ends")))
	case stageResult:
		title = "done"
		mark, style := "✓", styleOK
		if d.result.Code != 0 {
			title, mark, style = "failed", "✗", styleError
		}
		last := d.result.Last
		if last == "" {
			last = "(none)"
		}
		lines = append(lines, style.Render(pad(mark+" "))+styleText.Render(actions.Show(d.words)+fmt.Sprintf("   exit %d", d.result.Code)),
			text("stderr: "+last), "", styleDim.Render(pad("any key to close")))
	}
	lines = append(lines, "")
	bw := dialogWidth
	for _, l := range lines {
		bw = max(bw, lipgloss.Width(l)+3)
	}
	return drawBox(0, title, nil, true, lines, min(bw, w), len(lines)+2)
}
