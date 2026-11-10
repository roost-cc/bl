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

	"github.com/roost-cc/bl/top/internal/notify"
	"github.com/roost-cc/bl/top/internal/ui"
)

func main() {
	blArgv := flag.String("bl-argv", `["bl"]`, "the command that runs bl, as a JSON array")
	interval := flag.Int("interval", 2000, "the stream's refresh interval in ms")
	version := flag.Bool("version", false, "print bl-top's version and exit")
	noBell := flag.Bool("no-bell", false, "ring no terminal bell for a notification")
	noDesktop := flag.Bool("no-desktop", false, "send no desktop notification (notify-send)")
	pushArgv := flag.String("push-argv", "", "the phone push command, as a JSON array (from backlog.json's top.push)")
	noPush := flag.Bool("no-push", false, "send no phone push")
	flag.Parse()
	if *version {
		fmt.Println("bl-top", runtime.Version())
		return
	}
	argv, err := argvFlag("bl-argv", *blArgv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "bl top: %v\n", err)
		os.Exit(1)
	}
	list, err := senders(!*noDesktop, *pushArgv, !*noPush)
	if err != nil {
		fmt.Fprintf(os.Stderr, "bl top: %v\n", err)
		os.Exit(1)
	}
	final, err := tea.NewProgram(ui.New(argv, *interval, !*noBell, list)).Run()
	if err != nil {
		fmt.Fprintf(os.Stderr, "bl top: %v\n", err)
		os.Exit(1)
	}
	if reason := final.(ui.Model).Ended(); reason != "" {
		fmt.Fprintf(os.Stderr, "bl top: the snapshot stream ended: %s\n", reason)
		os.Exit(1)
	}
}

// argvFlag decodes the value of the flag name: a non-empty JSON array of strings.
func argvFlag(name, value string) ([]string, error) {
	var argv []string
	if err := json.Unmarshal([]byte(value), &argv); err != nil || len(argv) == 0 {
		return nil, fmt.Errorf("--%s must be a JSON array of strings, not %s", name, value)
	}
	return argv, nil
}

// senders are the notification senders (D8): notify-send when desktop is true and it is on PATH,
// and the phone push when push is true and pushArgv (--push-argv) names a command.
func senders(desktop bool, pushArgv string, push bool) ([]notify.Sender, error) {
	var list []notify.Sender
	if desktop {
		if s, ok := notify.Desktop(); ok {
			list = append(list, s)
		}
	}
	if push && pushArgv != "" {
		argv, err := argvFlag("push-argv", pushArgv)
		if err != nil {
			return nil, err
		}
		list = append(list, notify.Push(argv))
	}
	return list, nil
}
