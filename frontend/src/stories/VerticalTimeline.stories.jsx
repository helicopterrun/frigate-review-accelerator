/**
 * VerticalTimeline — Storybook story for font / visual experimentation.
 *
 * Font props are now wired to the Controls panel — change them live without
 * editing source files:
 *
 *   fontFamily      — applied to all canvas text
 *   tickFontSize    — tick label size (px)
 *   tickFontWeight  — tick label weight
 *   tickFontStyle   — tick label style (normal / italic)
 *   tickColor       — tick label fill color
 *   labelFontSize   — reticle badge size (px)
 *   labelFontWeight — reticle badge weight
 *   labelFontStyle  — reticle badge style
 *
 * Visual layout props:
 *   backgroundColor     — canvas background color (both zones)
 *   tickLabelXPct       — 0-100: horizontal position of tick labels (% of label zone width)
 *
 * Invariants preserved (CLAUDE.md):
 *  - cursorTs is the single source of truth; updated only by explicit user action
 *  - No API calls, no segment math, no backend coupling
 *  - Events are full objects (start_ts, label, score, has_snapshot, has_clip)
 *  - Canvas-only rendering — no per-event DOM nodes
 */

import { useState, useCallback } from 'react';
import VerticalTimeline from '../components/VerticalTimeline.jsx';
import { RETICLE_FRACTION } from '../utils/constants.js';

export default {
  title: 'Timeline/VerticalTimeline',
  component: VerticalTimeline,
  parameters: {
    layout: 'fullscreen',
  },
  argTypes: {
    // ── Behaviour controls ────────────────────────────────────────────────
    timeFormat: {
      control: { type: 'radio' },
      options: ['12h', '24h'],
      description: 'Clock display format (display-only — never affects timestamps)',
    },
    isMobile: {
      control: { type: 'boolean' },
      description: 'Mobile layout mode',
    },
    autoplayState: {
      control: { type: 'radio' },
      options: ['idle', 'advancing', 'approaching_event'],
      description: 'Autoplay state machine value',
    },
    // ── Visual layout controls ────────────────────────────────────────────
    backgroundColor: {
      control: { type: 'color' },
      description: 'Canvas background color',
    },
    tickLabelXPct: {
      control: { type: 'range', min: 0, max: 100, step: 1 },
      description: 'Legacy: horizontal position of tick labels as a % (superseded by tickLabelLeft)',
    },
    paddingLeft: {
      control: { type: 'range', min: 0, max: 40, step: 1 },
      description: 'Left edge of bar zone in px (barStart = paddingLeft)',
    },
    paddingRight: {
      control: { type: 'range', min: 0, max: 40, step: 1 },
      description: 'Right inset from canvas edge in px (barEnd = w - paddingRight)',
    },
    tickLabelLeft: {
      control: { type: 'range', min: 0, max: 60, step: 1 },
      description: 'X coordinate for tick time label fillText in px',
    },
    // ── Font controls ─────────────────────────────────────────────────────
    fontFamily: {
      control: { type: 'text' },
      description: 'Font family stack applied to all canvas text',
    },
    tickFontSize: {
      control: { type: 'range', min: 8, max: 20, step: 1 },
      description: 'Tick label size (px)',
    },
    tickFontWeight: {
      control: { type: 'select' },
      options: [100, 200, 300, 400, 500, 600, 700, 800, 900],
      description: 'Tick label weight',
    },
    tickFontStyle: {
      control: { type: 'radio' },
      options: ['normal', 'italic'],
      description: 'Tick label style',
    },
    tickColor: {
      control: { type: 'color' },
      description: 'Tick label fill color',
    },
    labelFontSize: {
      control: { type: 'range', min: 8, max: 20, step: 1 },
      description: 'Reticle badge size (px)',
    },
    labelFontWeight: {
      control: { type: 'select' },
      options: [100, 200, 300, 400, 500, 600, 700, 800, 900],
      description: 'Reticle badge weight',
    },
    labelFontStyle: {
      control: { type: 'radio' },
      options: ['normal', 'italic'],
      description: 'Reticle badge style',
    },
    secondsAccentColor: {
      control: { type: 'color' },
      description: 'Accent color for the seconds value in the reticle badge',
    },
    // ── Props managed by render function — hide from panel ────────────────
    startTs:           { table: { disable: true } },
    endTs:             { table: { disable: true } },
    cursorTs:          { table: { disable: true } },
    gaps:              { table: { disable: true } },
    events:            { table: { disable: true } },
    densityData:       { table: { disable: true } },
    activeLabels:      { table: { disable: true } },
    onSeek:            { table: { disable: true } },
    onPan:             { table: { disable: true } },
    onZoomChange:      { table: { disable: true } },
    onPreviewRequest:  { table: { disable: true } },
    onPreloadHint:     { table: { disable: true } },
  },
};

// ─── Shared mock data ────────────────────────────────────────────────────────

/**
 * Anchor to a fixed reference time so the story is deterministic.
 * Using a Tuesday mid-morning so tick labels look natural.
 */
const ANCHOR_TS = 1700000000; // 2023-11-14 22:13:20 UTC (adjust if you prefer)

const DEFAULT_RANGE_SEC = 3600; // 1 hour window

/** Build a realistic spread of events across [anchorTs-range, anchorTs+range]. */
function makeMockEvents(anchorTs, rangeSec) {
  const window = rangeSec * 2;
  const start = anchorTs - window / 2;

  // Spread ~12 events across the window with varied labels and scores
  const specs = [
    { offset: 0.04, label: 'person',  score: 0.91 },
    { offset: 0.10, label: 'car',     score: 0.87 },
    { offset: 0.18, label: 'person',  score: 0.76 },
    { offset: 0.25, label: 'dog',     score: 0.82 },
    { offset: 0.33, label: 'car',     score: 0.93 },
    { offset: 0.41, label: 'truck',   score: 0.88 },
    { offset: 0.50, label: 'person',  score: 0.95 }, // near reticle
    { offset: 0.55, label: 'bicycle', score: 0.71 },
    { offset: 0.63, label: 'person',  score: 0.84 },
    { offset: 0.72, label: 'car',     score: 0.90 },
    { offset: 0.80, label: 'package', score: 0.67 },
    { offset: 0.91, label: 'person',  score: 0.79 },
  ];

  return specs.map((s, i) => {
    const ts = start + s.offset * window;
    return {
      id:           `mock-${i}`,
      camera:       'front_door',
      start_ts:     ts,
      end_ts:       ts + 4 + Math.random() * 8,
      label:        s.label,
      score:        s.score,
      has_clip:     i % 3 === 0,
      has_snapshot: i % 2 === 0,
    };
  });
}

/** Sparse gap list — a few short "no recording" windows. */
function makeMockGaps(anchorTs, rangeSec) {
  const window = rangeSec * 2;
  const start = anchorTs - window / 2;
  return [
    { start: start + window * 0.15, end: start + window * 0.17 },
    { start: start + window * 0.60, end: start + window * 0.63 },
  ];
}

// ─── Interactive wrapper ─────────────────────────────────────────────────────

/**
 * Wraps VerticalTimeline with local state so scroll / click / zoom all work.
 * cursorTs is the single source of truth — only mutated via onPan / onSeek.
 *
 * startTs/endTs mirror the App.jsx derivation using RETICLE_FRACTION:
 *   startTs = cursorTs - rangeSec * (1 - RETICLE_FRACTION)  [past below reticle]
 *   endTs   = cursorTs + rangeSec * RETICLE_FRACTION         [future above reticle]
 */
function InteractiveTimeline({
  timeFormat, isMobile, autoplayState,
  backgroundColor, tickLabelXPct,
  paddingLeft, paddingRight, tickLabelLeft,
  fontFamily, tickFontSize, tickFontWeight, tickFontStyle, tickColor,
  labelFontSize, labelFontWeight, labelFontStyle, secondsAccentColor,
}) {
  const [cursorTs, setCursorTs]   = useState(ANCHOR_TS);
  const [rangeSec, setRangeSec]   = useState(DEFAULT_RANGE_SEC);

  const startTs = cursorTs - rangeSec * (1 - RETICLE_FRACTION);
  const endTs   = cursorTs + rangeSec * RETICLE_FRACTION;

  const events  = makeMockEvents(ANCHOR_TS, DEFAULT_RANGE_SEC);
  const gaps    = makeMockGaps(ANCHOR_TS, DEFAULT_RANGE_SEC);

  const onPan = useCallback((deltaSec) => {
    setCursorTs(prev => prev + deltaSec);
  }, []);

  const onSeek = useCallback((ts) => {
    setCursorTs(ts);
  }, []);

  const onZoomChange = useCallback((newRangeSec) => {
    setRangeSec(newRangeSec);
  }, []);

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#111' }}>
      <div style={{ width: 220, flexShrink: 0, background: '#13141f', borderRight: '1px solid #222' }}>
        <VerticalTimeline
          startTs={startTs}
          endTs={endTs}
          cursorTs={cursorTs}
          gaps={gaps}
          events={events}
          densityData={null}
          activeLabels={null}
          autoplayState={autoplayState}
          timeFormat={timeFormat}
          isMobile={isMobile}
          backgroundColor={backgroundColor}
          tickLabelXPct={tickLabelXPct}
          paddingLeft={paddingLeft}
          paddingRight={paddingRight}
          tickLabelLeft={tickLabelLeft}
          fontFamily={fontFamily}
          tickFontSize={tickFontSize}
          tickFontWeight={tickFontWeight}
          tickFontStyle={tickFontStyle}
          tickColor={tickColor}
          labelFontSize={labelFontSize}
          labelFontWeight={labelFontWeight}
          labelFontStyle={labelFontStyle}
          secondsAccentColor={secondsAccentColor}
          onPan={onPan}
          onSeek={onSeek}
          onZoomChange={onZoomChange}
          onPreviewRequest={null}
          onPreloadHint={null}
        />
      </div>
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#555',
        fontFamily: 'ui-monospace, monospace',
        fontSize: 13,
        gap: 8,
        padding: 32,
      }}>
        <div style={{ color: '#666', marginBottom: 16, fontSize: 11 }}>
          — video area (not rendered in story) —
        </div>
        <div>cursorTs: <span style={{ color: '#aaa' }}>{cursorTs.toFixed(2)}</span></div>
        <div>rangeSec: <span style={{ color: '#aaa' }}>{rangeSec}s ({(rangeSec / 3600).toFixed(1)}h)</span></div>
        <div>timeFormat: <span style={{ color: '#aaa' }}>{timeFormat}</span></div>
        <div style={{ marginTop: 24, color: '#444', fontSize: 11 }}>
          Scroll to pan · Click to seek · −/+ or slider to zoom
        </div>
        <div style={{ color: '#333', fontSize: 10, marginTop: 8 }}>
          Edit ctx.font at lines 459 / 667 / 776 → Vite HMR updates canvas
        </div>
      </div>
    </div>
  );
}

// ─── Stories ─────────────────────────────────────────────────────────────────

// Shared font defaults — match VerticalTimeline.jsx exactly so Controls start
// at the current production values.
const FONT_DEFAULTS = {
  fontFamily:          'ui-monospace, SFMono-Regular, Menlo, monospace',
  tickFontSize:        11,
  tickFontWeight:      400,
  tickFontStyle:       'normal',
  tickColor:           'rgba(74, 79, 101, 1.0)',
  labelFontSize:       12,
  labelFontWeight:     600,
  labelFontStyle:      'normal',
  secondsAccentColor:  'rgba(232, 69, 10, 0.95)',
};

// Shared visual layout defaults — match VerticalTimeline.jsx prop defaults.
const LAYOUT_DEFAULTS = {
  backgroundColor:     null,
  tickLabelXPct:       93,
};

export const Default = {
  args: { timeFormat: '12h', isMobile: false, autoplayState: 'idle', ...LAYOUT_DEFAULTS, ...FONT_DEFAULTS },
  render: (args) => <InteractiveTimeline {...args} />,
};

export const TwentyFourHour = {
  args: { timeFormat: '24h', isMobile: false, autoplayState: 'idle', ...LAYOUT_DEFAULTS, ...FONT_DEFAULTS },
  render: (args) => <InteractiveTimeline {...args} />,
};

export const Approaching = {
  args: { timeFormat: '12h', isMobile: false, autoplayState: 'approaching_event', ...LAYOUT_DEFAULTS, ...FONT_DEFAULTS },
  render: (args) => <InteractiveTimeline {...args} />,
};

export const Mobile = {
  args: { timeFormat: '12h', isMobile: true, autoplayState: 'idle', ...LAYOUT_DEFAULTS, ...FONT_DEFAULTS },
  render: (args) => <InteractiveTimeline {...args} />,
};
