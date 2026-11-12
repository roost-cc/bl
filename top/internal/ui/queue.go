package ui

import (
	"fmt"
	"os"
	"slices"

	tea "charm.land/bubbletea/v2"

	"github.com/roost-cc/bl/top/internal/actions"
	"github.com/roost-cc/bl/top/internal/stream"
)

// job is one action child process of the queue (F-127 Decision 4): an external command that bl top
// starts because the operator pressed a key.
type job struct {
	show   string   // the command as the note line shows it (command)
	argv   []string // the argv that runs it
	window string   // the tmux window it opens in; "" runs argv as a child
	stops  string   // the run that it stops (a bl stop), whose `stopped` end does not notify (D8)
}

// jobDoneMsg is the end of the job that runs, the first of the queue: its child's, or for a
// window, `tmux new-window`'s. Only one job runs at a time, so the end is always that job's.
type jobDoneMsg struct{ result actions.Result }

// jobOf is the job of action a, its argv rendered (renderAction), with text as its last word.
func (m Model) jobOf(a stream.Action, text string) job {
	argv := actions.Argv(actions.Words(a, text, goos), m.blArgv)
	return job{show: command(a, text, false), argv: argv, window: a.Window, stops: a.Stops}
}

// enqueue adds j at the end of the queue and starts it when no other job runs. Each new key's job
// waits for the jobs before it, so the jobs run one at a time, in the order of the key presses.
func (m Model) enqueue(j job) (Model, tea.Cmd) {
	m.jobs = append(slices.Clone(m.jobs), j)
	if len(m.jobs) > 1 {
		return m, nil
	}
	return m.startJob()
}

// startJob starts the first job of the queue and returns the command that waits for its end. A
// window job's child is `tmux new-window`, which ends at once; the command in the window holds
// nothing. A child starts here, before the next snapshot is read, and a stop marks its run with
// the child's pid, so the run's `stopped` end by that bl stop does not notify (D8); an end by
// another stop does.
func (m Model) startJob() (Model, tea.Cmd) {
	j := m.jobs[0]
	if j.window != "" {
		// The window opens in bl top's directory, the backlog root.
		dir, _ := os.Getwd()
		return m, func() tea.Msg { return jobDoneMsg{actions.Window(j.window, dir, j.argv)} }
	}
	pid, wait := actions.Start(j.argv)
	if j.stops != "" && pid > 0 {
		m.differ.Quiet(j.stops, pid)
	}
	return m, func() tea.Msg { return jobDoneMsg{wait()} }
}

// jobDone takes the job that ended off the queue. On success it starts the next job. On a failure
// the jobs that wait are dropped, and the note line says
// `exit <code>[, dropped <n> queued action(s)]: <command>: <last stderr line>` until the next key.
// The exit code and the count come first, so a long command or stderr line that the key bar cuts
// never hides them.
func (m Model) jobDone(msg jobDoneMsg) (Model, tea.Cmd) {
	done, rest := m.jobs[0], m.jobs[1:]
	m.jobs = rest
	if msg.result.Code == 0 {
		if len(rest) == 0 {
			return m, nil
		}
		return m.startJob()
	}
	m.note = fmt.Sprintf("exit %d", msg.result.Code)
	if n := len(rest); n > 0 {
		m.note += fmt.Sprintf(", dropped %d queued action", n)
		if n > 1 {
			m.note += "s"
		}
		m.jobs = nil
	}
	m.note += ": " + done.show
	if msg.result.Last != "" {
		m.note += ": " + msg.result.Last
	}
	return m, nil
}
