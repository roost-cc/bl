package actions

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/roost-cc/bl/top/internal/stream"
)

var (
	done = stream.Action{Key: "d", Argv: []string{"bl", "task", "done", "T-52"}, Input: "note"}
	pr   = stream.Action{Key: "p", URL: "https://example.invalid/pull/15"}
)

func TestWordsAndShow(t *testing.T) {
	for _, c := range []struct {
		what  string
		words []string
		show  string
	}{
		{"no text", Words(done, "", "linux"), "bl task done T-52"},
		{"the text is the last word, quoted", Words(done, `image "rebuilt" on 44.140`, "linux"),
			`bl task done T-52 'image "rebuilt" on 44.140'`},
		{"a URL on Linux", Words(pr, "", "linux"), "xdg-open https://example.invalid/pull/15"},
		{"a URL on macOS", Words(pr, "", "darwin"), "open https://example.invalid/pull/15"},
	} {
		if got := Show(c.words); got != c.show {
			t.Errorf("%s: %q, want %q", c.what, got, c.show)
		}
	}
	// Words does not change the action's argv.
	Words(done, "a note", "linux")
	if len(done.Argv) != 4 {
		t.Errorf("Words changed the argv: %q", done.Argv)
	}
}

// TestRenderFillsTheTemplates: F-113 D7's templates take the selected and the yanked ids; a plain
// element (every F-88 command) renders as itself; a missing Yanked is an error.
func TestRenderFillsTheTemplates(t *testing.T) {
	put := []string{"bl", "rank", "{{.Yanked}}", "--after", "{{.Selected}}"}
	both := map[string]string{"Selected": "F-84", "Yanked": "S-1400"}
	for _, c := range []struct {
		what string
		argv []string
		vars map[string]string
		want []string
	}{
		{"a plain element", []string{"bl", "task", "done", "T-52"}, map[string]string{"Selected": "T-52"}, []string{"bl", "task", "done", "T-52"}},
		{"both fields", put, both, []string{"bl", "rank", "S-1400", "--after", "F-84"}},
		{"the selected id alone", []string{"bl", "rank", "{{.Selected}}", "--remove"}, map[string]string{"Selected": "F-84"}, []string{"bl", "rank", "F-84", "--remove"}},
		{"no argv (a URL)", nil, both, nil},
	} {
		got, err := Render(c.argv, c.vars)
		if err != nil || !slices.Equal(got, c.want) || (c.want == nil) != (got == nil) {
			t.Errorf("%s: %q, %v; want %q", c.what, got, err, c.want)
		}
	}
	if got, err := Render(put, map[string]string{"Selected": "F-84"}); err == nil {
		t.Errorf("a missing Yanked rendered: %q", got)
	}
	// Render does not change the action's argv.
	if put[2] != "{{.Yanked}}" {
		t.Errorf("Render changed the argv: %q", put)
	}
}

func TestArgvRunsBlThroughBlArgv(t *testing.T) {
	bl := []string{"node", "/opt/bl/src/bl.js"}
	if got := Argv([]string{"bl", "stop", "S-1330"}, bl); !slices.Equal(got, []string{"node", "/opt/bl/src/bl.js", "stop", "S-1330"}) {
		t.Errorf("a bl command: %q", got)
	}
	if got := Argv([]string{"xdg-open", "https://x"}, bl); !slices.Equal(got, []string{"xdg-open", "https://x"}) {
		t.Errorf("another command: %q", got)
	}
}

func TestTmuxArgs(t *testing.T) {
	got := TmuxArgs("F-83 run", "/w/backlog", []string{"node", "/opt/bl's/bl.js", "run", "F-83", "--resume"})
	want := []string{"new-window", "-n", "F-83 run", "-c", "/w/backlog",
		`'node' '/opt/bl'\''s/bl.js' 'run' 'F-83' '--resume'; exec ${SHELL:-sh}`}
	if !slices.Equal(got, want) {
		t.Errorf("%q, want %q", got, want)
	}
}

// fake writes an executable sh script with that body in a new directory, and returns its path.
func fake(t *testing.T, name, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// run starts argv and waits for it: the pid Start gave and the Result.
func run(argv []string) (int, Result) {
	pid, wait := Start(argv)
	return pid, wait()
}

func TestStartGivesThePidTheExitCodeAndTheLastStderrLine(t *testing.T) {
	// The child prints its own pid first: Start gives the same one.
	ok := fake(t, "bl", "echo $$ >&2; echo 'out' ; echo 'first' >&2; echo 'committed tasks/T52-x (backlog 4f1c2a9)' >&2\n")
	pid, got := run([]string{ok})
	if got != (Result{Code: 0, Last: "committed tasks/T52-x (backlog 4f1c2a9)"}) || pid <= 0 {
		t.Errorf("exit 0: pid %d, %#v", pid, got)
	}
	self := fake(t, "bl", "echo $$ >&2\n")
	if pid, got := run([]string{self}); got.Last != strconv.Itoa(pid) {
		t.Errorf("the pid: Start gave %d, the child is %q", pid, got.Last)
	}
	bad := fake(t, "bl", "echo 'no running run for F-85' >&2; exit 1\n")
	if _, got := run([]string{bad}); got != (Result{Code: 1, Last: "no running run for F-85"}) {
		t.Errorf("exit 1: %#v", got)
	}
	pid, got = run([]string{filepath.Join(t.TempDir(), "missing")})
	if pid != 0 || got.Code != -1 || !strings.Contains(got.Last, "no such file") {
		t.Errorf("a command that does not start: pid %d, %#v", pid, got)
	}
}

func TestWindowRunsTmuxAndReturnsItsResult(t *testing.T) {
	dir := t.TempDir()
	args := filepath.Join(dir, "args")
	tmux := filepath.Join(dir, "tmux")
	if err := os.WriteFile(tmux, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > "+args+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	if got := Window("agent", "/w/backlog", []string{"bl", "agent"}); got != (Result{}) {
		t.Fatalf("tmux: %#v", got)
	}
	data, _ := os.ReadFile(args)
	if got := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n"); !slices.Equal(got, TmuxArgs("agent", "/w/backlog", []string{"bl", "agent"})) {
		t.Errorf("tmux args %q", got)
	}
	if err := os.WriteFile(tmux, []byte("#!/bin/sh\necho 'no server running' >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := Window("agent", "/w", []string{"bl", "agent"}); got != (Result{Code: 1, Last: "no server running"}) {
		t.Errorf("a failed tmux: %#v", got)
	}
	t.Setenv("PATH", t.TempDir())
	if got := Window("agent", "/w", []string{"bl", "agent"}); got.Code != -1 || !strings.Contains(got.Last, "not found") {
		t.Errorf("no tmux: %#v", got)
	}
}

// TestShownCommandRunsAsTheSameWords: the line Show draws, run by sh, passes each word unchanged,
// for every character class sh treats as special.
func TestShownCommandRunsAsTheSameWords(t *testing.T) {
	notes := []string{
		"", "plain", "two words", "tab\there", "line\nbreak",
		"$HOME", "${HOME}", "$(echo x)", "`echo x`", `back\slash`, `"double"`, "it's", "'",
		"a;b", "a&b", "a|b", "<in>", "(sub)", "*", "?", "[ab]", "#hash", "~", "!bang", "{a,b}",
	}
	for _, note := range notes {
		words := []string{"printf", "[%s]\n", note}
		shown := Show(words)
		out, err := exec.Command("sh", "-c", shown).Output()
		if err != nil {
			t.Errorf("%q: sh -c %q: %v", note, shown, err)
			continue
		}
		if string(out) != "["+note+"]\n" {
			t.Errorf("%q: sh -c %q printed %q", note, shown, out)
		}
	}
}
