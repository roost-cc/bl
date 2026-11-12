// Package actions builds and runs the commands of bl top's actions (F-87 D7, S-1336): a bl verb
// as a child, whose exit code and last stderr line the view shows; a command in a new tmux window,
// which stays open after the command exits; or a page opened with xdg-open (open on macOS). The
// actions themselves come in the snapshot, so this package knows no bl verb.
package actions

import (
	"bytes"
	"os/exec"
	"strings"
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

// Show is words as one line: a word that is empty or holds a space or a quote is in double quotes.
func Show(words []string) string {
	out := make([]string, len(words))
	for i, w := range words {
		if w == "" || strings.ContainsAny(w, " \t\"'\\$`") {
			w = `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(w) + `"`
		}
		out[i] = w
	}
	return strings.Join(out, " ")
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
		words[i] = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
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

// Run runs argv with no stdin and stdout, in bl top's directory, and returns its Result.
func Run(argv []string) Result {
	cmd := exec.Command(argv[0], argv[1:]...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.WaitDelay = waitDelay
	err := cmd.Run()
	if cmd.ProcessState == nil {
		return Result{Code: -1, Last: err.Error()}
	}
	return Result{Code: cmd.ProcessState.ExitCode(), Last: stream.LastLine(&stderr)}
}
