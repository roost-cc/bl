package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// names are the senders' names.
func names(t *testing.T, desktop bool, pushArgv string, push bool) []string {
	t.Helper()
	list, err := senders(desktop, pushArgv, push)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, s := range list {
		out = append(out, s.Name)
	}
	return out
}

func TestSenders(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notify-send"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	argv := `["phone-push","--topic","bl top"]`
	for _, c := range []struct {
		what     string
		desktop  bool
		pushArgv string
		push     bool
		want     []string
	}{
		{"both", true, argv, true, []string{"desktop", "push"}},
		{"no --push-argv: no top block", true, "", true, []string{"desktop"}},
		{"--no-push", true, argv, false, []string{"desktop"}},
		{"--no-desktop --no-push", false, argv, false, nil},
		{"--no-desktop", false, argv, true, []string{"push"}},
	} {
		if got := names(t, c.desktop, c.pushArgv, c.push); !slices.Equal(got, c.want) {
			t.Errorf("%s: %q, want %q", c.what, got, c.want)
		}
	}
	list, _ := senders(false, argv, true)
	if want := []string{"phone-push", "--topic", "bl top"}; !slices.Equal(list[0].Argv, want) {
		t.Errorf("push argv %q, want %q", list[0].Argv, want)
	}
	if _, err := senders(false, `"phone-push"`, true); err == nil || !strings.Contains(err.Error(), "--push-argv must be a JSON array") {
		t.Errorf("a bad --push-argv: %v", err)
	}
}
