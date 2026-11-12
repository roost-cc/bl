package actions

import (
	"os"
	"path/filepath"
	"slices"
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
			`bl task done T-52 "image \"rebuilt\" on 44.140"`},
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

func TestRunGivesTheExitCodeAndTheLastStderrLine(t *testing.T) {
	ok := fake(t, "bl", "echo 'out' ; echo 'first' >&2; echo 'committed tasks/T52-x (backlog 4f1c2a9)' >&2\n")
	if got := Run([]string{ok}); got != (Result{Code: 0, Last: "committed tasks/T52-x (backlog 4f1c2a9)"}) {
		t.Errorf("exit 0: %#v", got)
	}
	bad := fake(t, "bl", "echo 'no running run for F-85' >&2; exit 1\n")
	if got := Run([]string{bad}); got != (Result{Code: 1, Last: "no running run for F-85"}) {
		t.Errorf("exit 1: %#v", got)
	}
	got := Run([]string{filepath.Join(t.TempDir(), "missing")})
	if got.Code != -1 || !strings.Contains(got.Last, "no such file") {
		t.Errorf("a command that does not start: %#v", got)
	}
}

func TestWindowRunsTmuxAndSaysWhyItFailed(t *testing.T) {
	dir := t.TempDir()
	args := filepath.Join(dir, "args")
	tmux := filepath.Join(dir, "tmux")
	if err := os.WriteFile(tmux, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > "+args+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	if why := Window("agent", "/w/backlog", []string{"bl", "agent"}); why != "" {
		t.Fatalf("tmux: %q", why)
	}
	data, _ := os.ReadFile(args)
	if got := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n"); !slices.Equal(got, TmuxArgs("agent", "/w/backlog", []string{"bl", "agent"})) {
		t.Errorf("tmux args %q", got)
	}
	if err := os.WriteFile(tmux, []byte("#!/bin/sh\necho 'no server running' >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if why := Window("agent", "/w", []string{"bl", "agent"}); why != "tmux: no server running" {
		t.Errorf("a failed tmux: %q", why)
	}
}
