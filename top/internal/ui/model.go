package ui

import (
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/roost-cc/bl/top/internal/notify"
	"github.com/roost-cc/bl/top/internal/stream"
	"github.com/roost-cc/bl/top/internal/watch"
)

// The refresh interval's bounds and step for `+` and `-`, in ms (D6). src/top.js refuses an
// --interval outside the same bounds.
const (
	minInterval  = 500
	maxInterval  = 10000
	intervalStep = 500
)

// restartDelay is how long the stream waits after the last `+` or `-` before it starts again
// with the new interval, so that a run of presses starts one stream, not one per press.
const restartDelay = 400 * time.Millisecond

// keyMap holds the keys of D6 that bl top has, and the next box's ranking keys (F-113 D6). The
// help overlay lists them.
type keyMap struct {
	boxes, next, prev, move, open, act, run, stop, page, pr, agent, follow, watch, order, capacity, longer, shorter, help, quit key.Binding

	yank, after, before, unrank, cancel, commit, reset key.Binding
}

var keys = keyMap{
	boxes: key.NewBinding(key.WithKeys("1", "2", "3", "4", "5", "6"), key.WithHelp("1-6", "hide or show the box at that position")),
	next:  key.NewBinding(key.WithKeys("tab"), key.WithHelp("tab", "move the focus to the next box")),
	prev:  key.NewBinding(key.WithKeys("shift+tab"), key.WithHelp("⇧tab", "move the focus to the previous box")),
	move: key.NewBinding(key.WithKeys("up", "down"),
		key.WithHelp("↑↓", "select a row; in the detail box with follow off, scroll the feed")),
	open: key.NewBinding(key.WithKeys("enter"),
		key.WithHelp("↵", "show the selected run in the detail box; open the update group")),
	act:      key.NewBinding(key.WithKeys("a"), key.WithHelp("a", "open the action menu of the selected row")),
	run:      key.NewBinding(key.WithKeys("r"), key.WithHelp("r", "start or resume the selected run (bl run, in a tmux window)")),
	stop:     key.NewBinding(key.WithKeys("s"), key.WithHelp("s", "stop the selected run (bl stop)")),
	page:     key.NewBinding(key.WithKeys("o"), key.WithHelp("o", "open the selected row's page (bl view, in a tmux window)")),
	pr:       key.NewBinding(key.WithKeys("p"), key.WithHelp("p", "open the selected run's pull request")),
	agent:    key.NewBinding(key.WithKeys("g"), key.WithHelp("g", "open bl agent in a tmux window")),
	follow:   key.NewBinding(key.WithKeys("f"), key.WithHelp("f", "follow the feed on or off")),
	watch:    key.NewBinding(key.WithKeys("w"), key.WithHelp("w", "open bl watch of the run in a tmux window")),
	order:    key.NewBinding(key.WithKeys("d"), key.WithHelp("d", "show the unranked units newest or oldest first")),
	capacity: key.NewBinding(key.WithKeys("c"), key.WithHelp("c", "read capacity now")),
	longer:   key.NewBinding(key.WithKeys("+"), key.WithHelp("+", fmt.Sprintf("refresh interval up (to %d s)", maxInterval/1000))),
	shorter:  key.NewBinding(key.WithKeys("-"), key.WithHelp("-", fmt.Sprintf("refresh interval down (to %d ms)", minInterval))),
	help:     key.NewBinding(key.WithKeys("h"), key.WithHelp("h", "show or hide this help")),
	quit:     key.NewBinding(key.WithKeys("q", "ctrl+c"), key.WithHelp("q", "quit")),
	yank:     key.NewBinding(key.WithKeys("y"), key.WithHelp("y", "yank the selected unit")),
	after:    key.NewBinding(key.WithKeys("p"), key.WithHelp("p", "put the yanked unit after the selected ranked unit")),
	before:   key.NewBinding(key.WithKeys("P"), key.WithHelp("P", "put the yanked unit before the selected ranked unit")),
	unrank:   key.NewBinding(key.WithKeys("x"), key.WithHelp("x", "unrank the selected ranked unit")),
	cancel:   key.NewBinding(key.WithKeys("esc"), key.WithHelp("esc", "cancel the yank")),
	commit:   key.NewBinding(key.WithKeys("C"), key.WithHelp("C", "commit the staged edits (bl rank --commit)")),
	reset:    key.NewBinding(key.WithKeys("R"), key.WithHelp("R", "drop the staged edits (bl rank --reset)")),
}

// helpGroups are the help overlay's keys: the keys of every box (no box name), then each box's
// own keys under that box.
var helpGroups = []struct {
	box  boxName
	keys []key.Binding
}{
	{"", []key.Binding{keys.boxes, keys.next, keys.prev, keys.move, keys.open, keys.act, keys.run, keys.stop, keys.page, keys.pr,
		keys.agent, keys.capacity, keys.longer, keys.shorter, keys.help, keys.quit}},
	{nextBox, []key.Binding{keys.yank, keys.after, keys.before, keys.unrank, keys.cancel, keys.commit, keys.reset, keys.order}},
	{detailBox, []key.Binding{keys.follow, keys.watch}},
}

// startedMsg carries a stream that has started.
type startedMsg struct{ s *stream.Stream }

// restartMsg comes restartDelay after the press-th `+` or `-`.
type restartMsg struct{ press int }

// Model is bl top's screen. It draws the newest snapshot of the stream that it started.
type Model struct {
	blArgv        []string
	interval      int
	width, height int
	// hidden holds the hidden boxes, and sel the selected row of the runs, attention and next
	// boxes. Update copies Model, so a change to either writes a new map.
	hidden      map[boxName]bool
	sel         map[boxName]selection
	focus       boxName      // the box with the focus; empty when every box is hidden
	updatesOpen bool         // whether the attention box's grouped update row is open
	newestFirst bool         // whether the next box shows the unranked units newest `added:` first (d)
	yanked      string       // the id of the unit yanked in the next box (y), until a put or esc; or empty
	detail      string       // the id of the run the detail box shows; empty for none
	watcher     *watch.Watch // the `bl watch` of that run, while it runs
	watchGen    int          // the generation of the watch the model reads
	watchDone   bool         // whether that watch ended (resumeWatch)
	watchEnd    time.Time    // when that watch ended with no reason (bl watch exited 0); else zero
	rewatch     bool         // whether a snapshot after its end showed the run not running
	feed        []watch.Event
	follow      bool   // whether the detail box's feed shows its newest lines
	feedBack    int    // with follow off: how many lines the feed is scrolled back
	note        string // a red line in the bottom border until the next key (`w needs tmux`, a failed action)
	help        bool
	dialog      *dialog // the action dialog (D7), while it is open
	jobs        []job   // the action queue (F-127 Decision 4): the first runs, the rest wait
	snap        *stream.Snapshot
	stream      *stream.Stream
	gen         int // the generation of the stream the model reads
	presses     int // how many times `+` or `-` was pressed
	ended       string
	bell        bool
	senders     []notify.Sender
	differ      notify.Differ
	failed      map[string]string // by sender name: why its last command failed
}

// New is the model of a screen that reads `bl top --stream` through blArgv (the command that runs
// bl) every interval ms. For each new note (D8) it rings the bell when bell is true, and runs each
// sender.
func New(blArgv []string, interval int, bell bool, senders []notify.Sender) Model {
	return Model{blArgv: blArgv, interval: interval, focus: runsBox, gen: 1, follow: true, bell: bell, senders: senders}
}

// Ended is why the stream ended, when it ended while bl top ran: its last stderr line.
func (m Model) Ended() string {
	return m.ended
}

// Init starts the stream.
func (m Model) Init() tea.Cmd {
	return m.start()
}

// start starts a stream of the current generation and interval.
func (m Model) start() tea.Cmd {
	argv, gen := stream.Command(m.blArgv, m.interval), m.gen
	return func() tea.Msg {
		s, err := stream.Start(argv, gen)
		if err != nil {
			return stream.EndMsg{Gen: gen, Reason: err.Error()}
		}
		return startedMsg{s}
	}
}

// wait waits for the stream's next message.
func wait(s *stream.Stream) tea.Cmd {
	return func() tea.Msg { return s.Next() }
}

// stop stops the stream the model reads, when there is one.
func (m *Model) stop() {
	if m.stream != nil {
		m.stream.Stop()
		m.stream = nil
	}
}

// Update handles a terminal resize, a key, and the stream's messages. A message of a stream that
// the model replaced is dropped.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
	case tea.KeyPressMsg:
		return m.key(msg)
	case startedMsg:
		if msg.s.Gen != m.gen {
			msg.s.Stop()
			return m, nil
		}
		m.stream = msg.s
		return m, wait(m.stream)
	case stream.SnapshotMsg:
		if msg.Gen == m.gen {
			var cmds []tea.Cmd
			m, cmds = m.snapshot(msg.Snapshot)
			return m, tea.Batch(append(cmds, wait(m.stream))...)
		}
	case notify.ResultMsg:
		failed := map[string]string{}
		for name, why := range m.failed {
			failed[name] = why
		}
		if msg.Err == "" {
			delete(failed, msg.Sender)
		} else {
			failed[msg.Sender] = msg.Err
		}
		m.failed = failed
	case stream.EndMsg:
		if msg.Gen == m.gen {
			m.ended = msg.Reason
			return m, tea.Quit
		}
	case restartMsg:
		if msg.press == m.presses {
			m.stop()
			m.gen++
			return m, m.start()
		}
	case watchStartedMsg, watch.EventMsg, watch.EndMsg:
		return m.watchMsg(msg)
	case jobDoneMsg:
		return m.jobDone(msg)
	}
	return m, nil
}

// snapshot keeps s as the snapshot to draw, restarts the watch of the detail box when its run
// resumed (resumeWatch), and returns the commands of that and of its notes against the snapshot
// before (D8): one bell for them all, and each sender for each note it wants.
func (m Model) snapshot(s stream.Snapshot) (Model, []tea.Cmd) {
	m.snap = &s
	m.keepSelection()
	notes := m.differ.Diff(m.snap)
	var cmds []tea.Cmd
	m, resumed := m.resumeWatch()
	if resumed != nil {
		cmds = append(cmds, resumed)
	}
	if m.bell && len(notes) > 0 {
		cmds = append(cmds, notify.Bell())
	}
	for _, n := range notes {
		for _, s := range m.senders {
			if s.Wants(n) {
				cmds = append(cmds, s.Send(n))
			}
		}
	}
	return m, cmds
}

// warnings are the bottom border's note line, styled: the command of the action that runs, in the
// text color (F-127 Decision 2); then in red the note of the last key or of a failed action
// (`w needs tmux`) until the next key, and `<sender> failed: <why>` for each sender whose last
// command failed, in the senders' order.
func (m Model) warnings() []string {
	var out []string
	if len(m.jobs) > 0 {
		out = append(out, styleText.Render(m.jobs[0].show))
	}
	if m.note != "" {
		out = append(out, styleError.Render(m.note))
	}
	for _, s := range m.senders {
		if why, ok := m.failed[s.Name]; ok {
			out = append(out, styleError.Render(s.Name+" failed: "+why))
		}
	}
	return out
}

// key handles a key of D6. Each key clears the note. With the action dialog open, the dialog takes
// it; with the help open, any key but quit closes it. Quit leaves an action that runs to go on.
func (m Model) key(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	m.note = ""
	if m.dialog != nil {
		return m.dialogKey(msg)
	}
	if key.Matches(msg, keys.quit) {
		m.stop()
		m.stopWatch()
		return m, tea.Quit
	}
	if m.help {
		m.help = false
		return m, nil
	}
	switch {
	case m.focus == nextBox && key.Matches(msg, keys.yank, keys.after, keys.before, keys.unrank, keys.cancel, keys.commit, keys.reset):
		return m.rankKey(msg.String())
	case key.Matches(msg, keys.boxes):
		// Key n toggles the box at position n of the drawn layout (F-127 Decision 3).
		order := m.order()
		n := int(msg.String()[0] - '0')
		if n > len(order) {
			return m, nil
		}
		b := order[n-1]
		hidden := map[boxName]bool{}
		maps.Copy(hidden, m.hidden)
		hidden[b] = !hidden[b]
		m.hidden = hidden
		if m.focus == "" || m.hidden[m.focus] {
			m.focus = m.nextFocus(b, 1)
		}
	case key.Matches(msg, keys.next):
		m.focus = m.nextFocus(m.focus, 1)
	case key.Matches(msg, keys.prev):
		m.focus = m.nextFocus(m.focus, -1)
	case key.Matches(msg, keys.move):
		dir := 1
		if msg.String() == "up" {
			dir = -1
		}
		if m.focus == detailBox {
			m.scroll(dir)
		} else {
			m.move(dir)
		}
	case key.Matches(msg, keys.open):
		if m.focus == attentionBox && m.snap != nil {
			if i := m.selected(attentionBox); i >= 0 && m.attentionRows()[i].item == nil {
				m.updatesOpen = !m.updatesOpen
				m.keepSelection()
				return m, nil
			}
		}
		if id := m.selectedUnit(m.focus); id != "" && m.run(id) != nil {
			return m.showRun(id)
		}
	case key.Matches(msg, keys.act):
		return m.openMenu()
	case key.Matches(msg, keys.run, keys.stop, keys.page, keys.pr, keys.agent):
		return m.actKey(msg.String())
	case key.Matches(msg, keys.follow):
		m.toggleFollow()
	case key.Matches(msg, keys.watch):
		return m.openWatch()
	case m.focus == nextBox && key.Matches(msg, keys.order):
		m.newestFirst = !m.newestFirst
	case key.Matches(msg, keys.capacity):
		if s := m.stream; s != nil {
			return m, func() tea.Msg {
				s.RequestCapacity()
				return nil
			}
		}
	case key.Matches(msg, keys.longer, keys.shorter):
		step := intervalStep
		if key.Matches(msg, keys.shorter) {
			step = -step
		}
		interval := min(max(m.interval+step, minInterval), maxInterval)
		if interval == m.interval {
			// At the bound: no new interval, so no restart.
			return m, nil
		}
		m.interval = interval
		m.presses++
		press := m.presses
		return m, tea.Tick(restartDelay, func(time.Time) tea.Msg { return restartMsg{press} })
	case key.Matches(msg, keys.help):
		m.help = true
	}
	return m, nil
}

// nextFocus is the first box after from (dir 1) or before it (dir -1) in the drawn layout's order
// (F-127 Decision 1), round the end, that is not hidden; from itself when it is the only one; empty
// when every box is hidden. With no from, dir 1 starts at the first box.
func (m Model) nextFocus(from boxName, dir int) boxName {
	order := m.order()
	n, at := len(order), slices.Index(order, from)
	for i := 1; i <= n; i++ {
		if b := order[((at+dir*i)%n+n)%n]; !m.hidden[b] {
			return b
		}
	}
	return ""
}

// View draws the screen on the alternate screen, on D5's base background. Bubble Tea redraws only
// the cells that change, so a redraw does not flicker.
func (m Model) View() tea.View {
	v := tea.NewView(m.render())
	v.AltScreen = true
	v.BackgroundColor = colorBase
	return v
}

// helpBox draws the help overlay for a w×h screen: each key of keyMap and what it does, a box's own
// keys under the box's current number and name (helpGroups). When one column is taller than the
// screen and two fit its width, the boxes' own keys go in a second column.
func (m Model) helpBox(w, h int) []string {
	var every, own []string
	for _, g := range helpGroups {
		if g.box != "" {
			own = append(own, "", "  "+styleName.Render(superscript[m.number(g.box)]+string(g.box)))
		}
		for _, b := range g.keys {
			line := fmt.Sprintf("  %s %s", styleKey.Render(fmt.Sprintf("%-6s", b.Help().Key)), styleText.Render(b.Help().Desc))
			if g.box != "" {
				own = append(own, line)
			} else {
				every = append(every, line)
			}
		}
	}
	foot := []string{"", styleText.Render("  any key closes this help")}
	lines := slices.Concat([]string{""}, every, own, foot)
	if len(lines)+2 > h {
		// own starts with a blank line, which the second column leaves out.
		cw := 0
		for _, l := range every {
			cw = max(cw, lipgloss.Width(l)+2)
		}
		cols := []string{""}
		for i := range max(len(every), len(own)-1) {
			left, right := "", ""
			if i < len(every) {
				left = every[i]
			}
			if i+1 < len(own) {
				right = own[i+1]
			}
			cols = append(cols, left+strings.Repeat(" ", cw-lipgloss.Width(left))+right)
		}
		if two := append(cols, foot...); helpWidth(two) <= w {
			lines = two
		}
	}
	return drawBox(0, "help", nil, true, lines, helpWidth(lines), len(lines)+2)
}

// helpWidth is the width of the help box of lines: its widest line and the margin, at least 52.
func helpWidth(lines []string) int {
	w := 52
	for _, l := range lines {
		w = max(w, lipgloss.Width(l)+3)
	}
	return w
}

// overlay draws box over the middle of lines.
func overlay(lines, box []string) []string {
	w, h := lipgloss.Width(lines[0]), len(lines)
	bw := lipgloss.Width(box[0])
	x, y := max((w-bw)/2, 0), max((h-len(box))/2, 0)
	out := append([]string{}, lines...)
	for i, b := range box {
		if y+i >= h {
			break
		}
		out[y+i] = ansi.Truncate(lines[y+i], x, "") + b + ansi.TruncateLeft(lines[y+i], x+bw, "")
	}
	return out
}
