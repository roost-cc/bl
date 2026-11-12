package ui

import (
	"fmt"
	"os"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/roost-cc/bl/top/internal/actions"
	"github.com/roost-cc/bl/top/internal/stream"
	"github.com/roost-cc/bl/top/internal/watch"
)

// detailFullHeight is the inner height from which box ⁶ draws Mockup A's form (the header, the
// timeline as columns, the counts); below it, Mockup B's three-line form.
const detailFullHeight = 12

// maxFeed is how many feed events box ⁶ keeps; older ones are dropped.
const maxFeed = 1000

// deniedToolWidth is the most cells of the first denied tool that box ⁶ shows, so the test
// attempts and step tokens after it stay on the line.
const deniedToolWidth = 30

// pathWidth is the most cells of the branch (its start) and of the lead worktree's path (its end)
// that box ⁶ shows, so the pull request and the start time after them stay on the line.
const pathWidth = 24

// noRun is box ⁶'s line while no run is selected.
const noRun = "select a run (↑↓ in ¹, then ↵)"

// watchStartedMsg carries a watch that has started.
type watchStartedMsg struct{ w *watch.Watch }

// tmuxDoneMsg is the end of a `tmux new-window`: Err is why it failed, or empty.
type tmuxDoneMsg struct{ Err string }

// selectedUnit is the work unit of the selected row of box num: the run's id in ¹, the item's
// unit in ², the unit in ³; empty when the box has no selected row.
func (m Model) selectedUnit(num int) string {
	if m.snap == nil {
		return ""
	}
	i := m.selected(num)
	if i < 0 {
		return ""
	}
	switch num {
	case 1:
		return m.snap.Runs.Rows[i].ID
	case 2:
		if r := m.attentionRows()[i]; r.item != nil {
			return r.item.Unit
		}
	case 3:
		return m.nextUnits()[i].ID
	}
	return ""
}

// run is the `runs` row of id, or nil when the snapshot has none.
func (m Model) run(id string) *stream.Run {
	if m.snap == nil {
		return nil
	}
	for i := range m.snap.Runs.Rows {
		if m.snap.Runs.Rows[i].ID == id {
			return &m.snap.Runs.Rows[i]
		}
	}
	return nil
}

// showRun makes box ⁶ show run id (D4, key ↵): it stops the watch of the run shown before, and
// starts `bl watch <id> --json` of a new generation. The run shown already keeps its watch.
func (m Model) showRun(id string) (Model, tea.Cmd) {
	if id == m.detail && m.watcher != nil {
		return m, nil
	}
	m.detail, m.feed, m.feedBack = id, nil, 0
	return m.startWatch()
}

// resumeWatch restarts the watch of the run box ⁶ shows when that run resumed after its watch
// ended, and this snapshot shows it running: a snapshot after the end showed the run not running
// (rewatch), or this one was read after a watch that exited 0 (watchEnd). Such a watch ends only
// when no bl holds the run, so a run read as running after it is a new holder. The feed stays,
// and the new watch adds the resumed session's header to it.
func (m Model) resumeWatch() (Model, tea.Cmd) {
	r := m.run(m.detail)
	switch {
	case !m.watchDone || r == nil:
	case r.Status != "running":
		m.rewatch = true
	case m.rewatch, !m.watchEnd.IsZero() && m.snap.Runs.ReadAt.After(m.watchEnd):
		return m.startWatch()
	}
	return m, nil
}

// startWatch stops the watch of box ⁶, when there is one, and starts `bl watch <id> --json` of the
// run it shows, of a new generation.
func (m Model) startWatch() (Model, tea.Cmd) {
	m.stopWatch()
	m.watchGen++
	m.watchDone, m.watchEnd, m.rewatch = false, time.Time{}, false
	argv, gen := watch.Command(m.blArgv, m.detail), m.watchGen
	return m, func() tea.Msg {
		w, err := watch.Start(argv, gen)
		if err != nil {
			return watch.EndMsg{Gen: gen, Reason: err.Error()}
		}
		return watchStartedMsg{w}
	}
}

// waitWatch waits for the watch's next message.
func waitWatch(w *watch.Watch) tea.Cmd {
	return func() tea.Msg { return w.Next() }
}

// stopWatch stops the watch of box ⁶, when there is one.
func (m *Model) stopWatch() {
	if m.watcher != nil {
		m.watcher.Stop()
		m.watcher = nil
	}
}

// watchMsg handles a message of a watch. A message of a watch that the model replaced is dropped.
func (m Model) watchMsg(msg tea.Msg) (Model, tea.Cmd) {
	switch msg := msg.(type) {
	case watchStartedMsg:
		if msg.w.Gen != m.watchGen {
			msg.w.Stop()
			return m, nil
		}
		m.watcher = msg.w
		return m, waitWatch(m.watcher)
	case watch.EventMsg:
		if msg.Gen != m.watchGen {
			return m, nil
		}
		m.feed = append(m.feed, msg.Event)
		if len(m.feed) > maxFeed {
			m.feed = m.feed[len(m.feed)-maxFeed:]
		}
		if !m.follow {
			// The lines on screen stay where they are.
			m.feedBack = min(m.feedBack+1, len(m.feed)-1)
		}
		if m.watcher == nil {
			return m, nil
		}
		return m, waitWatch(m.watcher)
	case watch.EndMsg:
		if msg.Gen == m.watchGen {
			m.watcher, m.watchDone = nil, true
			if msg.Reason != "" {
				m.feed = append(m.feed, watch.Event{Kind: "note", Text: msg.Reason})
			} else {
				m.watchEnd = time.Now()
			}
		}
	}
	return m, nil
}

// scroll moves the feed of box ⁶ one line back (dir -1, key ↑) or on (dir 1, key ↓) while follow
// is off. With follow on, the feed stays at its newest line.
func (m *Model) scroll(dir int) {
	if m.follow {
		return
	}
	m.feedBack = min(max(m.feedBack-dir, 0), max(len(m.feed)-1, 0))
}

// toggleFollow turns follow on (the feed shows its newest lines) or off (↑ and ↓ scroll it).
func (m *Model) toggleFollow() {
	m.follow = !m.follow
	if m.follow {
		m.feedBack = 0
	}
}

// getenv reads the environment; a test replaces it.
var getenv = os.Getenv

// openWatch opens `bl watch <id>` of the run box ⁶ shows in a new tmux window (key w).
func (m Model) openWatch() (Model, tea.Cmd) {
	switch {
	case m.detail == "":
		m.note = "w: " + noRun
		return m, nil
	case getenv("TMUX") == "":
		m.note = "w needs tmux"
		return m, nil
	}
	return m, tmuxWindow(m.detail+" watch", append(append([]string{}, m.blArgv...), "watch", m.detail))
}

// tmuxWindow opens a tmux window named name in bl top's directory (the backlog root) that runs
// argv, then the operator's shell, so the window stays open after the command exits (F-87 D7).
func tmuxWindow(name string, argv []string) tea.Cmd {
	dir, _ := os.Getwd()
	return func() tea.Msg {
		return tmuxDoneMsg{Err: actions.Window(name, dir, argv)}
	}
}

// drawDetail draws box ⁶ (D4, Mockups A and B) in w×h inner cells: the selected run's header, its
// step timeline and counts, then the live feed of `bl watch --json`, and the keys on the last
// line. With no run selected it says how to select one.
func (m Model) drawDetail(w, h int) []string {
	foot := ""
	var lines []string
	if m.detail == "" {
		lines = []string{styleDim.Render(noRun)}
	} else {
		r := m.run(m.detail)
		cw := w - 1
		if h >= detailFullHeight {
			lines = detailHeader(m.detail, r, m.snap.At, cw)
		} else {
			lines = []string{compactHeader(m.detail, r, m.snap.At)}
			if r != nil {
				lines = append(lines, inlineTimeline(r.Timeline))
			}
		}
		foot = styleDim.Render(m.feedKeys(h >= detailFullHeight))
		lines = append(lines, m.feedLines(max(h-len(lines)-1, 0), cw)...)
	}
	for len(lines) < h-1 {
		lines = append(lines, "")
	}
	return margin(append(lines, foot))
}

// feedKeys is box ⁶'s line of keys, with the state of follow; short for Mockup B's box.
func (m Model) feedKeys(full bool) string {
	state := "follow on · f stops it"
	if !m.follow {
		state = "follow off · ↑↓ scroll the feed · f follows"
	}
	if full {
		return state + " · w opens bl watch in a tmux window"
	}
	return state + " · w bl watch · 6 hides ⁶"
}

// feedLines are the room lines of the feed that show: the newest, or with follow off the ones
// feedBack lines back from them. Before the first event it says that it waits for one.
func (m Model) feedLines(room, w int) []string {
	if room == 0 {
		return nil
	}
	if len(m.feed) == 0 {
		return []string{styleDim.Render("bl watch " + m.detail + ": waiting for the run's agent session")}
	}
	end := max(len(m.feed)-m.feedBack, min(room, len(m.feed)))
	var lines []string
	for _, e := range m.feed[max(end-room, 0):end] {
		lines = append(lines, feedLine(e, w))
	}
	return lines
}

// feedLine is one feed event as box ⁶ draws it (Mockup A), w cells wide at most: a session's
// header as a rule, an agent message (`say`) or tool call (`tool`) with its local time, a stderr
// line of `bl watch`, or the run's end.
func feedLine(e watch.Event, w int) string {
	rule := func(text string) string {
		text = "── " + text + " "
		return styleDim.Render(text + strings.Repeat("─", max(w-lipgloss.Width(text), 0)))
	}
	at := styleDim.Render(e.At.Local().Format("15:04:05")) + "  "
	switch e.Kind {
	case "step":
		head := "live: " + strings.Join(strings.Fields(e.Step+" "+e.Story), " ") + " · " +
			strings.Join(strings.Fields(e.Agent+" "+e.Model), " ")
		if e.Session != "" {
			head += " · session " + fit(e.Session, 8)
		}
		return rule(head)
	case "text":
		return at + styleText.Render("say   "+strings.Join(strings.Fields(e.Text), " "))
	case "tool":
		return at + styleText.Render(strings.TrimRight("tool  "+e.Tool+"  "+strings.Join(strings.Fields(e.Summary), " "), " "))
	case "end":
		return rule("run ended: " + e.Status)
	}
	return styleDim.Render(strings.Join(strings.Fields(e.Text), " "))
}

// detailHeader is the top of box ⁶ in Mockup A's form, w cells wide: the run's id and title; its
// branch, lead worktree, pull request and start time; its timeline as columns over a bar; its
// denied tools, test attempts and the tokens of its current (or last) stage.
func detailHeader(id string, r *stream.Run, now time.Time, w int) []string {
	if r == nil {
		return []string{styleText.Render(id + " · not in the runs list"), ""}
	}
	title := id
	if r.Title != "" {
		title += " · " + r.Title
	}
	where := []string{"branch " + dash(ansi.Truncate(r.Branch, pathWidth, "…")), "lead worktree " + dash(tail(r.WorktreePath, pathWidth)),
		"PR " + prLabel(r.PR)}
	if started, err := time.Parse(time.RFC3339, r.StartedAt); err == nil {
		where = append(where, "started "+started.Local().Format(dayClock(started, now)))
	}
	lines := []string{styleText.Render(title), styleDim.Render(strings.Join(where, " · ")), ""}
	lines = append(lines, timelineColumns(r.Timeline)...)
	denied := fmt.Sprintf("denied tools: %d", r.Denied.Count)
	if r.Denied.Count > 0 {
		denied += fmt.Sprintf(" (%s: %s)", dash(r.Denied.Step), ansi.Truncate(r.Denied.Tool, deniedToolWidth, "…"))
	}
	u := stepUsage(r.Timeline)
	return append(lines, styleText.Render(fmt.Sprintf("%s   test attempts: %d", denied, r.TestAttempts)),
		styleText.Render(fmt.Sprintf("step tokens: in %s · out %s · cache r %s · w %s",
			count(float64(u.Input)), count(float64(u.Output)), count(float64(u.CacheRead)), count(float64(u.CacheCreation)))), "")
}

// compactHeader is box ⁶'s first line in Mockup B's form: the run's id, story and step, elapsed
// time, and agent.
func compactHeader(id string, r *stream.Run, now time.Time) string {
	if r == nil {
		return styleText.Render(id + " · not in the runs list")
	}
	parts := []string{id, strings.Join(strings.Fields(r.Story+" "+r.Step), " "), elapsed(*r, now)}
	if who := strings.Join(strings.Fields(r.Agent+" "+r.Model+" "+r.Effort), " "); who != "" {
		parts = append(parts, who)
	}
	return styleText.Render(strings.Join(parts, " · "))
}

// stageLabel is a timeline stage's name: its step, and its round (`review r1`).
func stageLabel(s stream.Stage) string {
	if s.Round > 0 {
		return fmt.Sprintf("%s r%d", s.Step, s.Round)
	}
	return s.Step
}

// stageMark is a stage's state as box ⁶ draws it: `✓` done and `●` current, with the duration or
// elapsed time when long is true (and the test attempts when there were two or more), `·`
// pending; and its style.
func stageMark(s stream.Stage, long bool) (string, lipgloss.Style) {
	mark, style := "·", styleDim
	switch s.State {
	case "done":
		mark, style = "✓", styleOK
	case "current":
		mark, style = "●", styleOK
	}
	if s.State == "current" || (long && s.State == "done") {
		if s.DurationMs != nil {
			mark += " " + duration(time.Duration(*s.DurationMs)*time.Millisecond)
		}
		if long && s.Tests > 1 {
			mark += fmt.Sprintf(" (%d att.)", s.Tests)
		}
	}
	return mark, style
}

// timelineColumns are the timeline in Mockup A's form: the stage names, their marks under them,
// and a bar (`━` under the stages done or current, `┅` under those not started).
func timelineColumns(stages []stream.Stage) []string {
	var names, marks, bar string
	for _, s := range stages {
		label := stageLabel(s)
		mark, style := stageMark(s, true)
		width := max(lipgloss.Width(label), lipgloss.Width(mark)) + 2
		names += styleDim.Render(fit(label, width))
		marks += style.Render(fit(mark, width))
		if s.State == "pending" {
			bar += styleDim.Render(strings.Repeat("┅", width))
		} else {
			bar += styleOK.Render(strings.Repeat("━", width))
		}
	}
	return []string{names, marks, bar}
}

// inlineTimeline is the timeline in Mockup B's form: `setup ✓ ─ implement ● 1h02m ─ fix-tests ·`.
func inlineTimeline(stages []stream.Stage) string {
	var parts []string
	for _, s := range stages {
		mark, style := stageMark(s, false)
		parts = append(parts, styleText.Render(stageLabel(s)+" ")+style.Render(mark))
	}
	return strings.Join(parts, styleDim.Render(" ─ "))
}

// stepUsage is the token use of the sessions that ended in the current stage, or else in the last
// stage that is done; zero when they reported none. A session counts only when it ends (D3b).
func stepUsage(stages []stream.Stage) stream.Usage {
	var last *stream.Usage
	for _, s := range stages {
		if s.State == "pending" {
			continue
		}
		last = s.Usage
		if s.State == "current" {
			break
		}
	}
	if last == nil {
		return stream.Usage{}
	}
	return *last
}

// tail cuts s to its last n cells, with `…` before them.
func tail(s string, n int) string {
	if w := lipgloss.Width(s); w > n {
		return ansi.TruncateLeft(s, w-n+1, "…")
	}
	return s
}

// dayClock is the layout of a time: `15:04` on the day of now, else `Jan 02 15:04`.
func dayClock(t, now time.Time) string {
	if t.Local().Format(time.DateOnly) == now.Local().Format(time.DateOnly) {
		return "15:04"
	}
	return "Jan 02 15:04"
}
