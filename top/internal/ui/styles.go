// Package ui draws bl top's screen: btop's boxes in Catppuccin Mocha (F-87 D4, D5, D6).
package ui

import "charm.land/lipgloss/v2"

// Catppuccin Mocha (https://catppuccin.com/palette), with the hex values and names of logr's
// internal/tui/styles.go. D5 picks the color of each element. surface2 is the one D5 color that
// logr does not use.
var (
	colorBase     = lipgloss.Color("#1e1e2e") // base
	colorSurface2 = lipgloss.Color("#585b70") // surface2
	colorText     = lipgloss.Color("#cdd6f4") // text
	colorPeach    = lipgloss.Color("#fab387") // peach
	colorRed      = lipgloss.Color("#f38ba8") // red
	colorMauve    = lipgloss.Color("#cba6f7") // mauve
	colorGreen    = lipgloss.Color("#a6e3a1") // green
	colorYellow   = lipgloss.Color("#f9e2af") // yellow
	colorOverlay1 = lipgloss.Color("#7f849c") // overlay1
	colorSurface0 = lipgloss.Color("#313244") // surface0
	colorBlue     = lipgloss.Color("#89b4fa") // blue
	colorTeal     = lipgloss.Color("#94e2d5") // teal

	// styleBorder is a box border. styleFocus is the border of the box with the focus: mauve, the
	// color of the box names.
	styleBorder = lipgloss.NewStyle().Foreground(colorSurface2)
	styleFocus  = lipgloss.NewStyle().Foreground(colorMauve)
	styleName   = lipgloss.NewStyle().Foreground(colorMauve).Bold(true)
	styleText   = lipgloss.NewStyle().Foreground(colorText)
	styleKey    = lipgloss.NewStyle().Foreground(colorPeach)
	styleError  = lipgloss.NewStyle().Foreground(colorRed)
	styleDim    = lipgloss.NewStyle().Foreground(colorOverlay1)
	styleOK     = lipgloss.NewStyle().Foreground(colorGreen)
	styleWarn   = lipgloss.NewStyle().Foreground(colorPeach)
)
