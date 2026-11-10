package ui

import (
	"fmt"
	"time"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/roost-cc/bl/top/internal/notify"
	"github.com/roost-cc/bl/top/internal/stream"
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

// keyMap holds the keys of D6 that F-87 has. The help overlay lists them.
type keyMap struct {
	boxes, next, prev, move, open, capacity, longer, shorter, help, quit key.Binding
}

var keys = keyMap{
	boxes:    key.NewBinding(key.WithKeys("1", "2", "3", "4", "5"), key.WithHelp("1-5", "hide or show a box")),
	next:     key.NewBinding(key.WithKeys("tab"), key.WithHelp("tab", "move the focus to the next box")),
	prev:     key.NewBinding(key.WithKeys("shift+tab"), key.WithHelp("⇧tab", "move the focus to the previous box")),
	move:     key.NewBinding(key.WithKeys("up", "down"), key.WithHelp("↑↓", "select a row in the box with the focus")),
	open:     key.NewBinding(key.WithKeys("enter"), key.WithHelp("↵", "open or close the grouped update row")),
	capacity: key.NewBinding(key.WithKeys("c"), key.WithHelp("c", "read capacity now")),
	longer:   key.NewBinding(key.WithKeys("+"), key.WithHelp("+", fmt.Sprintf("refresh interval up (to %d s)", maxInterval/1000))),
	shorter:  key.NewBinding(key.WithKeys("-"), key.WithHelp("-", fmt.Sprintf("refresh interval down (to %d ms)", minInterval))),
	help:     key.NewBinding(key.WithKeys("h"), key.WithHelp("h", "show or hide this help")),
	quit:     key.NewBinding(key.WithKeys("q", "ctrl+c"), key.WithHelp("q", "quit")),
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
	hidden        [6]bool      // by box number, 1 to 5
	focus         int          // a box number; 0 when every box is hidden
	sel           [6]selection // by box number: the selected row of boxes 1 to 3
	updatesOpen   bool         // whether box ²'s grouped update row is open
	help          bool
	snap          *stream.Snapshot
	stream        *stream.Stream
	gen           int // the generation of the stream the model reads
	presses       int // how many times `+` or `-` was pressed
	ended         string
	bell          bool
	senders       []notify.Sender
	differ        notify.Differ
	failed        map[string]string // by sender name: why its last command failed
}

// New is the model of a screen that reads `bl top --stream` through blArgv (the command that runs
// bl) every interval ms. For each new note (D8) it rings the bell when bell is true, and runs each
// sender.
func New(blArgv []string, interval int, bell bool, senders []notify.Sender) Model {
	return Model{blArgv: blArgv, interval: interval, focus: 1, gen: 1, bell: bell, senders: senders}
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
	}
	return m, nil
}

// snapshot keeps s as the snapshot to draw, and returns the commands of its notes against the
// snapshot before (D8): one bell for them all, and each sender for each note it wants.
func (m Model) snapshot(s stream.Snapshot) (Model, []tea.Cmd) {
	m.snap = &s
	m.keepSelection()
	notes := m.differ.Diff(m.snap)
	var cmds []tea.Cmd
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

// warnings are the bottom border's red warnings: `<sender> failed: <why>` for each sender whose
// last command failed, in the senders' order.
func (m Model) warnings() []string {
	var out []string
	for _, s := range m.senders {
		if why, ok := m.failed[s.Name]; ok {
			out = append(out, s.Name+" failed: "+why)
		}
	}
	return out
}

// key handles a key of D6. With the help open, any key but quit closes it.
func (m Model) key(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	if key.Matches(msg, keys.quit) {
		m.stop()
		return m, tea.Quit
	}
	if m.help {
		m.help = false
		return m, nil
	}
	switch {
	case key.Matches(msg, keys.boxes):
		n := int(msg.String()[0] - '0')
		m.hidden[n] = !m.hidden[n]
		if m.focus == 0 || m.hidden[m.focus] {
			m.focus = m.nextFocus(n, 1)
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
		m.move(dir)
	case key.Matches(msg, keys.open):
		if m.focus == 2 && m.snap != nil {
			if i := m.selected(2); i >= 0 && m.attentionRows()[i].item == nil {
				m.updatesOpen = !m.updatesOpen
				m.keepSelection()
			}
		}
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

// nextFocus is the first box after from (dir 1) or before it (dir -1), in number order and round
// the end, that is not hidden; from itself when it is the only one; 0 when every box is hidden.
func (m Model) nextFocus(from, dir int) int {
	n := len(boxes)
	for i := 1; i <= n; i++ {
		b := ((from-1+dir*i)%n+n)%n + 1
		if !m.hidden[b] {
			return b
		}
	}
	return 0
}

// View draws the screen on the alternate screen, on D5's base background. Bubble Tea redraws only
// the cells that change, so a redraw does not flicker.
func (m Model) View() tea.View {
	v := tea.NewView(m.render())
	v.AltScreen = true
	v.BackgroundColor = colorBase
	return v
}

// helpBox draws the help overlay: each key of keyMap and what it does.
func helpBox() []string {
	bindings := []key.Binding{keys.boxes, keys.next, keys.prev, keys.move, keys.open, keys.capacity, keys.longer, keys.shorter, keys.help, keys.quit}
	lines := []string{""}
	for _, b := range bindings {
		lines = append(lines, fmt.Sprintf("  %s %s", styleKey.Render(fmt.Sprintf("%-6s", b.Help().Key)), styleText.Render(b.Help().Desc)))
	}
	lines = append(lines, "", styleText.Render("  any key closes this help"))
	return drawBox(0, "help", nil, true, lines, 52, len(lines)+2)
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
