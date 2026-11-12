// Package notify tells the operator what is new between two snapshots (F-87 D8): a new
// escalation, a new task, and a run that ends. The view rings the terminal bell for it, and each
// sender (a command such as notify-send) gets it in the background.
package notify

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"syscall"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/roost-cc/bl/top/internal/stream"
)

// Note is one notification: what it is about, its kind, and one line about it.
type Note struct {
	ID, Kind, Line string
}

// notifyKinds are the inbox kinds that notify when they are new: the two that stop work until the
// operator acts.
var notifyKinds = map[string]bool{"escalation": true, "task": true}

// Differ compares each snapshot with the one before. Its zero value has no baseline: the first
// snapshot that read a section only sets that section's baseline.
type Differ struct {
	items map[string]bool   // the attention item ids; nil until the section was read
	runs  map[string]string // the status of each run id; nil until the section was read
	quiet map[string]bool   // the runs that this bl top stopped, until they end (Quiet)
}

// Quiet marks run id as stopped by this bl top (F-87 D8, F-88): when it ends as `stopped`, it does
// not notify. The mark goes when the run ends with any status, so a stop that did not take does not
// hide a later stop from another shell.
func (d *Differ) Quiet(id string) {
	if d.quiet == nil {
		d.quiet = map[string]bool{}
	}
	d.quiet[id] = true
}

// unknownStatus is the status of a run that a read skipped before the view saw it: no run status
// starts with a NUL, so it never equals one.
const unknownStatus = "\x00unknown"

// Diff returns the notes of s against the snapshot before, and keeps s as the new baseline. An
// inbox item notifies when its id was not in the snapshot before, so it notifies once, and again
// only after it left the inbox and came back. A run notifies when it has an end status
// (stream.Ended) that it did not have before, except a `stopped` end of a run that Quiet marked. A
// section that was never read (no read_at) changes
// nothing. A run that the read skipped (Runs.Skipped) and that has no row keeps the status it had;
// with none, its status is unknown, and the read that sees it again only sets its baseline.
func (d *Differ) Diff(s *stream.Snapshot) []Note {
	var notes []Note
	if !s.Attention.ReadAt.IsZero() {
		items := map[string]bool{}
		for _, it := range s.Attention.Items {
			items[it.ID] = true
			if d.items != nil && !d.items[it.ID] && notifyKinds[it.Kind] {
				notes = append(notes, Note{ID: it.ID, Kind: it.Kind, Line: it.Line})
			}
		}
		d.items = items
	}
	if !s.Runs.ReadAt.IsZero() {
		runs := map[string]string{}
		for _, r := range s.Runs.Rows {
			runs[r.ID] = r.Status
			if old := d.runs[r.ID]; d.runs != nil && old != unknownStatus && old != r.Status && stream.Ended(r.Status) &&
				!(r.Status == "stopped" && d.quiet[r.ID]) {
				notes = append(notes, Note{ID: r.ID, Kind: r.Status, Line: runLine(r)})
			}
			if stream.Ended(r.Status) {
				delete(d.quiet, r.ID)
			}
		}
		for _, id := range s.Runs.Skipped {
			if _, listed := runs[id]; listed {
				continue
			}
			if old, ok := d.runs[id]; ok {
				runs[id] = old
			} else {
				runs[id] = unknownStatus
			}
		}
		d.runs = runs
	}
	return notes
}

// runLine is the line of a run that ended: its step when it has one, and its story when it has one.
func runLine(r stream.Run) string {
	line := "ended"
	if r.Step != "" {
		line += " at " + r.Step
	}
	if r.Story != "" {
		line += " (" + r.Story + ")"
	}
	return line
}

// Bell is the terminal bell, which tmux shows as a flag on the pane's window.
func Bell() tea.Cmd {
	return tea.Raw("\a")
}

// timeout is how long a sender's command may run before it is killed.
var timeout = 10 * time.Second

// Sender is a command that gets each note (D8): its argv, to which it appends `<id> <kind>` and
// `<line>`. Name is what the bottom border names when it fails. Kinds, when it is not nil, are the
// only note kinds it gets.
type Sender struct {
	Name  string
	Argv  []string
	Kinds map[string]bool
}

// Wants says whether the sender gets n.
func (s Sender) Wants(n Note) bool {
	return s.Kinds == nil || s.Kinds[n.Kind]
}

// ResultMsg is the end of a sender's command: Err is "" when it exited 0, else its last stderr
// line, the error, or `timeout`.
type ResultMsg struct {
	Sender string
	Err    string
}

// Desktop is the desktop notification sender, `notify-send -a "bl top"`. It is false when
// notify-send is not on PATH.
func Desktop() (Sender, bool) {
	path, err := exec.LookPath("notify-send")
	if err != nil {
		return Sender{}, false
	}
	// `--` ends notify-send's options, so a title or line that starts with `-` is text.
	return Sender{Name: "desktop", Argv: []string{path, "-a", "bl top", "--"}}, true
}

// Push is the phone push sender (D8a): the command that backlog.json's `top.push` names. It gets
// a new escalation and a new task only, not a run that ends (Decision A6).
func Push(argv []string) Sender {
	return Sender{Name: "push", Argv: argv, Kinds: notifyKinds}
}

// Send runs the command for n in the background, and sends its ResultMsg when it ends.
func (s Sender) Send(n Note) tea.Cmd {
	return func() tea.Msg { return ResultMsg{Sender: s.Name, Err: s.run(n)} }
}

// waitDelay is how long a sender waits for its stderr to close after its command exited: a child
// that the command left behind may hold it open.
var waitDelay = time.Second

// run runs the command for n, in a process group of its own, so that a timeout kills what it
// started too. The command's own exit counts: one that exited 0 succeeded, even when a child that
// it left holds stderr, and only a command that was still running at the timeout is `timeout`.
func (s Sender) run(n Note) string {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	argv := append(append([]string{}, s.Argv...), n.ID+" "+n.Kind, n.Line)
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = waitDelay
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	if ps := cmd.ProcessState; ps != nil && ps.Exited() {
		if ps.Success() {
			return ""
		}
	} else if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "timeout"
	}
	if line := stream.LastLine(&stderr); line != "" {
		return line
	}
	return err.Error()
}
