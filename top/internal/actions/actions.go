// Package actions builds and runs the commands of bl top's actions (F-87 D7, S-1336): a bl verb
// as a child, whose exit code and last stderr line the view shows; a command in a new tmux window,
// which stays open after the command exits; or a page opened with xdg-open (open on macOS). The
// actions themselves come in the snapshot, so this package knows no bl verb.
package actions

import (
	"bytes"
	"os/exec"
	"strings"
	"text/template"
	"time"

	"github.com/roost-cc/bl/top/internal/stream"
)

// Opener is the command that opens a URL on the system goos (runtime.GOOS): `open` on macOS,
// `xdg-open` on Linux.
func Opener(goos string) string {
	if goos == "darwin" {
		return "open"
	}
	return "xdg-open"
}

// Render renders each element of argv as a text/template against vars (F-113 D7, Decision A4):
// `Selected`, the selected row's id, and `Yanked`, the yanked unit's id, only while one is yanked.
// A key that vars does not hold is an error (missingkey=error), so a command that needs the yanked
// unit fails while none is yanked. An element without `{{ }}` renders as itself; nil stays nil.
func Render(argv []string, vars map[string]string) ([]string, error) {
	if argv == nil {
		return nil, nil
	}
	out := make([]string, len(argv))
	for i, el := range argv {
		t, err := template.New("argv").Option("missingkey=error").Parse(el)
		if err != nil {
			return nil, err
		}
		var b strings.Builder
		if err := t.Execute(&b, vars); err != nil {
			return nil, err
		}
		out[i] = b.String()
	}
	return out, nil
}

// Words are the command of action a as the operator reads it: its argv, with text as the last word
// when text is not empty; or for a URL, the opener of goos and the URL.
func Words(a stream.Action, text, goos string) []string {
	if a.URL != "" {
		return []string{Opener(goos), a.URL}
	}
	words := append([]string{}, a.Argv...)
	if text != "" {
		words = append(words, text)
	}
	return words
}

// Show is words as one line that sh runs as the same words: a word that is empty or holds a
// character sh treats as special is quoted for sh (shQuote), so a dollar sign or a backtick in a
// typed note stays literal.
func Show(words []string) string {
	out := make([]string, len(words))
	for i, w := range words {
		if w == "" || strings.ContainsAny(w, " \t\n\"'\\$`;&|<>()*?[]#~!{}") {
			w = shQuote(w)
		}
		out[i] = w
	}
	return strings.Join(out, " ")
}

// shQuote is w in single quotes for sh: each single quote in w ends the quotes, is escaped with a
// backslash, and starts them again.
func shQuote(w string) string {
	return "'" + strings.ReplaceAll(w, "'", `'\''`) + "'"
}

// Argv is the argv that runs words: a bl command (first word `bl`) runs through blArgv, the
// command that runs bl top's own bl.
func Argv(words, blArgv []string) []string {
	if len(words) > 0 && words[0] == "bl" {
		return append(append([]string{}, blArgv...), words[1:]...)
	}
	return words
}

// TmuxArgs are the arguments of `tmux new-window` that open a window named name in dir, which runs
// argv, each word quoted for sh, then `exec ${SHELL:-sh}`, so the window stays open after the
// command exits (D7).
func TmuxArgs(name, dir string, argv []string) []string {
	words := make([]string, len(argv))
	for i, a := range argv {
		words[i] = shQuote(a)
	}
	return []string{"new-window", "-n", name, "-c", dir, strings.Join(words, " ") + "; exec ${SHELL:-sh}"}
}

// Window opens the tmux window of TmuxArgs. It returns why it failed (`tmux: <its output>`), or ""
// when it opened.
func Window(name, dir string, argv []string) string {
	out, err := exec.Command("tmux", TmuxArgs(name, dir, argv)...).CombinedOutput()
	if err == nil {
		return ""
	}
	why := strings.TrimSpace(string(out))
	if why == "" {
		why = err.Error()
	}
	return "tmux: " + why
}

// Result is the end of a command: its exit code, or -1 when it did not start or was killed; and
// its last stderr line, or why it did not start.
type Result struct {
	Code int
	Last string
}

// waitDelay is how long Run waits for stderr to close after the command exited: a child that the
// command left behind may hold it open.
var waitDelay = time.Second

// Start starts argv with no stdin and stdout, in bl top's directory. It returns the child's pid, or
// 0 when it did not start, and wait, which waits for the end and returns its Result. The view
// starts the child before it reads the next snapshot, so it knows the pid first (a stop's quiet
// mark, D8).
func Start(argv []string) (pid int, wait func() Result) {
	cmd := exec.Command(argv[0], argv[1:]...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.WaitDelay = waitDelay
	if err := cmd.Start(); err != nil {
		return 0, func() Result { return Result{Code: -1, Last: err.Error()} }
	}
	return cmd.Process.Pid, func() Result {
		err := cmd.Wait()
		if cmd.ProcessState == nil {
			return Result{Code: -1, Last: err.Error()}
		}
		return Result{Code: cmd.ProcessState.ExitCode(), Last: stream.LastLine(&stderr)}
	}
}
