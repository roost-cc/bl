// Package watch runs `bl watch <id> --json` (S-1272) for the detail box and decodes its lines
// (S-1334).
// The TUI reads an agent's session only through it, and never reads a transcript.
package watch

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Event is one line of `bl watch --json`, by its kind (src/watch.js): `step` (a session starts:
// Step, Story, Agent, Model, Session), `text` (an agent message: At, Text), `tool` (a tool call: At,
// Tool, Summary) and, last, `end` (Status). A stderr line of `bl watch` is a `note` (Text).
type Event struct {
	Kind    string    `json:"kind"`
	Step    string    `json:"step"`
	Story   string    `json:"story"`
	Agent   string    `json:"agent"`
	Model   string    `json:"model"`
	Session string    `json:"session"`
	At      time.Time `json:"at"`
	Text    string    `json:"text"`
	Tool    string    `json:"tool"`
	Summary string    `json:"summary"`
	Status  string    `json:"status"`
}

// Watch is one running `bl watch`. Gen tells its messages from those of a watch that the TUI
// replaced.
type Watch struct {
	Gen  int
	cmd  *exec.Cmd
	msgs chan any
	done chan struct{}
	once sync.Once
}

// EventMsg is one event of the watch.
type EventMsg struct {
	Gen   int
	Event Event
}

// EndMsg says that the watch ended before Stop. Reason is empty when `bl watch` exited 0 (the run
// ended), else why it failed.
type EndMsg struct {
	Gen    int
	Reason string
}

// Command is the argv of the watch of run id: blArgv (the command that runs bl), then
// `watch <id> --json`.
func Command(blArgv []string, id string) []string {
	return append(append([]string{}, blArgv...), "watch", id, "--json")
}

// Start runs argv as watch gen. Next returns its messages. The watch runs in a process group of
// its own, so that Stop ends the processes it started too.
func Start(argv []string, gen int) (*Watch, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	w := &Watch{Gen: gen, cmd: cmd, msgs: make(chan any), done: make(chan struct{})}
	go w.read(stdout, stderr)
	return w, nil
}

// Next waits for the watch's next message: an EventMsg, or one EndMsg at its end. After the end,
// or after Stop, it returns nil.
func (w *Watch) Next() any {
	m := <-w.msgs
	select {
	case <-w.done:
		return nil
	default:
		return m
	}
}

// Stop ends the watch's process group and drops its later messages.
func (w *Watch) Stop() {
	w.once.Do(func() {
		close(w.done)
		syscall.Kill(-w.cmd.Process.Pid, syscall.SIGTERM)
	})
}

// send hands m to Next, unless the watch is stopped first.
func (w *Watch) send(m any) {
	select {
	case w.msgs <- m:
	case <-w.done:
	}
}

// read sends each stdout line as an event and each stderr line as a note, to their ends; then the
// end. A stdout line that is not an event ends the watch with the reason.
func (w *Watch) read(stdout, stderr io.Reader) {
	defer close(w.msgs)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		lines(stderr, func(line string) bool {
			w.send(EventMsg{Gen: w.Gen, Event: Event{Kind: "note", Text: line}})
			return true
		})
	}()
	reason := ""
	lines(stdout, func(line string) bool {
		var ev Event
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			reason = fmt.Sprintf("a bl watch line is not an event: %v", err)
			syscall.Kill(-w.cmd.Process.Pid, syscall.SIGTERM)
			return false
		}
		w.send(EventMsg{Gen: w.Gen, Event: ev})
		return true
	})
	// The rest of stdout, so the process is never held on a full pipe.
	io.Copy(io.Discard, stdout)
	wg.Wait()
	var exit *exec.ExitError
	if err := w.cmd.Wait(); reason == "" && errors.As(err, &exit) {
		reason = "bl watch: " + exit.Error()
	}
	w.send(EndMsg{Gen: w.Gen, Reason: reason})
}

// lines calls each with each line of r that is not blank, of any length, until each returns false
// or r ends. A last line with no newline is a line too.
func lines(r io.Reader, each func(string) bool) {
	br := bufio.NewReader(r)
	for {
		line, err := br.ReadString('\n')
		if t := strings.TrimSpace(line); t != "" && !each(t) {
			return
		}
		if err != nil {
			return
		}
	}
}
