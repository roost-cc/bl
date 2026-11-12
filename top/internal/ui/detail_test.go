package ui

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/roost-cc/bl/top/internal/stream"
	"github.com/roost-cc/bl/top/internal/watch"
)

// watched is the model after each recorded `bl watch --json` line of the S-1272 fixtures
// (../watch/testdata/watch.jsonl) came to it, as messages of its current watch.
func watched(t *testing.T, m Model) Model {
	t.Helper()
	data, err := os.ReadFile("../watch/testdata/watch.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range bytes.Split(bytes.TrimSpace(data), []byte("\n")) {
		var ev watch.Event
		if err := json.Unmarshal(line, &ev); err != nil {
			t.Fatal(err)
		}
		m, _ = update(t, m, watch.EventMsg{Gen: m.watchGen, Event: ev})
	}
	return m
}

// showing is the model of a w×h terminal with the recorded snapshot, S-1330 selected in the runs
// box and shown in the detail box (↵), and the recorded feed.
func showing(t *testing.T, w, h int) Model {
	t.Helper()
	m, _ := update(t, sized(t, w, h), snapshot(t))
	m, cmd := press(t, m, down, enter)
	if m.detail != "S-1330" || cmd == nil {
		t.Fatalf("↵ on S-1330 in the runs box: detail %q, cmd %v", m.detail, cmd)
	}
	return watched(t, m)
}

// TestDetailBoxGolden draws the detail box with S-1330's header, timeline and recorded feed in both
// layouts.
func TestDetailBoxGolden(t *testing.T) {
	for _, size := range []struct {
		name string
		w, h int
	}{{"detail-171x63", 171, 63}, {"detail-100x40", 100, 40}} {
		golden(t, size.name, screen(t, showing(t, size.w, size.h)))
	}
}

func TestDetailBoxShowsTheRunTimelineAndFeed(t *testing.T) {
	out := screen(t, showing(t, 171, 63))
	for _, want := range []string{
		"³detail┌", "┐S-1330┌",
		"S-1330 · Every bl verb that writes the backlog commits and pushes what it changed",
		// The branch's start and the worktree's end; 22:39 UTC is 17:39 in the test's zone.
		"branch s1330-every-bl-verb-tha… · lead worktree …-the-backlog-commits/bl · PR bl#15 · started 17:39",
		"setup  implement  fix-tests      self-review  review r1  fix r1  review r2  fix r2  closing",
		"✓ 10s  ✓ 23m      ✓ 6m (2 att.)  ✓ 4m         ● 4m       ·       ·          ·       ·",
		"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┅┅┅┅",
		// The first denied tool is cut, so the test attempts stay on the line.
		"denied tools: 1 (implement: Bash(cd /home/robert/work/roo…)   test attempts: 2",
		"step tokens: in 94k · out 12k · cache r 2.0M · w 0",
		// The newest lines that fit: the first two scrolled out.
		"20:17:35  tool  Read  /w/backlog/stories/S1-first/index.md",
		"20:18:25  say   Done. All unit tests pass.",
		"── live: review:correctness · codex gpt-6-sol ─",
		"20:42:27  tool  exec_command  bash -lc 'rg -n followSession src'",
		"── run ended: escalated ─",
		"follow on · f stops it · w opens bl watch in a tmux window",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("the detail box has no %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "I'll read the story first.") {
		t.Errorf("follow on shows a line older than those that fit:\n%s", out)
	}
	// The session's header, as the feed's first line once ↑ reaches it (follow off).
	m, _ := press(t, focused(t, showing(t, 171, 63), detailBox), text("f"), up, up)
	if out := screen(t, m); !strings.Contains(out, "── live: implement S-1277 · claude opus · session 7f3c2a1… ─") ||
		!strings.Contains(out, "20:17:34  say   I'll read the story first.") {
		t.Errorf("the feed's first lines:\n%s", out)
	}
	// Mockup B's form: one header line, the timeline on one line.
	out = screen(t, showing(t, 100, 40))
	for _, want := range []string{
		"S-1330 · review · 38m · codex gpt-6-sol",
		"setup ✓ ─ implement ✓ ─ fix-tests ✓ ─ self-review ✓ ─ review r1 ● 4m ─ fix r1 · ─",
		"20:42:27  say   Done: - the review found nothing.",
		"── run ended: escalated ─",
		"follow on · f stops it · w bl watch · 3 hides it",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("the detail box at 100x40 has no %q:\n%s", want, out)
		}
	}
}

func TestDetailBoxSaysHowToSelectARun(t *testing.T) {
	for _, size := range [][2]int{{171, 63}, {100, 40}} {
		m, _ := update(t, sized(t, size[0], size[1]), snapshot(t))
		if out := screen(t, m); !strings.Contains(out, "│ select a run (↑↓ in runs, then ↵)") {
			t.Errorf("%v: no hint in the detail box:\n%s", size, out)
		}
	}
}

func TestItsNumberKeyHidesAndShowsTheDetailBox(t *testing.T) {
	for _, size := range [][2]int{{171, 63}, {100, 40}} {
		m := showing(t, size[0], size[1])
		m, _ = press(t, m, text("3"))
		if out := screen(t, m); strings.Contains(out, "³detail") {
			t.Errorf("%v: the detail box drawn while hidden", size)
		}
		m, _ = press(t, m, text("3"))
		if out := screen(t, m); !strings.Contains(out, "³detail") || !strings.Contains(out, "say   Done:") {
			t.Errorf("%v: the detail box not drawn again with its feed:\n%s", size, out)
		}
	}
}

func TestEnterShowsTheRunOfTheSelectedRowInEachBox(t *testing.T) {
	m, _ := update(t, sized(t, 171, 63), snapshot(t))
	// The runs box: the selected run.
	m, _ = press(t, m, enter)
	if m.detail != "F-81" {
		t.Errorf("↵ in the runs box: %q, want F-81", m.detail)
	}
	// The attention box: the item S-1330:change is of S-1330, which has a run.
	m, _ = press(t, m, tab, down, down, down, down, down, enter)
	if m.detail != "S-1330" {
		t.Errorf("↵ on S-1330:change in the attention box: %q, want S-1330", m.detail)
	}
	// An update item's unit is a repo, with no run: nothing changes.
	m, _ = press(t, m, down, enter)
	if m.detail != "S-1330" {
		t.Errorf("↵ on an update item: %q, want S-1330 still", m.detail)
	}
	// The next box: F-81 has a run; F-84 has none.
	m, _ = press(t, focused(t, m, nextBox), enter)
	if m.detail != "F-81" {
		t.Errorf("↵ on F-81 in the next box: %q", m.detail)
	}
	gen := m.watchGen
	m, cmd := press(t, m, down, enter)
	if m.detail != "F-81" || m.watchGen != gen || cmd != nil {
		t.Errorf("↵ on F-84 (no run) in the next box: %q, gen %d → %d", m.detail, gen, m.watchGen)
	}
}

// sleeper is a watch that runs until it is stopped.
func sleeper(t *testing.T, gen int) *watch.Watch {
	t.Helper()
	w, err := watch.Start([]string{"sh", "-c", "sleep 30"}, gen)
	if err != nil {
		t.Fatal(err)
	}
	return w
}

// stopped reports whether w was stopped: Next returns nil at once.
func stopped(w *watch.Watch) bool {
	got := make(chan any, 1)
	go func() { got <- w.Next() }()
	select {
	case m := <-got:
		return m == nil
	case <-time.After(5 * time.Second):
		return false
	}
}

func TestTheWatchStopsWhenTheSelectionChangesOrTheTUIQuits(t *testing.T) {
	m, _ := update(t, sized(t, 171, 63), snapshot(t))
	m, cmd := press(t, m, enter)
	if m.detail != "F-81" || cmd == nil {
		t.Fatalf("↵ on F-81: %q", m.detail)
	}
	// The command started F-81's watch; here a sleeper stands for it.
	first := sleeper(t, m.watchGen)
	m, _ = update(t, m, watchStartedMsg{first})
	if m.watcher != first {
		t.Fatal("the started watch was not kept")
	}
	// ↵ on F-81 again keeps its watch.
	if m, cmd = press(t, m, enter); cmd != nil || m.watcher != first {
		t.Error("↵ on the run shown started another watch")
	}
	m, _ = press(t, m, down, enter)
	if m.detail != "S-1330" || !stopped(first) {
		t.Fatalf("↵ on S-1330: detail %q; the watch of F-81 stopped: %v", m.detail, stopped(first))
	}
	// A message of F-81's watch, which the model replaced, is dropped; a late start is stopped.
	m, _ = update(t, m, watch.EventMsg{Gen: m.watchGen - 1, Event: watch.Event{Kind: "text", Text: "old"}})
	if len(m.feed) != 0 {
		t.Error("an event of the old watch was kept")
	}
	late := sleeper(t, m.watchGen-1)
	m, _ = update(t, m, watchStartedMsg{late})
	if m.watcher == late || !stopped(late) {
		t.Error("a watch of an old generation was kept or not stopped")
	}
	second := sleeper(t, m.watchGen)
	m, _ = update(t, m, watchStartedMsg{second})
	if _, cmd = press(t, m, text("q")); cmd == nil || !stopped(second) {
		t.Error("q did not stop the watch")
	}
}

func TestAWatchThatEndsKeepsItsFeedAndShowsWhy(t *testing.T) {
	m := showing(t, 171, 63)
	m, _ = update(t, m, watch.EndMsg{Gen: m.watchGen, Reason: "bl watch: exit status 1"})
	if out := screen(t, m); !strings.Contains(out, "say   Done.") || !strings.Contains(out, "bl watch: exit status 1") {
		t.Errorf("the end of the watch:\n%s", out)
	}
}

func TestFollowOffLetsArrowsScrollTheFeed(t *testing.T) {
	m := showing(t, 171, 63)
	m = focused(t, m, detailBox)
	for i := range 40 {
		m, _ = update(t, m, watch.EventMsg{Gen: m.watchGen, Event: watch.Event{Kind: "text", Text: "line " + string(rune('A'+i%26)) + string(rune('0'+i/26))}})
	}
	last := "say   line N1"
	if out := screen(t, m); !strings.Contains(out, last) {
		t.Fatalf("follow on does not show the newest line:\n%s", out)
	}
	// Follow on: ↑ does not scroll.
	m, _ = press(t, m, up, up)
	if m.feedBack != 0 {
		t.Errorf("↑ with follow on scrolled: %d", m.feedBack)
	}
	// f is a key of the detail box only (F-127, "Three kinds of keys").
	if other, _ := press(t, focused(t, m, runsBox), text("f")); !other.follow {
		t.Error("f outside the detail box turned follow off")
	}
	m, _ = press(t, m, text("f"))
	if m.follow || !strings.Contains(screen(t, m), "follow off · ↑↓ scroll the feed · f follows") {
		t.Fatal("f did not turn follow off")
	}
	m, _ = press(t, m, up, up, up, down)
	if m.feedBack != 2 || strings.Contains(screen(t, m), last) {
		t.Errorf("↑↑↑↓ with follow off: back %d", m.feedBack)
	}
	// A new event leaves the lines on screen where they are.
	before := screen(t, m)
	m, _ = update(t, m, watch.EventMsg{Gen: m.watchGen, Event: watch.Event{Kind: "text", Text: "newer"}})
	if strings.Contains(screen(t, m), "newer") || m.feedBack != 3 {
		t.Errorf("a new event moved the scrolled feed (back %d)", m.feedBack)
	}
	if after := screen(t, m); after != before {
		t.Errorf("the scrolled feed changed:\n%s", after)
	}
	// ↑ stops at the first line.
	for range 100 {
		m, _ = press(t, m, up)
	}
	if !strings.Contains(screen(t, m), "── live: implement S-1277") {
		t.Errorf("↑ to the top does not show the first line:\n%s", screen(t, m))
	}
	m, _ = press(t, m, text("f"))
	if !m.follow || m.feedBack != 0 || !strings.Contains(screen(t, m), "say   newer") {
		t.Error("f did not follow the newest line again")
	}
}

func TestWOpensBlWatchInANewTmuxWindow(t *testing.T) {
	env := map[string]string{}
	getenv = func(k string) string { return env[k] }
	t.Cleanup(func() { getenv = os.Getenv })
	m, _ := update(t, sized(t, 171, 63), snapshot(t))
	// w is a key of the detail box only (F-127, "Three kinds of keys").
	if m, cmd := press(t, m, text("w")); cmd != nil || m.note != "" {
		t.Errorf("w in the runs box: note %q", m.note)
	}
	m, _ = press(t, focused(t, m, detailBox), text("w"))
	if !strings.Contains(screen(t, m), "w: select a run (↑↓ in runs, then ↵)") {
		t.Errorf("w with no run:\n%s", screen(t, m))
	}
	m = focused(t, showing(t, 171, 63), detailBox)
	m, cmd := press(t, m, text("w"))
	if cmd != nil || !strings.Contains(screen(t, m), "w needs tmux") {
		t.Errorf("w outside tmux:\n%s", screen(t, m))
	}
	// The next key clears the note.
	if m, _ = press(t, m, text("f")); strings.Contains(screen(t, m), "w needs tmux") {
		t.Error("the note stayed after the next key")
	}
	// A fake tmux on PATH writes its arguments, one per line.
	env["TMUX"] = "/tmp/tmux-1000/default,1,0"
	dir := t.TempDir()
	args := filepath.Join(dir, "args")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + args + "\n"
	if err := os.WriteFile(filepath.Join(dir, "tmux"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	m.blArgv = []string{"node", "/opt/bl's/src/bl.js"}
	m, cmd = press(t, m, text("w"))
	if cmd == nil || !strings.Contains(screen(t, m), "┐bl watch S-1330  (new tmux window)┌") {
		t.Fatalf("w in tmux: no command, or no command on the note line:\n%s", screen(t, m))
	}
	msg := cmd()
	if msg != (jobDoneMsg{}) {
		t.Fatalf("tmux: %#v", msg)
	}
	if m, cmd = update(t, m, msg); len(m.jobs) != 0 || cmd != nil {
		t.Fatalf("after the window opened: %d jobs", len(m.jobs))
	}
	data, err := os.ReadFile(args)
	if err != nil {
		t.Fatal(err)
	}
	cwd, _ := os.Getwd()
	want := []string{"new-window", "-n", "S-1330 watch", "-c", cwd, `'node' '/opt/bl'\''s/src/bl.js' 'watch' 'S-1330'; exec ${SHELL:-sh}`}
	if got := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n"); !slices.Equal(got, want) {
		t.Errorf("tmux args %q, want %q", got, want)
	}
	// A tmux that fails reports like any other failed action.
	if err := os.WriteFile(filepath.Join(dir, "tmux"), []byte("#!/bin/sh\necho 'no server running' >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	m, cmd = press(t, m, text("w"))
	m, _ = update(t, m, cmd())
	if !strings.Contains(screen(t, m), "exit 1: bl watch S-1330  (new tmux window): no server running") {
		t.Errorf("a failed tmux:\n%s", screen(t, m))
	}
}

func TestHelpListsTheKeysOfTheDetailBox(t *testing.T) {
	m, _ := press(t, sized(t, 100, 40), text("h"))
	out := screen(t, m)
	for _, want := range []string{"1-6", "show the selected run in the detail box", "³detail", "follow the feed on or off",
		"open bl watch of the run in a tmux window"} {
		if !strings.Contains(out, want) {
			t.Errorf("the help has no %q:\n%s", want, out)
		}
	}
}

// TestTheFeedFollowsARunThatResumesAfterItsWatchEnded: once the watch of the run the detail box
// shows has ended, a snapshot that shows the run not running (stopped, escalated, clean, stale,
// failed), then one that shows it running again, starts a new watch; the feed stays. So does a
// first snapshot read after a watch that exited 0 that shows the run running (a resume between two
// snapshots). A watch that has not ended, a snapshot read before the end, a watch that ended with a
// reason, and another run shown start none.
func TestTheFeedFollowsARunThatResumesAfterItsWatchEnded(t *testing.T) {
	// readAt is the time the snapshots of at are read; restarted says whether one started a new watch.
	readAt := time.Now()
	// at is the model after a snapshot in which F-1 has status.
	at := func(m Model, status string) (Model, bool) {
		s := stream.Snapshot{Schema: stream.Schema}
		s.Runs.ReadAt = readAt
		s.Runs.Rows = []stream.Run{{ID: "F-1", Status: status}, {ID: "F-2", Status: "running"}}
		gen := m.watchGen
		m, cmds := m.snapshot(s)
		if (m.watchGen != gen) != (len(cmds) == 1) {
			t.Fatalf("generation %d to %d with %d commands", gen, m.watchGen, len(cmds))
		}
		return m, m.watchGen != gen
	}
	// shown is a model that shows F-1 with a feed, its watch of generation 3 running; ended, its end
	// after the snapshots are read.
	shown := func(ended bool) Model {
		m := New([]string{"bl"}, 2000, false, nil)
		m.detail, m.watchGen = "F-1", 3
		m.feed = []watch.Event{{Kind: "text", Text: "before"}}
		if ended {
			m, _ = m.watchMsg(watch.EndMsg{Gen: 3})
		}
		return m
	}
	for _, status := range []string{"stopped", "escalated", "clean", "stale", "failed"} {
		readAt = time.Now().Add(-time.Second)
		m, restarted := at(shown(true), "running")
		if restarted {
			t.Errorf("%s: a snapshot read before the watch ended restarted it", status)
		}
		if m, restarted = at(m, status); restarted {
			t.Errorf("%s: a run that is not running restarted its watch", status)
		}
		m, restarted = at(m, "running")
		if !restarted {
			t.Errorf("%s: the resumed run got no new watch", status)
		}
		if len(m.feed) != 1 || m.feed[0].Text != "before" {
			t.Errorf("%s: the feed %v", status, m.feed)
		}
		if _, again := at(m, "running"); again {
			t.Errorf("%s: the new watch was started twice", status)
		}
	}
	// A resume between two snapshots: the first one read after the end shows the run running.
	m := shown(true)
	readAt = time.Now().Add(time.Second)
	m, restarted := at(m, "running")
	if !restarted {
		t.Error("a run read as running after its watch exited 0 got no new watch")
	}
	if len(m.feed) != 1 || m.feed[0].Text != "before" {
		t.Errorf("a resume between two snapshots: the feed %v", m.feed)
	}
	// A watch that ended with a reason (bl watch failed) is not started again on each snapshot.
	m, _ = shown(false).watchMsg(watch.EndMsg{Gen: 3, Reason: "bl watch: exit status 1"})
	if _, restarted := at(m, "running"); restarted {
		t.Error("a watch that failed was started again")
	}
	readAt = time.Now().Add(-time.Second)
	// A watch that has not ended keeps following through a stop and a resume.
	m, _ = at(shown(false), "stopped")
	if _, restarted := at(m, "running"); restarted {
		t.Error("a watch that had not ended was restarted")
	}
	// Another run shown (↵ on F-2) starts its own watch, and F-1's resume starts none.
	m, _ = at(shown(true), "stopped")
	m.snap.Runs.Rows[1].Status = "running"
	m, _ = m.showRun("F-2")
	if _, restarted := at(m, "running"); restarted {
		t.Error("a resume of a run no longer shown restarted a watch")
	}
}
