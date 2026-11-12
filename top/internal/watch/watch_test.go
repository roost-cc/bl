package watch

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

// all reads every message of w until its end, or fails after 10 s.
func all(t *testing.T, w *Watch) []any {
	t.Helper()
	got := make(chan []any, 1)
	go func() {
		var msgs []any
		for {
			m := w.Next()
			if m == nil {
				got <- msgs
				return
			}
			msgs = append(msgs, m)
		}
	}()
	select {
	case msgs := <-got:
		return msgs
	case <-time.After(10 * time.Second):
		t.Fatal("the watch did not end in 10 s")
		return nil
	}
}

// fakeBl is a `bl` that writes its arguments to stderr and prints the recorded `bl watch --json`
// lines of the S-1272 fixtures, then runs rest.
func fakeBl(rest string) []string {
	return []string{"sh", "-c", `echo "args: $*" >&2; cat testdata/watch.jsonl; ` + rest, "bl"}
}

func TestWatchDecodesTheRecordedEventsAndEnds(t *testing.T) {
	w, err := Start(Command(fakeBl("exit 0"), "S-1330"), 3)
	if err != nil {
		t.Fatal(err)
	}
	msgs := all(t, w)
	var kinds, notes []string
	var first *Event
	for _, m := range msgs[:len(msgs)-1] {
		ev := m.(EventMsg)
		if ev.Gen != 3 {
			t.Errorf("gen %d", ev.Gen)
		}
		if ev.Event.Kind == "note" {
			notes = append(notes, ev.Event.Text)
			continue
		}
		kinds = append(kinds, ev.Event.Kind)
		if first == nil {
			first = &ev.Event
		}
	}
	want := []string{"step", "text", "tool", "tool", "tool", "text", "step", "tool", "text", "tool", "tool", "tool", "text", "end"}
	if !slices.Equal(kinds, want) {
		t.Errorf("kinds %v, want %v", kinds, want)
	}
	if !slices.Equal(notes, []string{"args: watch S-1330 --json"}) {
		t.Errorf("stderr notes %q", notes)
	}
	if end := msgs[len(msgs)-1]; !reflect.DeepEqual(end, EndMsg{Gen: 3}) {
		t.Errorf("end %#v, want an EndMsg with no reason", end)
	}
	if first == nil || first.Step != "implement" || first.Story != "S-1277" || first.Agent != "claude" || first.Model != "opus" || first.Session == "" {
		t.Errorf("the step event: %+v", first)
	}
}

func TestAWatchThatFailsEndsWithItsExit(t *testing.T) {
	w, err := Start([]string{"sh", "-c", "echo 'bl watch: no run state for F-9' >&2; exit 1"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	msgs := all(t, w)
	if len(msgs) != 2 || msgs[0].(EventMsg).Event.Text != "bl watch: no run state for F-9" {
		t.Fatalf("messages %#v", msgs)
	}
	if end := msgs[1].(EndMsg); end.Reason != "bl watch: exit status 1" {
		t.Errorf("reason %q", end.Reason)
	}
	w, _ = Start([]string{"sh", "-c", "echo 'not json'; sleep 30"}, 1)
	msgs = all(t, w)
	if end := msgs[len(msgs)-1].(EndMsg); !strings.HasPrefix(end.Reason, "a bl watch line is not an event") {
		t.Errorf("a bad line: %#v", msgs)
	}
}

func TestStopEndsTheWatchAndItsChildren(t *testing.T) {
	// A watch that never ends by itself, with a child (sleep) in its process group.
	w, err := Start(fakeBl("sleep 30"), 1)
	if err != nil {
		t.Fatal(err)
	}
	if m := w.Next(); m == nil {
		t.Fatal("no first message")
	}
	start := time.Now()
	w.Stop()
	if m := w.Next(); m != nil {
		t.Errorf("a message after Stop: %#v", m)
	}
	// The reader closes msgs once the process group is gone and its pipes closed.
	done := make(chan struct{})
	go func() {
		for range w.msgs {
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the watch's process did not end in 5 s after Stop")
	}
	if time.Since(start) > 5*time.Second {
		t.Error("Stop took longer than 5 s")
	}
}

// TestLinesKeepEveryLine: lines hands on every line that is not blank, of any length (a long agent
// message), with or without its newline.
func TestLinesKeepEveryLine(t *testing.T) {
	long := strings.Repeat("x", 5*1024*1024)
	cases := []struct {
		name, in string
		want     []string
	}{
		{"short lines", "a\nb\n", []string{"a", "b"}},
		{"blank lines are skipped", "\n  \na\n\n", []string{"a"}},
		{"a last line with no newline", "a\nb", []string{"a", "b"}},
		{"a CRLF line", "a\r\n", []string{"a"}},
		{"a 5 MiB line", long + "\nb\n", []string{long, "b"}},
		{"a 5 MiB last line with no newline", "a\n" + long, []string{"a", long}},
	}
	for _, c := range cases {
		var got []string
		lines(strings.NewReader(c.in), func(s string) bool { got = append(got, s); return true })
		if !slices.Equal(got, c.want) {
			t.Errorf("%s: %d lines, want %d", c.name, len(got), len(c.want))
		}
	}
}

// TestAWatchKeepsALongEventAndALongNote: a 5 MiB event on stdout and a 5 MiB stderr line both reach
// the TUI, and the watch ends with no reason.
func TestAWatchKeepsALongEventAndALongNote(t *testing.T) {
	text := strings.Repeat("y", 5*1024*1024)
	dir := t.TempDir()
	out, errf := filepath.Join(dir, "out"), filepath.Join(dir, "err")
	if err := os.WriteFile(out, []byte(`{"kind":"text","text":"`+text+`"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(errf, []byte(text+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	w, err := Start([]string{"sh", "-c", `cat "$1"; cat "$2" >&2`, "sh", out, errf}, 1)
	if err != nil {
		t.Fatal(err)
	}
	var texts, notes int
	msgs := all(t, w)
	for _, m := range msgs[:len(msgs)-1] {
		ev := m.(EventMsg).Event
		switch {
		case ev.Kind == "text" && ev.Text == text:
			texts++
		case ev.Kind == "note" && ev.Text == text:
			notes++
		}
	}
	if texts != 1 || notes != 1 {
		t.Errorf("%d long events and %d long notes, want 1 and 1", texts, notes)
	}
	if end := msgs[len(msgs)-1]; !reflect.DeepEqual(end, EndMsg{Gen: 1}) {
		t.Errorf("end %#v, want an EndMsg with no reason", end)
	}
}
