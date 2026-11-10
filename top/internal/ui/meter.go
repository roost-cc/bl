package ui

import (
	"image/color"
	"math"
	"strings"

	"charm.land/lipgloss/v2"
)

// meter draws a quota window's meter of w cells (D4): a `■` for each share of the quota left and
// a `·` for each share used. The `■` take meterColor; the `·` are dim.
func meter(percentLeft float64, w int) string {
	filled := int(math.Round(min(max(percentLeft, 0), 100) / 100 * float64(w)))
	return lipgloss.NewStyle().Foreground(meterColor(percentLeft)).Render(strings.Repeat("■", filled)) +
		styleDim.Render(strings.Repeat("·", w-filled))
}

// meterColor is D5's color for a quota window with percentLeft left: green above 50 %, yellow
// from 20 to 50 %, red below 20 %.
func meterColor(percentLeft float64) color.Color {
	switch {
	case percentLeft > 50:
		return colorGreen
	case percentLeft >= 20:
		return colorYellow
	default:
		return colorRed
	}
}
