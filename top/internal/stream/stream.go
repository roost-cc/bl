// Package stream runs `bl top --stream` and decodes its lines (F-87 D1). The TUI reads bl's state
// only through it, and never reads a backlog file.
package stream

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

// Stream is one running `bl top --stream`. Gen tells its messages from those of a stream that
// the TUI replaced.
type Stream struct {
	Gen   int
	cmd   *exec.Cmd
	stdin io.WriteCloser
	msgs  chan any
	done  chan struct{}
	once  sync.Once
}

// SnapshotMsg is one decoded line of the stream.
type SnapshotMsg struct {
	Gen      int
	Snapshot Snapshot
}

// EndMsg says that the stream ended before Stop: Reason is its last stderr line, or why bl-top
// could not read it.
type EndMsg struct {
	Gen    int
	Reason string
}

// Command is the argv of the stream: blArgv (the command that runs bl), then
// `top --stream --interval <ms>`.
func Command(blArgv []string, interval int) []string {
	return append(append([]string{}, blArgv...), "top", "--stream", "--interval", strconv.Itoa(interval))
}

// Start runs argv as stream gen. Next returns its messages. The stream runs in a process group of
// its own, so that a kill ends the processes it started too.
func Start(argv []string, gen int) (*Stream, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
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
	s := &Stream{Gen: gen, cmd: cmd, stdin: stdin, msgs: make(chan any), done: make(chan struct{})}
	go s.read(stdout, stderr)
	return s, nil
}

// Next waits for the stream's next message: a SnapshotMsg, or one EndMsg at its end. After the
// end, or after Stop, it returns nil.
func (s *Stream) Next() any {
	m := <-s.msgs
	select {
	case <-s.done:
		return nil
	default:
		return m
	}
}

// Stop closes the stream's stdin, which ends `bl top --stream`, and drops its later messages.
func (s *Stream) Stop() {
	s.once.Do(func() {
		close(s.done)
		s.stdin.Close()
	})
}

// RequestCapacity writes a `capacity` line to the stream's stdin, so its next snapshot reads
// capacity (key `c`). After Stop it does nothing.
func (s *Stream) RequestCapacity() {
	io.WriteString(s.stdin, "capacity\n")
}

// send hands m to Next, unless the stream is stopped first.
func (s *Stream) send(m any) bool {
	select {
	case s.msgs <- m:
		return true
	case <-s.done:
		return false
	}
}

// read decodes stdout line by line to its end. It reads stdout to the end even after Stop: bl
// writes a snapshot to a pipe in one blocking write, and a full pipe would hold it there, so it
// would never see stdin close.
func (s *Stream) read(stdout, stderr io.Reader) {
	defer close(s.msgs)
	last := make(chan string, 1)
	go func() { last <- lastLine(stderr) }()
	reason := ""
	r := bufio.NewReader(stdout)
	for {
		line, err := r.ReadBytes('\n')
		if reason == "" && len(bytes.TrimSpace(line)) > 0 {
			snap, derr := Decode(line)
			if derr != nil {
				reason = derr.Error()
				// The whole group: a child that holds stderr open would keep the end waiting.
				syscall.Kill(-s.cmd.Process.Pid, syscall.SIGKILL)
			} else {
				s.send(SnapshotMsg{Gen: s.Gen, Snapshot: snap})
			}
		}
		if err != nil {
			break
		}
	}
	stderrLine := <-last
	werr := s.cmd.Wait()
	if reason == "" {
		reason = stderrLine
	}
	var exit *exec.ExitError
	if reason == "" && errors.As(werr, &exit) {
		reason = "bl top --stream: " + exit.Error()
	}
	if reason == "" {
		reason = "bl top --stream ended"
	}
	s.send(EndMsg{Gen: s.Gen, Reason: reason})
}

// lastLine reads r to its end and returns its last line that is not blank.
func lastLine(r io.Reader) string {
	last := ""
	br := bufio.NewReader(r)
	for {
		line, err := br.ReadString('\n')
		if t := strings.TrimSpace(line); t != "" {
			last = t
		}
		if err != nil {
			return last
		}
	}
}
