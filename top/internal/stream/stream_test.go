package stream

import (
	"bytes"
	"os"
	"reflect"
	"testing"
	"time"
)

// recorded is the lines of testdata/stream.jsonl, shaped as src/top-snapshot.js writes them.
func recorded(t *testing.T) [][]byte {
	t.Helper()
	data, err := os.ReadFile("testdata/stream.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	return bytes.Split(bytes.TrimSpace(data), []byte("\n"))
}

func TestDecodeRecordedLines(t *testing.T) {
	lines := recorded(t)
	first, err := Decode(lines[0])
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, 11, 9, 22, 17, 31, 0, time.UTC); !first.At.Equal(want) {
		t.Errorf("at = %v, want %v", first.At, want)
	}
	runs := first.Runs.Rows
	if len(runs) != 2 || runs[0].ID != "F-9" || runs[0].Status != "stale" || runs[0].PID != 0 {
		t.Errorf("runs = %+v", runs)
	}
	if runs[1].PID != 4242 || runs[1].PR == nil || runs[1].PR.Number != "15" || runs[1].Usage.Output != 109000 {
		t.Errorf("runs[1] = %+v", runs[1])
	}
	kinds := []string{}
	for _, it := range first.Attention.Items {
		kinds = append(kinds, it.Kind)
	}
	if !reflect.DeepEqual(kinds, []string{"runner", "escalation", "task"}) {
		t.Errorf("attention kinds = %v", kinds)
	}
	if first.Next.Pick == nil || first.Next.Pick.ID != "F-9" || first.Next.Ranked[1].Holds[0] != "F-9" {
		t.Errorf("next = %+v", first.Next)
	}
	if w := first.Capacity.Configurations[0].Windows[0]; w.Name != "codex 5h" || w.RemainingPercent != 80 {
		t.Errorf("capacity window = %+v", w)
	}
	if d := first.History.Days[1]; d.Points != 5 || len(d.Stories) != 2 {
		t.Errorf("history day = %+v", d)
	}

	second, err := Decode(lines[1])
	if err != nil {
		t.Fatal(err)
	}
	if got := second.Section("capacity"); got.Error != "codex app-server timed out" || got.ReadAt.IsZero() {
		t.Errorf("capacity section = %+v, want its error and its last good read", got)
	}
	if got := second.Section("history"); !got.ReadAt.IsZero() || got.Error != "" {
		t.Errorf("history section = %+v, want never read", got)
	}
}

func TestDecodeRefusesOtherLines(t *testing.T) {
	for _, line := range []string{`not json`, `{"schema":"bl-top-json/v2"}`} {
		if _, err := Decode([]byte(line)); err == nil {
			t.Errorf("Decode(%q) = nil error", line)
		}
	}
}

func TestCommand(t *testing.T) {
	got := Command([]string{"node", "/bl/src/bl.js"}, 2500)
	want := []string{"node", "/bl/src/bl.js", "top", "--stream", "--interval", "2500"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Command = %v, want %v", got, want)
	}
}

// next waits for the stream's next message, or fails the test after 10 s.
func next(t *testing.T, s *Stream) any {
	t.Helper()
	got := make(chan any, 1)
	go func() { got <- s.Next() }()
	select {
	case m := <-got:
		return m
	case <-time.After(10 * time.Second):
		t.Fatal("no message from the stream in 10 s")
		return nil
	}
}

func TestStreamSendsEachLineThenItsLastStderrLine(t *testing.T) {
	s, err := Start([]string{"sh", "-c", `cat testdata/stream.jsonl; echo 'warning: one' >&2; echo 'bl: no backlog here' >&2; exit 1`}, 7)
	if err != nil {
		t.Fatal(err)
	}
	for i := range 2 {
		m, ok := next(t, s).(SnapshotMsg)
		if !ok || m.Gen != 7 {
			t.Fatalf("message %d = %#v, want a SnapshotMsg of gen 7", i, m)
		}
	}
	if m := next(t, s); !reflect.DeepEqual(m, EndMsg{Gen: 7, Reason: "bl: no backlog here"}) {
		t.Fatalf("end = %#v", m)
	}
	if m := next(t, s); m != nil {
		t.Fatalf("after the end = %#v, want nil", m)
	}
}

func TestStreamEndsOnALineThatIsNotASnapshot(t *testing.T) {
	s, err := Start([]string{"sh", "-c", `echo oops; sleep 30`}, 1)
	if err != nil {
		t.Fatal(err)
	}
	m, ok := next(t, s).(EndMsg)
	if !ok || m.Reason == "" || m.Reason == "bl top --stream ended" {
		t.Fatalf("end = %#v, want the decode error", m)
	}
}

func TestStreamExitWithNoStderrNamesTheExit(t *testing.T) {
	s, err := Start([]string{"sh", "-c", `exit 3`}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if m := next(t, s); !reflect.DeepEqual(m, EndMsg{Gen: 1, Reason: "bl top --stream: exit status 3"}) {
		t.Fatalf("end = %#v", m)
	}
}

func TestStopClosesStdinAndSendsNoEnd(t *testing.T) {
	// The script ends when its stdin closes, as `bl top --stream` does.
	s, err := Start([]string{"sh", "-c", `head -n 1 testdata/stream.jsonl; cat >/dev/null; echo 'gone' >&2; exit 1`}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := next(t, s).(SnapshotMsg); !ok {
		t.Fatal("no first snapshot")
	}
	s.Stop()
	if m := next(t, s); m != nil {
		t.Fatalf("after Stop = %#v, want nil", m)
	}
}
