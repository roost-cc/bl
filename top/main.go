// bl-top is the TUI of `bl top` (F-87): a btop-style live view of bl's runs, inbox and next
// work. src/top.js builds it and runs it. It draws the snapshots of `bl top --stream`, which it
// starts through --bl-argv, and never reads a backlog file.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"runtime"

	tea "charm.land/bubbletea/v2"

	"github.com/roost-cc/bl/top/internal/ui"
)

func main() {
	blArgv := flag.String("bl-argv", `["bl"]`, "the command that runs bl, as a JSON array")
	interval := flag.Int("interval", 2000, "the stream's refresh interval in ms")
	version := flag.Bool("version", false, "print bl-top's version and exit")
	flag.Parse()
	if *version {
		fmt.Println("bl-top", runtime.Version())
		return
	}
	var argv []string
	if err := json.Unmarshal([]byte(*blArgv), &argv); err != nil || len(argv) == 0 {
		fmt.Fprintf(os.Stderr, "bl top: --bl-argv must be a JSON array of strings, not %s\n", *blArgv)
		os.Exit(1)
	}
	final, err := tea.NewProgram(ui.New(argv, *interval)).Run()
	if err != nil {
		fmt.Fprintf(os.Stderr, "bl top: %v\n", err)
		os.Exit(1)
	}
	if reason := final.(ui.Model).Ended(); reason != "" {
		fmt.Fprintf(os.Stderr, "bl top: the snapshot stream ended: %s\n", reason)
		os.Exit(1)
	}
}
