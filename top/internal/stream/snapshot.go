package stream

import (
	"encoding/json"
	"fmt"
	"time"
)

// Schema is the snapshot schema that bl-top reads: TOP_SCHEMA in src/top-snapshot.js.
const Schema = "bl-top-json/v1"

// Snapshot is one line of `bl top --stream`. Its fields are the ones src/top-snapshot.js writes
// (F-87 D3; src/AGENTS.md, section `bl top`).
type Snapshot struct {
	Schema    string    `json:"schema"`
	At        time.Time `json:"at"`
	Runs      Runs      `json:"runs"`
	Attention Attention `json:"attention"`
	Next      Next      `json:"next"`
	Capacity  Capacity  `json:"capacity"`
	History   History   `json:"history"`
	Activity  Activity  `json:"activity"`
	Tokens    Tokens    `json:"tokens"`
}

// Section is what every section carries: the time of its last good read, and the message of its
// last read when that read failed. A failed section keeps its last good data.
type Section struct {
	ReadAt time.Time `json:"read_at"`
	Error  string    `json:"error"`
}

// Runs is the `runs` section: the run states, newest first. Skipped are the ids of the run states
// that this read could not read: each has its last good row in Rows, or no row when it has none.
type Runs struct {
	Section
	Rows    []Run    `json:"rows"`
	Skipped []string `json:"skipped"`
}

// Run is one run state. Its times are ISO strings, as the run state holds them.
type Run struct {
	ID           string `json:"id"`
	Status       string `json:"status"`
	PID          int    `json:"pid"`
	Step         string `json:"step"`
	Round        int    `json:"round"`
	MaxRounds    int    `json:"maxRounds"`
	Story        string `json:"story"`
	StartedAt    string `json:"startedAt"`
	UpdatedAt    string `json:"updatedAt"`
	PR           *PR    `json:"pr"`
	Usage        Usage  `json:"usage"`
	Branch       string `json:"branch"`
	WorktreePath string `json:"worktreePath"`
	Agent        string `json:"agent"`
	Model        string `json:"model"`
	Effort       string `json:"effort"`
}

// Ended says whether a run status is the end of a run: every status but `running` and `stale`. A
// run ends as `clean`, `no-change`, `reviewed`, `escalated`, `failed` or `stopped`
// (src/feature-run.js); the view and the notifications both take this one definition.
func Ended(status string) bool {
	return status != "running" && status != "stale"
}

// PR is a run's pull request.
type PR struct {
	Number string `json:"number"`
	URL    string `json:"url"`
}

// Usage is a run's token use, by kind.
type Usage struct {
	Input         int `json:"input"`
	Output        int `json:"output"`
	CacheCreation int `json:"cache_creation"`
	CacheRead     int `json:"cache_read"`
}

// Attention is the `attention` section: `bl inbox`'s items in its order, and its warnings.
type Attention struct {
	Section
	Items    []Item   `json:"items"`
	Warnings []string `json:"warnings"`
}

// Item is one inbox item.
type Item struct {
	Kind  string   `json:"kind"`
	ID    string   `json:"id"`
	Unit  string   `json:"unit"`
	Line  string   `json:"line"`
	Next  string   `json:"next"`
	Path  string   `json:"path"`
	Holds []string `json:"holds"`
}

// Next is the `next` section: `bl next`'s pick and the first ranked units.
type Next struct {
	Section
	Pick          *Pick    `json:"pick"`
	Ranked        []Ranked `json:"ranked"`
	RankedCount   int      `json:"rankedCount"`
	UnrankedCount int      `json:"unrankedCount"`
}

// Pick is the unit `bl next` picks, and the unit its walk started at.
type Pick struct {
	ID     string   `json:"id"`
	Title  string   `json:"title"`
	Status string   `json:"status"`
	From   string   `json:"from"`
	Path   []string `json:"path"`
}

// Ranked is one ranked unit, what holds it from `bl run`, and the ids of those holders.
type Ranked struct {
	Position int      `json:"position"`
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Status   string   `json:"status"`
	Points   float64  `json:"points"`
	Why      string   `json:"why"`
	Holds    []string `json:"holds"`
	HeldBy   []string `json:"heldBy"`
}

// Capacity is the `capacity` section: the rows `bl capacity --json` prints.
type Capacity struct {
	Section
	Configurations []Configuration `json:"configurations"`
}

// Configuration is one agent configuration's capacity.
type Configuration struct {
	Role    string   `json:"role"`
	Agent   string   `json:"agent"`
	Model   string   `json:"model"`
	State   string   `json:"state"`
	Scope   string   `json:"scope"`
	Until   string   `json:"until"`
	Windows []Window `json:"windows"`
	Message string   `json:"message"`
}

// Window is one quota window of a configuration.
type Window struct {
	Name             string  `json:"name"`
	RemainingPercent float64 `json:"remainingPercent"`
	ResetsAt         string  `json:"resetsAt"`
}

// History is the `history` section: the last 30 days, oldest first.
type History struct {
	Section
	Days []Day `json:"days"`
}

// Day is the stories that first reached `done` on one UTC date, and their points.
type Day struct {
	Date    string   `json:"date"`
	Stories []string `json:"stories"`
	Points  float64  `json:"points"`
}

// Activity is the `activity` section: the newest run events of all run states, newest first
// (D3c).
type Activity struct {
	Section
	Events []Event `json:"events"`
}

// Event is one history entry of a run state. DurationMs is nil for an entry with no start.
type Event struct {
	At         time.Time `json:"at"`
	Unit       string    `json:"unit"`
	Step       string    `json:"step"`
	Story      string    `json:"story"`
	Round      int       `json:"round"`
	OK         *bool     `json:"ok"`
	DurationMs *int64    `json:"durationMs"`
	Agent      string    `json:"agent"`
	Model      string    `json:"model"`
	Effort     string    `json:"effort"`
	Note       string    `json:"note"`
}

// Tokens is the `tokens` section (D3b): the output tokens of each minute from From, oldest first,
// the last the minute of the snapshot, and today's totals.
type Tokens struct {
	Section
	From    time.Time `json:"from"`
	Minutes []float64 `json:"minutes"`
	Today   Usage     `json:"today"`
}

// Section returns the read time and error of the section with that name.
func (s *Snapshot) Section(name string) Section {
	switch name {
	case "runs":
		return s.Runs.Section
	case "attention":
		return s.Attention.Section
	case "next":
		return s.Next.Section
	case "capacity":
		return s.Capacity.Section
	case "history":
		return s.History.Section
	case "activity":
		return s.Activity.Section
	case "tokens":
		return s.Tokens.Section
	}
	return Section{}
}

// Decode reads one stream line. A line that is not JSON, or has another schema, is an error.
func Decode(line []byte) (Snapshot, error) {
	var s Snapshot
	if err := json.Unmarshal(line, &s); err != nil {
		return s, fmt.Errorf("a stream line is not a snapshot: %v", err)
	}
	if s.Schema != Schema {
		return s, fmt.Errorf("the stream's schema is %q; bl-top reads %q", s.Schema, Schema)
	}
	return s, nil
}
