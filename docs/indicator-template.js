// Template for a Quant Terminal custom indicator. The format is in docs/custom-indicators.md.
// Copy this file to custom/<your-indicator>.js, change the name, inputs, outputs and calc, and save.
// This one plots a moving average with a band a set number of standard deviations either side.
export default {
  name: "My indicator",
  overlay: true, // true: on the price chart. false: its own pane under it
  inputs: [
    { key: "length", label: "Length", type: "int", default: 20, min: 1 },
    { key: "mult", label: "Band width", type: "float", default: 2 },
    { key: "source", label: "Source", type: "source", default: "close" },
    {
      key: "average",
      label: "Average",
      type: "select",
      options: ["SMA", "EMA"],
      default: "SMA",
    },
  ],
  outputs: [
    { key: "basis", label: "Basis", kind: "line", color: "#2962ff" },
    { key: "upper", label: "Upper", kind: "line", color: "#787b86" },
    { key: "lower", label: "Lower", kind: "line", color: "#787b86" },
  ],
  // levels: [30, 70], // for an indicator in its own pane: dashed lines at these values

  // bars: [{ time, open, high, low, close, volume }], oldest first. p: the inputs above.
  // ta: the building blocks (sma, ema, rsi, atr, stdev, crossover, compute(...) and more).
  // Return one array per output, as long as bars, with NaN where there's no value yet.
  calc(bars, p, ta) {
    const src = ta.source(bars, p.source);
    const basis =
      p.average === "EMA" ? ta.ema(src, p.length) : ta.sma(src, p.length);
    const sd = ta.stdev(src, p.length);
    const upper = basis.map((b, i) => b + p.mult * sd[i]);
    const lower = basis.map((b, i) => b - p.mult * sd[i]);
    // Optional: arrows where price closes above the upper band.
    const markers = bars
      .filter(
        (bar, i) =>
          i > 0 && bar.close > upper[i] && !(bars[i - 1].close > upper[i - 1]),
      )
      .map((bar) => ({
        time: bar.time,
        position: "aboveBar",
        shape: "arrowDown",
        color: "#f23645",
        text: "Above band",
      }));
    return { basis, upper, lower, markers };
  },
};
