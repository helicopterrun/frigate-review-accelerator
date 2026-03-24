/**
 * VerticalTimelinePixi.jsx — PixiJS v8 timeline with custom SVG assets
 *
 * ═══════════════════════════════════════════════════════════════════
 * ASSET MAP  (files go in  frontend/public/assets/timeline/)
 * ═══════════════════════════════════════════════════════════════════
 *
 *  rtcl-bar.svg       146×36   Two inward triangles + connecting line
 *                               Stretched to fill bar zone width.
 *                               anchor (0, 0.5) at x=barStart, y=reticleY
 *
 *  rtcl-dot.svg       15×15    Filled circle #FF592E
 *                               Two instances: barStart and barEnd edges.
 *                               anchor (0.5, 0.5)
 *
 *  object-person.svg  16×20    Person icon — stroked, no fill
 *  object-animal.svg  22×22    Animal/cat icon — stroked, no fill
 *                               Event markers. sprite.tint = label color.
 *                               At reticle row: tinted RETICLE_COLOR.
 *
 *  arrow.svg          22×47    Downward arrow + stem for NOW/PAST hints.
 *                               Flipped with scale.y=-1 for upward variant.
 *
 * ═══════════════════════════════════════════════════════════════════
 * PIXI v8 CONCEPTS — annotated throughout this file
 * ═══════════════════════════════════════════════════════════════════
 *
 *  PIXI.Assets.load()   Async. Returns a Texture. Cached by URL — safe
 *                       to call multiple times with the same path.
 *
 *  sprite.tint          Multiplies each pixel RGB by the tint color.
 *                       0xFFFFFF = no change. 0x4CAF50 = green tint.
 *                       Works because icons use stroke, not opaque fill.
 *
 *  sprite.anchor        Pivot for position and rotation.
 *                       (0,0)=top-left  (0.5,0.5)=center  (1,1)=bottom-right
 *
 *  sprite.width/height  Scales sprite to exact px dimensions.
 *                       Used to stretch rtcl-bar to barW dynamically.
 *
 *  Graphics (v8 API)    Fluent: .rect().fill()  .moveTo().lineTo().stroke()
 *                       NOT the v7 beginFill/endFill pattern.
 *
 *  RenderTexture        Off-screen GPU surface for density gradient:
 *                       write pixel data once, render as stretched sprite.
 *
 * ═══════════════════════════════════════════════════════════════════
 * HORIZONTAL ZONE LAYOUT
 * ═══════════════════════════════════════════════════════════════════
 *
 *  [0 … paddingLeft]          Tick label column (HH:MM text)
 *  [barStart … barEnd]        Bar zone — density, events, reticle
 *    barStart = paddingLeft
 *    barEnd   = w - paddingRight
 *
 * ═══════════════════════════════════════════════════════════════════
 * PROPS — identical to VerticalTimeline.jsx (drop-in replacement)
 * ═══════════════════════════════════════════════════════════════════
 */

import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import * as PIXI from 'pixi.js';
import { clampTs } from '../utils/time.js';
import { RETICLE_FRACTION } from '../utils/constants.js';

// ─── Design tokens ────────────────────────────────────────────────────────────

const RETICLE_COLOR     = 0xFF592E;   // #FF592E — orange-red from your SVGs
const RETICLE_COLOR_CSS = '#FF592E';
const RETICLE_BAR_H     = 14;        // rendered height of rtcl-bar (slimmer than the 36px SVG)
const RETICLE_DOT_SIZE  = 13;        // rendered diameter of rtcl-dot
const ICON_SIZE_PERSON  = { w: 16, h: 20 };
const ICON_SIZE_ANIMAL  = { w: 20, h: 20 };
const ICON_FALLBACK_R   = 5;         // fallback circle radius for unknown labels
const ARROW_W           = 14;
const ARROW_H           = 30;

// Icon family classification
const PERSON_LABELS = new Set(['person']);
const ANIMAL_LABELS = new Set(['dog', 'cat', 'bird', 'horse', 'bear', 'deer']);

// Asset paths — copy SVG files to frontend/public/assets/timeline/
const ASSET_PATHS = {
  rtclBar : '/assets/timeline/rtcl-bar.svg',
  rtclDot : '/assets/timeline/rtcl-dot.svg',
  person  : '/assets/timeline/object-person.svg',
  animal  : '/assets/timeline/object-animal.svg',
  arrow   : '/assets/timeline/arrow.svg',
};

// ─── Event colors ─────────────────────────────────────────────────────────────

const EVENT_COLORS = {
  person: 0x4CAF50, car: 0x2196F3, truck: 0x1565C0, motorcycle: 0xE91E63,
  bicycle: 0x00BCD4, dog: 0xFF9800, cat: 0x9C27B0, bird: 0x8BC34A,
  horse: 0x795548, bear: 0x607D8B, deer: 0xA1887F, package: 0xFFC107,
  default: 0x888888,
};

// ─── Zoom constants (identical to original) ───────────────────────────────────

const ZOOM_PRESETS = [
  { label: '30m', sec: 30*60 }, { label: '1h', sec: 3600 },
  { label: '8h',  sec: 8*3600 }, { label: '1d', sec: 24*3600 },
];
const ZOOM_STOPS = [
  5*60,8*60,10*60,15*60,20*60,30*60,45*60,
  3600,2*3600,4*3600,8*3600,12*3600,18*3600,24*3600,48*3600,7*24*3600,
];
const ZOOM_STOP_LABELS = [
  '5m','8m','10m','15m','20m','30m','45m',
  '1h','2h','4h','8h','12h','18h','24h','48h','7d',
];
const TICK_INTERVALS = [5,10,15,30,60,120,300,600,900,1800,3600,7200,10800,21600,43200,86400];
const MIN_TICK_PX    = 32;

// ─── Scroll physics (identical values to original) ────────────────────────────
const DAMPING = 0.97;
const K       = 0.06;
const K_TOUCH = 0.03;

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function nearestZoomIdx(rangeSec) {
  let best = 0, bestDiff = Math.abs(ZOOM_STOPS[0] - rangeSec);
  for (let i = 1; i < ZOOM_STOPS.length; i++) {
    const d = Math.abs(ZOOM_STOPS[i] - rangeSec);
    if (d < bestDiff) { bestDiff = d; best = i; }
  }
  return best;
}

function formatHHMM(ts, fmt) {
  const d = new Date(ts * 1000);
  const h24 = d.getHours();
  const h = fmt === '12h' ? (h24 % 12 || 12) : h24;
  return `${String(h).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function parseTs(ts, fmt) {
  if (ts == null) return null;
  const d = new Date(ts * 1000);
  const h24 = d.getHours();
  return {
    hours:   fmt === '12h' ? String(h24%12||12).padStart(2,'0') : String(h24).padStart(2,'0'),
    minutes: String(d.getMinutes()).padStart(2,'0'),
    seconds: String(d.getSeconds()).padStart(2,'0'),
    isPM:    h24 >= 12, is12h: fmt === '12h',
  };
}

function useDebounce(fn, delay) {
  const t = useRef(null);
  return useCallback((...args) => {
    clearTimeout(t.current);
    t.current = setTimeout(() => fn(...args), delay);
  }, [fn, delay]);
}

// ─── Density → 1×h pixel buffer ───────────────────────────────────────────────
// Identical algorithm to original canvas port; output is a Uint8Array
// suitable for PIXI.Texture.fromBuffer().

function buildDensityPixels(densityData, activeLabels, h, startTs, endTs) {
  if (!densityData?.buckets?.length || h < 1) return null;
  const buckets = densityData.buckets;
  const spp = (endTs - startTs) / h;

  function eff(b) {
    if (activeLabels === null) return b.total;
    return Object.entries(b.counts)
      .filter(([l]) => activeLabels.has(l))
      .reduce((s,[,c]) => s+c, 0);
  }

  const maxT = Math.max(...buckets.map(eff), 1);
  const raw  = new Float32Array(h);
  let bi     = buckets.length - 1;

  for (let y = 0; y < h; y++) {
    const ts = endTs - y * spp;
    while (bi > 0 && buckets[bi].ts > ts) bi--;
    const lo = buckets[bi], hi = bi+1 < buckets.length ? buckets[bi+1] : null;
    let norm;
    if (hi) {
      const span = hi.ts - lo.ts;
      const t = span > 0 ? Math.max(0, Math.min(1, (ts-lo.ts)/span)) : 0;
      norm = (eff(lo)*(1-t) + eff(hi)*t) / maxT;
    } else {
      norm = eff(lo) / maxT;
    }
    raw[y] = Math.max(0, Math.min(1, norm));
  }

  // 3-tap blur
  const blurred = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    blurred[y] = 0.25*(y>0?raw[y-1]:raw[y]) + 0.5*raw[y] + 0.25*(y<h-1?raw[y+1]:raw[y]);
  }

  // RGBA pixel buffer — 1px wide
  const px = new Uint8Array(h * 4);
  for (let y = 0; y < h; y++) {
    const n = blurred[y], b = y*4;
    if (n < 0.01) { px[b+3]=0; continue; }
    let r,g,c,a;
    if      (n < 0.25) { const t=n/0.25;        r=20; g=50;  c=110; a=0.04+t*0.08; }
    else if (n < 0.5)  { const t=(n-0.25)/0.25; r=30; g=80;  c=150; a=0.12+t*0.13; }
    else if (n < 0.75) { const t=(n-0.5)/0.25;  r=40; g=130; c=190; a=0.25+t*0.20; }
    else               { const t=(n-0.75)/0.25;  r=80; g=190; c=230; a=0.45+t*0.20; }
    px[b]=r; px[b+1]=g; px[b+2]=c; px[b+3]=Math.round(a*255);
  }
  return px;
}

// ─── Pixi Application factory ──────────────────────────────────────────────────
// TEACHING NOTE: v8 Application.init() is async because WebGPU device
// acquisition requires an async handshake with the GPU driver.

async function createApp(canvas, w, h, bgColor) {
  const app = new PIXI.Application();
  await app.init({
    canvas,
    width: w, height: h,
    backgroundColor: parseInt(bgColor.replace('#',''), 16),
    antialias:    true,
    autoDensity:  true,    // handles window.devicePixelRatio automatically
    resolution:   window.devicePixelRatio || 1,
    preference:   'webgpu', // uses WebGL automatically when WebGPU unavailable
  });
  return app;
}

// ─── Main component ────────────────────────────────────────────────────────────

export default function VerticalTimelinePixi({
  startTs,
  endTs,
  gaps          = [],
  events        = [],
  densityData   = null,
  activeLabels  = null,
  cursorTs,
  autoplayState = 'idle',
  onSeek,
  onPan,
  onZoomChange,
  onPreviewRequest  = null,
  isMobile          = false,
  timeFormat        = '12h',
  onPreloadHint     = null,
  fontFamily        = 'IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace',
  tickFontSize      = 16,
  tickFontWeight    = 400,
  tickColor         = 'rgba(97,137,67,1)',
  labelFontSize     = 12,
  labelFontWeight   = 600,
  secondsAccentColor= 'rgba(232,69,10,0.95)',
  backgroundColor   = '#0B0E14',
  paddingLeft       = 40,
  paddingRight      = 8,
  tickLabelLeft     = 4,
  showDensity       = false,
}) {
  const canvasRef   = useRef(null);
  const appRef      = useRef(null);
  const appReadyRef = useRef(false);
  const layersRef   = useRef({});
  const texRef      = useRef({});  // { rtclBar, rtclDot, person, animal, arrow }

  // Physics refs — identical to original
  const isDragging        = useRef(false);
  const touchStartRef     = useRef(null);
  const scrollVelocityRef = useRef(0);
  const scrollRafRef      = useRef(null);
  const touchPannedRef    = useRef(false);
  const scrubLastYRef     = useRef(null);
  const scrubVelocityRef  = useRef(0);
  const scrubIdleTimerRef = useRef(null);
  const lastPreloadTsRef  = useRef(null);

  // Cursor animation refs — identical to original
  const displayCursorRef = useRef(cursorTs);
  const animRef          = useRef(null);

  const [dims,   setDims]  = useState({ w: 215, h: 600 });
  const [rparts, setRP]    = useState(() => parseTs(cursorTs, timeFormat));
  const [loaded, setLoaded]= useState(false); // triggers redraw after assets arrive

  useEffect(() => setRP(parseTs(cursorTs, timeFormat)), [cursorTs, timeFormat]);

  const range           = endTs - startTs;
  const secondsPerPixel = useMemo(() => dims.h > 0 ? range/dims.h : 1, [range, dims.h]);
  const zoomIdx         = nearestZoomIdx(range);

  const tsToY = useCallback(ts => (endTs - ts) / secondsPerPixel, [endTs, secondsPerPixel]);
  const yToTs = useCallback(y  => clampTs(endTs - y*secondsPerPixel, startTs, endTs), [startTs,endTs,secondsPerPixel]);

  const debouncedPreview = useDebounce(ts => onPreviewRequest?.(ts), 300);

  // ── Init: Pixi app + parallel SVG asset load ────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let dead = false;

    (async () => {
      const app = await createApp(canvas, dims.w, dims.h, backgroundColor);
      if (dead) { app.destroy(); return; }
      appRef.current = app;

      // Load all 5 SVGs in parallel.
      // TEACHING NOTE: PIXI.Assets.load caches by URL. If any file 404s,
      // the catch below logs a warning and falls back to Graphics drawing.
      try {
        const [rtclBar, rtclDot, person, animal, arrow] = await Promise.all(
          Object.values(ASSET_PATHS).map(p => PIXI.Assets.load(p))
        );
        if (!dead) texRef.current = { rtclBar, rtclDot, person, animal, arrow };
      } catch(e) {
        console.warn('[PixiTimeline] SVG load failed — check public/assets/timeline/', e.message);
      }

      // Scene graph — layer order = draw order (first child = bottom)
      const bg        = new PIXI.Graphics();
      const densityC  = new PIXI.Container();  // density sprite lives here
      const gapG      = new PIXI.Graphics();
      const ticksC    = new PIXI.Container();  // Text + hairlines
      const evtC      = new PIXI.Container();  // event icons + score bars
      const hintC     = new PIXI.Container();  // NOW/PAST arrows
      const reticleC  = new PIXI.Container();  // bar + dots (top layer)

      app.stage.addChild(bg, densityC, gapG, ticksC, evtC, hintC, reticleC);
      layersRef.current = { bg, densityC, gapG, ticksC, evtC, hintC, reticleC };

      appReadyRef.current = true;
      if (!dead) setLoaded(true);
    })();

    return () => {
      dead = true;
      appReadyRef.current = false;
      appRef.current?.destroy(false); // false = keep the <canvas> DOM element
      appRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resize renderer when dims change
  useEffect(() => {
    if (!appReadyRef.current) return;
    appRef.current.renderer.resize(dims.w, dims.h);
    drawAll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dims]);

  // ResizeObserver
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const obs = new ResizeObserver(entries => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        setDims({ w: Math.max(width,1), h: Math.max(height,1) });
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // ── Sprite factory helpers ────────────────────────────────────────────────

  // TEACHING NOTE: Sprites are cheap to create — they're just a reference to
  // an existing Texture plus transform data. Multiple Sprites can share one
  // Texture; the GPU texture is uploaded exactly once.
  function makeSprite(tex, { w, h, ax=0.5, ay=0.5, tint=0xFFFFFF, alpha=1 } = {}) {
    if (!tex) return null;
    const s   = new PIXI.Sprite(tex);
    s.anchor.set(ax, ay);
    if (w != null) s.width  = w;
    if (h != null) s.height = h;
    s.tint  = tint;
    s.alpha = alpha;
    return s;
  }

  // Return the correct icon sprite (or fallback Graphics) for a label.
  // tint is a hex number e.g. 0x4CAF50
  function makeEventIcon(label, tint, alpha=1) {
    const isPerson = PERSON_LABELS.has(label);
    const isAnimal = ANIMAL_LABELS.has(label);
    const tex      = isPerson ? texRef.current.person
                   : isAnimal ? texRef.current.animal
                   : null;

    if (tex) {
      const dim = isPerson ? ICON_SIZE_PERSON : ICON_SIZE_ANIMAL;
      return makeSprite(tex, { w:dim.w, h:dim.h, tint, alpha });
    }

    // Fallback: small filled circle
    const g = new PIXI.Graphics();
    g.circle(0, 0, ICON_FALLBACK_R).fill({ color: tint, alpha });
    return g;
  }

  // ── Reticle builder ───────────────────────────────────────────────────────
  // Called from drawAll AND from the 60fps drawReticleOnly path.
  // Extracts to a standalone function so both callers share identical logic.

  function buildReticle(container, barStart, barEnd, barW, reticleY) {
    container.removeChildren();
    const tex = texRef.current;

    if (tex.rtclBar && tex.rtclDot) {
      // ── SVG sprite path ────────────────────────────────────────────────────
      // rtcl-bar: stretched to fill the full bar zone width.
      // TEACHING NOTE: The SVG viewBox is 146×36. We ignore the natural size
      // and set width=barW, height=RETICLE_BAR_H. Pixi stretches the texture.
      // The triangle arrow shapes at each end of the SVG will scale with the bar —
      // this is intentional; the design assumes they stay at the edges.
      const bar = makeSprite(tex.rtclBar, {
        w: barW, h: RETICLE_BAR_H,
        ax: 0, ay: 0.5,          // anchor: left edge, vertically centered
        tint: RETICLE_COLOR,
      });
      bar.x = barStart;
      bar.y = reticleY;
      container.addChild(bar);

      // Left dot — centered on barStart
      const dotL = makeSprite(tex.rtclDot, { w: RETICLE_DOT_SIZE, h: RETICLE_DOT_SIZE });
      dotL.x = barStart; dotL.y = reticleY;
      container.addChild(dotL);

      // Right dot — centered on barEnd
      const dotR = makeSprite(tex.rtclDot, { w: RETICLE_DOT_SIZE, h: RETICLE_DOT_SIZE });
      dotR.x = barEnd; dotR.y = reticleY;
      container.addChild(dotR);

    } else {
      // ── Graphics fallback (shown before SVGs load / if load fails) ────────
      const g = new PIXI.Graphics();
      const sz = 5, mid = barStart + barW/2;
      g.moveTo(barStart, reticleY).lineTo(barEnd, reticleY)
       .stroke({ color: RETICLE_COLOR, alpha: 0.9, width: 2 });
      g.poly([mid, reticleY, mid-sz, reticleY-sz, mid-sz, reticleY+sz])
       .fill({ color: RETICLE_COLOR });
      g.poly([barEnd, reticleY, barEnd+sz, reticleY-sz, barEnd+sz, reticleY+sz])
       .fill({ color: RETICLE_COLOR });
      g.circle(barStart, reticleY, RETICLE_DOT_SIZE/2).fill({ color: RETICLE_COLOR });
      g.circle(barEnd,   reticleY, RETICLE_DOT_SIZE/2).fill({ color: RETICLE_COLOR });
      container.addChild(g);
    }
  }

  // ── Scroll hint builder ───────────────────────────────────────────────────

  function buildScrollHints(container, w, h, barStart, barW) {
    container.removeChildren();
    const tex = texRef.current;
    if (!tex.arrow) return;

    const midX = barStart + barW/2;

    // PAST (top) — arrow pointing UP
    // The arrow SVG is downward-pointing. scale.y = -1 flips it upward.
    // TEACHING NOTE: After flipping with scale.y=-1, the sprite renders
    // "upside down" relative to its anchor. anchor.y=1 means the pivot is
    // at the visual top (which is now the original bottom after flip).
    for (const xOff of [-ARROW_W*0.6, ARROW_W*0.6]) {
      const s = makeSprite(tex.arrow, { w:ARROW_W, h:ARROW_H, ax:0.5, ay:1, tint:0x808080, alpha:0.55 });
      s.scale.y = -1;
      s.x = midX + xOff; s.y = 32;
      container.addChild(s);
    }
    const pastTxt = new PIXI.Text({ text:'PAST', style: new PIXI.TextStyle({
      fontFamily:'IBM Plex Mono,monospace', fontSize:10, fill:'#808080'
    })});
    pastTxt.anchor.set(0.5,0.5); pastTxt.rotation = -Math.PI/2;
    pastTxt.x = midX; pastTxt.y = 10;
    container.addChild(pastTxt);

    // NOW (bottom) — arrow pointing DOWN (natural SVG orientation)
    for (const xOff of [-ARROW_W*0.6, ARROW_W*0.6]) {
      const s = makeSprite(tex.arrow, { w:ARROW_W, h:ARROW_H, ax:0.5, ay:0, tint:0x808080, alpha:0.55 });
      s.x = midX + xOff; s.y = h - 32;
      container.addChild(s);
    }
    const nowTxt = new PIXI.Text({ text:'NOW', style: new PIXI.TextStyle({
      fontFamily:'IBM Plex Mono,monospace', fontSize:10, fill:'#808080'
    })});
    nowTxt.anchor.set(0.5,0.5); nowTxt.rotation = -Math.PI/2;
    nowTxt.x = midX; nowTxt.y = h - 10;
    container.addChild(nowTxt);
  }

  // ── drawAll: rebuild every layer ──────────────────────────────────────────
  // NOT called every frame. Called when data or layout changes (~30s cadence
  // driven by the timeline fetch in App.jsx, plus on resize).

  const drawAll = useCallback(() => {
    if (!appReadyRef.current) return;
    const { bg, densityC, gapG, ticksC, evtC, hintC, reticleC } = layersRef.current;
    const { w, h } = dims;
    const barStart = paddingLeft;
    const barEnd   = w - paddingRight;
    const barW     = barEnd - barStart;
    const reticleY = h * RETICLE_FRACTION;
    const bgNum    = parseInt(backgroundColor.replace('#',''), 16);

    // 1. Background
    bg.clear();
    bg.rect(0, 0, w, h).fill({ color: bgNum });

    // 2. Density gradient
    // TEACHING NOTE: We build a 1×h pixel buffer and upload it as a GPU
    // texture. A Sprite stretches it to fill the full bar zone width.
    // This replaces thousands of ctx.fillRect(x,y,barW,1) calls.
    densityC.removeChildren();
    if (showDensity && densityData?.buckets?.length) {
      const px = buildDensityPixels(densityData, activeLabels, h, startTs, endTs);
      if (px) {
        try {
          const tex = PIXI.Texture.fromBuffer({ data:px, width:1, height:h });
          const spr = new PIXI.Sprite(tex);
          spr.anchor.set(0,0); spr.x=barStart; spr.y=0; spr.width=barW; spr.height=h;
          densityC.addChild(spr);
        } catch {}
      }
    }

    // 3. Gap fills
    gapG.clear();
    if (showDensity) {
      for (const gap of gaps) {
        const ya=tsToY(gap.start_ts), yb=tsToY(gap.end_ts);
        const y1=Math.max(0,Math.min(ya,yb)), y2=Math.min(h,Math.max(ya,yb));
        if (y2-y1 >= 1) gapG.rect(barStart,y1,barW,y2-y1).fill({color:0x0f0505,alpha:0.3});
      }
    }

    // 4. Tick labels + hairlines
    // TEACHING NOTE: Removing all children and recreating Text objects each
    // drawAll call is acceptable because drawAll runs at ~30s intervals.
    // For 60fps updates we use drawReticleOnly() which skips this layer.
    ticksC.removeChildren();
    const maxTicks  = Math.floor(h / MIN_TICK_PX);
    const tickSec   = TICK_INTERVALS.find(t => t >= (endTs-startTs)/maxTicks) ?? 86400;
    const firstTick = Math.ceil(startTs/tickSec)*tickSec;

    for (let t = firstTick; t <= endTs; t += tickSec) {
      const y = tsToY(t);

      // Hairline across full bar zone
      const line = new PIXI.Graphics();
      line.moveTo(barStart,y).lineTo(barEnd,y).stroke({color:0x1a1e2b,alpha:0.7,width:1});
      ticksC.addChild(line);

      // Fade label near reticle
      const dist = Math.abs(y - reticleY);
      const fade = Math.max(0, Math.min(1, dist>48?1 : dist<14?0 : (dist-14)/34));
      if (fade <= 0) continue;

      const lbl = new PIXI.Text({
        text: formatHHMM(t, timeFormat),
        style: new PIXI.TextStyle({ fontFamily, fontSize:tickFontSize, fontWeight:String(tickFontWeight), fill:tickColor }),
      });
      lbl.anchor.set(0, 0.5);
      lbl.x = tickLabelLeft; lbl.y = y; lbl.alpha = fade;
      ticksC.addChild(lbl);
    }

    // 5. Event markers
    evtC.removeChildren();
    const visible = [];
    for (const evt of events) {
      const ts = evt.start_ts ?? evt.start_time ?? evt.timestamp;
      if (ts == null) continue;
      const y = tsToY(ts);
      if (y < -20 || y > h+20) continue;
      visible.push({ evt, y, dist: Math.abs(y-reticleY) });
    }

    if (events.length > 0 && visible.length === 0) {
      const inRange = events.some(e => {
        const ts = e.start_ts ?? e.start_time ?? e.timestamp;
        return ts != null && ts >= startTs && ts <= endTs;
      });
      if (inRange) console.warn('[PixiTimeline] Events in range but not visible');
    }

    visible.sort((a,b) => a.dist-b.dist);
    const labeledYs = [];

    for (const { evt, y, dist } of visible) {
      const col     = EVENT_COLORS[evt.label] ?? EVENT_COLORS.default;
      const opacity = dist <= 60 ? 1.0 : 0.75;

      // Score bar — horizontal line proportional to confidence score
      if (evt.score != null) {
        const bar = new PIXI.Graphics();
        bar.moveTo(barStart, y).lineTo(barStart + evt.score*barW, y)
           .stroke({ color:col, alpha:opacity, width:2 });
        evtC.addChild(bar);
      }

      // Icon — placed at left edge of bar zone, deduplicated by y proximity
      const noOverlap = !labeledYs.some(ly => Math.abs(y-ly) < 18);
      if (noOverlap) {
        labeledYs.push(y);
        const icon = makeEventIcon(evt.label, col, opacity);
        if (icon) { icon.x = barStart + 10; icon.y = y; evtC.addChild(icon); }
      }
    }

    // 6. Scroll hints
    buildScrollHints(hintC, w, h, barStart, barW);

    // 7. Reticle — top layer
    buildReticle(reticleC, barStart, barEnd, barW, reticleY);

    appRef.current?.render();
  }, [
    dims, startTs, endTs, gaps, events, densityData, activeLabels,
    tsToY, timeFormat, fontFamily, tickFontSize, tickFontWeight, tickColor,
    tickLabelLeft, paddingLeft, paddingRight, backgroundColor, showDensity, loaded,
  ]);

  // ── drawReticleOnly: 60fps fast path ─────────────────────────────────────
  // TEACHING NOTE: This is where retained-mode pays off. At 60fps during
  // autoplay, we only touch the reticle Container — 6 display objects.
  // All other containers (density, events, ticks) are composited by Pixi
  // from its GPU layer cache with zero CPU intervention.
  // Compare with the original canvas 2d port which needed getImageData +
  // putImageData snapshot tricks to achieve the same isolation.

  const drawReticleOnly = useCallback(() => {
    if (!appReadyRef.current) return;
    const { reticleC } = layersRef.current;
    const { w, h }     = dims;
    const barStart     = paddingLeft;
    const barEnd       = w - paddingRight;
    const barW         = barEnd - barStart;
    const reticleY     = h * RETICLE_FRACTION;
    buildReticle(reticleC, barStart, barEnd, barW, reticleY);
    appRef.current?.render();
  }, [dims, paddingLeft, paddingRight, loaded]);

  // Sync cursor ref + redraw on cursorTs change (from autoplay or navigation)
  useEffect(() => {
    if (!animRef.current) {
      displayCursorRef.current = cursorTs;
      drawReticleOnly();
    }
  }, [cursorTs, drawReticleOnly]);

  // Full redraw on data changes
  useEffect(() => { if (appReadyRef.current) drawAll(); }, [drawAll]);

  // Cleanup
  useEffect(() => () => {
    if (animRef.current?.rafId) cancelAnimationFrame(animRef.current.rafId);
    clearTimeout(scrubIdleTimerRef.current);
  }, []);

  // ─── Scroll physics (identical to original) ────────────────────────────────

  const decayScroll = useCallback(() => {
    const DEAD  = secondsPerPixel * 0.002;
    const rs    = endTs - startTs;
    const zf    = Math.min(1.0, rs/3600);
    scrollVelocityRef.current *= 0.88 + (DAMPING-0.88)*zf;
    if (Math.abs(scrollVelocityRef.current) < DEAD) {
      scrollVelocityRef.current = 0; scrollRafRef.current = null; return;
    }
    onPan(scrollVelocityRef.current);
    scrollRafRef.current = requestAnimationFrame(decayScroll);
  }, [onPan, secondsPerPixel, endTs, startTs]);

  const handleWheel = useCallback((e) => {
    if (!onPan) return;
    e.preventDefault();
    if (scrollRafRef.current) { cancelAnimationFrame(scrollRafRef.current); scrollRafRef.current=null; }
    const nd     = Math.sign(e.deltaY)*Math.min(Math.abs(e.deltaY),15);
    const curved = Math.sign(nd)*(nd/15)**2*15;
    const zf     = Math.min(1.0,(endTs-startTs)/3600);
    scrollVelocityRef.current += curved*secondsPerPixel*K*(0.3+0.7*zf);
    onPan(scrollVelocityRef.current);
    const maxV = Math.min((endTs-startTs)*0.10,3600);
    scrollVelocityRef.current = Math.max(-maxV,Math.min(maxV,scrollVelocityRef.current));
    scrollRafRef.current = requestAnimationFrame(decayScroll);
  }, [onPan,secondsPerPixel,endTs,startTs,decayScroll]);

  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    c.addEventListener('wheel', handleWheel, { passive:false });
    return () => { c.removeEventListener('wheel', handleWheel); if(scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current); };
  }, [handleWheel]);

  // ─── Zoom ──────────────────────────────────────────────────────────────────
  const applyZoom = useCallback(idx => {
    const c = Math.max(0, Math.min(ZOOM_STOPS.length-1, idx));
    onZoomChange?.(ZOOM_STOPS[c]);
  }, [onZoomChange]);

  // ─── Mouse / touch (identical logic to original) ──────────────────────────

  const getTs = useCallback(e => {
    const r = canvasRef.current?.getBoundingClientRect();
    return r ? yToTs(e.clientY - r.top) : null;
  }, [yToTs]);

  const handleMouseDown = useCallback(() => { isDragging.current = true; }, []);

  const handleMouseMove = useCallback(e => {
    const ts = getTs(e);
    if (ts != null) debouncedPreview(ts);
    const now = performance.now();
    const r   = canvasRef.current?.getBoundingClientRect();
    if (r) {
      const cy = e.clientY - r.top;
      if (scrubLastYRef.current != null) {
        const dt = now - scrubLastYRef.current.time;
        if (dt > 0) scrubVelocityRef.current = Math.abs(cy - scrubLastYRef.current.y)/dt;
      }
      scrubLastYRef.current = { y:cy, time:now };
    }
    if (isDragging.current && scrubVelocityRef.current < 0.5 && ts != null && onPreloadHint) {
      clearTimeout(scrubIdleTimerRef.current);
      scrubIdleTimerRef.current = setTimeout(() => {
        if (lastPreloadTsRef.current==null || Math.abs(lastPreloadTsRef.current-ts)>2) {
          lastPreloadTsRef.current = ts; onPreloadHint(ts);
        }
      }, 120);
    }
  }, [getTs, debouncedPreview, onPreloadHint]);

  const handleMouseUp = useCallback(e => {
    if (!isDragging.current) return;
    isDragging.current=false; scrubLastYRef.current=null; scrubVelocityRef.current=0;
    clearTimeout(scrubIdleTimerRef.current);
    const ts = getTs(e);
    if (ts==null) return;

    // 250ms ease-out cursor animation (identical to original)
    const from=displayCursorRef.current??ts, t0=performance.now();
    if (animRef.current?.rafId) cancelAnimationFrame(animRef.current.rafId);

    function tick(now) {
      const p = Math.min((now-t0)/250,1);
      displayCursorRef.current = from+(ts-from)*(1-(1-p)**3);
      drawReticleOnly();
      if (p<1) animRef.current.rafId=requestAnimationFrame(tick);
      else { displayCursorRef.current=ts; animRef.current=null; }
    }
    animRef.current = { rafId: requestAnimationFrame(tick) };
    onSeek?.(ts);
  }, [getTs, onSeek, drawReticleOnly]);

  const handleMouseLeave = useCallback(() => {
    scrollVelocityRef.current=0;
    if(scrollRafRef.current){cancelAnimationFrame(scrollRafRef.current);scrollRafRef.current=null;}
    isDragging.current=false; scrubLastYRef.current=null; scrubVelocityRef.current=0;
    clearTimeout(scrubIdleTimerRef.current);
  }, []);

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ width:'100%',height:'100%',userSelect:'none',display:'flex',flexDirection:'column',touchAction:'none' }}>

      <div style={{ flex:1,minHeight:0,position:'relative' }}>
        <canvas
          ref={canvasRef}
          style={{ display:'block',width:'100%',height:'100%',touchAction:'none',cursor:'crosshair' }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onTouchStart={e => {
            scrollVelocityRef.current=0; touchPannedRef.current=false;
            if(scrollRafRef.current){cancelAnimationFrame(scrollRafRef.current);scrollRafRef.current=null;}
            e.preventDefault(); e.stopPropagation();
            const t=e.touches[0]; touchStartRef.current={x:t.clientX,y:t.clientY};
            handleMouseDown();
          }}
          onTouchMove={e => {
            e.preventDefault(); e.stopPropagation();
            const t=e.touches[0];
            const dy=t.clientY-(touchStartRef.current?.y??t.clientY);
            if(Math.abs(dy)>5 && onPan){
              touchPannedRef.current=true;
              if(scrollRafRef.current){cancelAnimationFrame(scrollRafRef.current);scrollRafRef.current=null;}
              const nd=Math.sign(dy)*Math.min(Math.abs(dy),60);
              const curved=Math.sign(nd)*(nd/60)**2*60;
              const zf=Math.min(1.0,(endTs-startTs)/3600);
              scrollVelocityRef.current=curved*secondsPerPixel*K_TOUCH*(0.3+0.7*zf);
              onPan(scrollVelocityRef.current);
              touchStartRef.current={x:t.clientX,y:t.clientY};
              return;
            }
            handleMouseMove({clientX:t.clientX,clientY:t.clientY});
          }}
          onTouchEnd={e => {
            e.preventDefault(); e.stopPropagation();
            const t=e.changedTouches[0];
            if(touchPannedRef.current){
              if(Math.abs(scrollVelocityRef.current)>secondsPerPixel*0.002){
                if(scrollRafRef.current)cancelAnimationFrame(scrollRafRef.current);
                scrollRafRef.current=requestAnimationFrame(decayScroll);
              }
              isDragging.current=false; scrubLastYRef.current=null; scrubVelocityRef.current=0;
            } else {
              handleMouseUp({clientX:t.clientX,clientY:t.clientY});
            }
          }}
        />

        {/* DOM reticle badge — stays as React JSX
            TEACHING NOTE: A live clock updating every second is cheaper in the
            DOM than in Pixi, because browsers skip GPU texture re-upload for
            text-only DOM changes. We keep this layer in React intentionally. */}
        {rparts && (
          <div style={{
            position:'absolute', top:`calc(${RETICLE_FRACTION*100}% - 24px)`,
            left:paddingLeft, right:paddingRight,
            height:48, display:'flex', alignItems:'center',
            pointerEvents:'none', userSelect:'none',
          }}>
            <div style={{ display:'flex',alignItems:'center',gap:6,padding:'4px 10px' }}>
              {rparts.is12h && (
                <div style={{ display:'flex',flexDirection:'column',alignItems:'center',lineHeight:1,fontFamily,fontSize:10,fontWeight:700,letterSpacing:'0.05em' }}>
                  <span style={{ color:rparts.isPM?'rgba(255,255,255,0.25)':'rgba(255,255,255,0.95)' }}>AM</span>
                  <span style={{ color:rparts.isPM?'rgba(255,255,255,0.95)':'rgba(255,255,255,0.25)' }}>PM</span>
                </div>
              )}
              <span style={{ fontFamily,fontSize:labelFontSize*2.2,fontWeight:labelFontWeight,color:'rgba(255,255,255,0.95)',letterSpacing:'-0.02em',lineHeight:1 }}>
                {rparts.hours}:{rparts.minutes}
              </span>
              <div style={{ display:'flex',flexDirection:'column',alignItems:'flex-start',lineHeight:1 }}>
                <span style={{ fontFamily,fontSize:labelFontSize*1.4,fontWeight:labelFontWeight,color:secondsAccentColor,letterSpacing:'-0.01em' }}>
                  {rparts.seconds}
                </span>
                <span style={{ fontFamily,fontSize:8,fontWeight:700,color:secondsAccentColor,opacity:0.7,letterSpacing:'0.08em' }}>SEC</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Zoom strip — identical DOM structure to original */}
      <div style={{ display:'flex',flexDirection:'column',gap:4,padding:'5px 8px 6px',flexShrink:0,borderTop:'1px solid #1e2130',background:'#090b10' }}>
        <div style={{ display:'flex',gap:4 }}>
          {ZOOM_PRESETS.map(p => {
            const active = Math.abs(range-p.sec) <= p.sec*0.05;
            return (
              <button key={p.label} onClick={() => onZoomChange?.(p.sec)} style={{
                flex:1,height:20,fontSize:11,padding:0,borderRadius:4,cursor:'pointer',
                background:active?'#1e3a5c':'#1a1d27', color:active?'#90c8f0':'#888',
                border:`1px solid ${active?'#3a6a9c':'#333'}`,
              }}>{p.label}</button>
            );
          })}
        </div>
        <div style={{ display:'flex',alignItems:'center',gap:6 }}>
          <button onClick={() => applyZoom(zoomIdx+1)} disabled={zoomIdx>=ZOOM_STOPS.length-1}
            style={{ width:isMobile?36:28,height:isMobile?36:28,background:'#1a1d27',border:'1px solid #333',color:'#aaa',borderRadius:4,cursor:'pointer',fontSize:isMobile?20:16 }}>−</button>
          <input type="range" min={0} max={ZOOM_STOPS.length-1} value={zoomIdx}
            onChange={e=>applyZoom(Number(e.target.value))}
            style={{ flex:1,accentColor:'#4a90d9',cursor:'pointer' }} />
          <span style={{ fontSize:11,fontFamily:'monospace',color:'#666',minWidth:28,textAlign:'right' }}>
            {ZOOM_STOP_LABELS[zoomIdx]}
          </span>
          <button onClick={() => applyZoom(zoomIdx-1)} disabled={zoomIdx<=0}
            style={{ width:isMobile?36:28,height:isMobile?36:28,background:'#1a1d27',border:'1px solid #333',color:'#aaa',borderRadius:4,cursor:'pointer',fontSize:isMobile?20:16 }}>+</button>
        </div>
      </div>
    </div>
  );
}
