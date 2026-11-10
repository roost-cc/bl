package ui

import (
	"image/color"
	"math"
	"strings"

	"charm.land/lipgloss/v2"
)

// The braille dot bits of a cell's left and right column, from the bottom dot up (U+2800 + bits).
var (
	leftDots  = [4]rune{0x40, 0x04, 0x02, 0x01}
	rightDots = [4]rune{0x80, 0x20, 0x10, 0x08}
)

// resample fits values to n samples. When there are more values than samples, a sample is the
// highest value of its share, so a peak stays in the graph; when there are fewer, a value spans
// several samples.
func resample(values []float64, n int) []float64 {
	out := make([]float64, n)
	if len(values) == 0 {
		return out
	}
	for j := range n {
		lo := j * len(values) / n
		hi := max((j+1)*len(values)/n, lo+1)
		for _, v := range values[lo:hi] {
			out[j] = max(out[j], v)
		}
	}
	return out
}

// graph draws values as a braille area graph of w×h cells, as h lines from the top, without
// colors: two samples per cell and four dot rows per cell, oldest at the left. The highest sample
// fills the full height, and a sample above 0 fills at least one dot. A cell with no dot is a
// space.
func graph(values []float64, w, h int) []string {
	samples := resample(values, 2*w)
	top := 0.0
	for _, v := range samples {
		top = max(top, v)
	}
	dots := make([]int, len(samples))
	for i, v := range samples {
		if v > 0 {
			dots[i] = max(1, int(math.Round(v/top*float64(4*h))))
		}
	}
	lines := make([]string, h)
	for r := range h {
		below := 4 * (h - 1 - r) // the dot rows under this line
		var b strings.Builder
		for c := range w {
			cell := rune(0)
			for k := range min(max(dots[2*c]-below, 0), 4) {
				cell |= leftDots[k]
			}
			for k := range min(max(dots[2*c+1]-below, 0), 4) {
				cell |= rightDots[k]
			}
			if cell == 0 {
				b.WriteByte(' ')
			} else {
				b.WriteRune(0x2800 + cell)
			}
		}
		lines[r] = b.String()
	}
	return lines
}

// colorGraph colors each line of a graph by its height (D5): the bottom line green, the middle
// yellow, the top line red, and the lines between them blended.
func colorGraph(lines []string) []string {
	out := make([]string, len(lines))
	for r, l := range lines {
		t := 0.0
		if len(lines) > 1 {
			t = float64(len(lines)-1-r) / float64(len(lines)-1)
		}
		out[r] = lipgloss.NewStyle().Foreground(gradient(t)).Render(l)
	}
	return out
}

// gradient is btop's graph color at height t, from 0 (low) to 1 (high): green → yellow → red.
func gradient(t float64) color.Color {
	if t <= 0.5 {
		return blend(colorGreen, colorYellow, t*2)
	}
	return blend(colorYellow, colorRed, t*2-1)
}

// blend is the color t of the way from a to b.
func blend(a, b color.Color, t float64) color.Color {
	ar, ag, ab, _ := a.RGBA()
	br, bg, bb, _ := b.RGBA()
	mix := func(x, y uint32) uint8 {
		return uint8(math.Round(float64(x>>8)*(1-t) + float64(y>>8)*t))
	}
	return color.RGBA{mix(ar, br), mix(ag, bg), mix(ab, bb), 0xff}
}

// mark is a label on a graph's axis, at a cell column.
type mark struct {
	col   int
	label string
}

// axis draws marks on a line of w cells. Each label starts at its column, or further left when it
// would pass the line's end; a label that would touch the one before it is left out. Labels are
// ASCII.
func axis(marks []mark, w int) string {
	line := []byte(strings.Repeat(" ", w))
	next := 0
	for _, m := range marks {
		col := min(m.col, w-len(m.label))
		if col < next {
			continue
		}
		copy(line[col:], m.label)
		next = col + len(m.label) + 1
	}
	return styleDim.Render(string(line))
}
