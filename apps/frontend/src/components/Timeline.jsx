import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import * as PIXI from 'pixi.js';
import { clampTs, formatHHMM } from '../utils/time.js';
import {
  RETICLE_FRACTION, RETICLE_COLOR, RETICLE_BAR_H, RETICLE_DOT_SIZE,
  ICON_SIZE_PERSON, ICON_SIZE_ANIMAL, ICON_FALLBACK_R,
  ARROW_W, ARROW_H, PERSON_LABELS, ANIMAL_LABELS,
  EVENT_COLORS, ASSET_PATHS, TICK_INTERVALS, MIN_TICK_PX,
  DAMPING, K, K_TOUCH,
} from '../utils/constants.js';

const WHEEL = {
  rowHeight: 112,
  displayRadius: 900,
  depthPower: 8.0,
  minScale: 0.02,
  maxScale: 1.0,
  minAlpha: 0.0,
  maxAlpha: 1.0,
  sideParallax: 30,
  textParallax: 12,
  visibleBackCutoff: -0.08,
  dividerMinAlpha: 0.0,
  dividerFrontAlpha: 0.25,
  unselectedTextColor: 0x6b7080,
  selectedTextColor: 0xf5f0ea,
  centerLineColor: 0x6b7485,
  centerLineAlpha: 0.22,
  rowPoolSize: 75,
};

// ── PixiJS app factory ───────────────────────────────────────────────────────

async function createApp(canvas, w, h) {
  const app = new PIXI.Application();
  await app.init({
    canvas,
    width: w,
    height: h,
    backgroundColor: 0x1a1d24,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    preference: 'webgpu',
  });
  return app;
}

// ── Lucide icon mapping (label → lucide icon name) ──────────────────────────

const LABEL_TO_LUCIDE = {
  person: 'user', face: 'scan-face',
  car: 'car', motorcycle: 'bike', bicycle: 'bike',
  licence_plate: 'car',
  amazon: 'truck', fedex: 'truck', ups: 'truck', dhl: 'truck',
  usps: 'mail',
  dog: 'bone', cat: 'paw-print', deer: 'paw-print', raccoon: 'paw-print',
  squirrel: 'paw-print', rabbit: 'paw-print',
  package: 'package', bird: 'bird',
};

// All unique lucide icon names we need to preload
const LUCIDE_ICONS_TO_LOAD = [
  'user', 'scan-face', 'car', 'bike', 'truck', 'mail',
  'bone', 'paw-print', 'package', 'bird',
];

function shortestAngleDiff(a, b) {
  const TAU = Math.PI * 2;
  let d = a - b;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
}

function pickTickInterval(rangeSec, h) {
  const maxTicks = Math.max(3, Math.floor(h / MIN_TICK_PX));
  return TICK_INTERVALS.find(t => t >= rangeSec / maxTicks) ?? 86400;
}

function formatParts(ts, timeFormat) {
  const d = new Date(ts * 1000);
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = d.getSeconds();
  const is12h = timeFormat === '12h';
  const isPM = hours >= 12;

  let displayHours = hours;
  if (is12h) {
    displayHours = hours % 12;
    if (displayHours === 0) displayHours = 12;
  }

  return {
    hh: String(displayHours).padStart(2, '0'),
    mm: String(minutes).padStart(2, '0'),
    ss: String(seconds).padStart(2, '0'),
    is12h,
    isPM,
  };
}

function createWheelRow(fontFamily) {
  const row = new PIXI.Container();

  const divider = new PIXI.Graphics();
  row.addChild(divider);

  const simpleText = new PIXI.Text({
    text: '12:00',
    style: new PIXI.TextStyle({
      fontFamily,
      fontSize: 30,
      fontWeight: '500',
      fill: '#a7afbc',
    }),
  });
  simpleText.anchor.set(0.5);
  row.addChild(simpleText);

  const centerReadout = new PIXI.Container();
  centerReadout.visible = false;
  row.addChild(centerReadout);

  const leftIconSlot = new PIXI.Container();
  const rightIconSlot = new PIXI.Container();
  row.addChild(leftIconSlot);
  row.addChild(rightIconSlot);

  row.divider = divider;
  row.simpleText = simpleText;
  row.centerReadout = centerReadout;
  row.leftIconSlot = leftIconSlot;
  row.rightIconSlot = rightIconSlot;

  return row;
}

function buildCenterReadout(container, parts, fontFamily) {
  container.removeChildren();

  const white = 0xf5f0ea;
  const orange = RETICLE_COLOR;

  let x = 0;

  // AM/PM badge — only show the active one in a rounded rect
  if (parts.is12h) {
    const badgeLabel = parts.isPM ? 'PM' : 'AM';

    const badgeBg = new PIXI.Graphics();
    badgeBg.roundRect(-2, -14, 32, 28, 6).stroke({ color: 0x888888, alpha: 0.6, width: 1.5 });
    container.addChild(badgeBg);

    const badge = new PIXI.Text({
      text: badgeLabel,
      style: new PIXI.TextStyle({
        fontFamily,
        fontSize: 13,
        fontWeight: '700',
        fill: white,
      }),
    });
    badge.anchor.set(0.5, 0.5);
    badge.x = 14;
    badge.y = 0;
    container.addChild(badge);

    x += 40;
  }

  const makeBig = (text, color = white) => new PIXI.Text({
    text,
    style: new PIXI.TextStyle({
      fontFamily,
      fontSize: 44,
      fontWeight: '700',
      fill: color,
      letterSpacing: -1,
    }),
  });

  const makeSubscript = (text, color = white) => new PIXI.Text({
    text,
    style: new PIXI.TextStyle({
      fontFamily,
      fontSize: 14,
      fontWeight: '600',
      fill: color,
    }),
  });

  const hh = makeBig(parts.hh);
  hh.anchor.set(0, 0.5);
  hh.x = x;
  hh.y = 0;
  container.addChild(hh);
  x += hh.width + 1;

  const hLbl = makeSubscript('H');
  hLbl.anchor.set(0, 0);
  hLbl.x = x;
  hLbl.y = 2;
  container.addChild(hLbl);
  x += hLbl.width + 4;

  const mm = makeBig(parts.mm);
  mm.anchor.set(0, 0.5);
  mm.x = x;
  mm.y = 0;
  container.addChild(mm);
  x += mm.width + 1;

  const mLbl = makeSubscript('M');
  mLbl.anchor.set(0, 0);
  mLbl.x = x;
  mLbl.y = 2;
  container.addChild(mLbl);
  x += mLbl.width + 4;

  const ss = makeBig(parts.ss, orange);
  ss.anchor.set(0, 0.5);
  ss.x = x;
  ss.y = 0;
  container.addChild(ss);
  x += ss.width + 1;

  const sLbl = makeSubscript('S', orange);
  sLbl.anchor.set(0, 0);
  sLbl.x = x;
  sLbl.y = 2;
  container.addChild(sLbl);
}

// ── Main component ───────────────────────────────────────────────────────────

export default function Timeline({
  startTs,
  endTs,
  gaps = [],
  events = [],
  densityData = null,
  activeLabels = null,
  cursorTs,
  resolvedSlots = [],
  slotDefs = [],
  onSeek,
  onStepSlots,
  onPreviewRequest = null,
  timeFormat = '12h',
  paddingLeft = 10,
  paddingRight = 8,
}) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const appRef = useRef(null);
  const appReadyRef = useRef(false);
  const layersRef = useRef({});
  const texRef = useRef({});

  const isDragging = useRef(false);
  const touchStartRef = useRef(null);
  const scrollVelocityRef = useRef(0);
  const scrollRafRef = useRef(null);
  const touchPannedRef = useRef(false);
  const animRef = useRef(null);

  const [dims, setDims] = useState({ w: 420, h: 700 });

  const range = endTs - startTs;
  const secondsPerPixel = useMemo(() => (dims.h > 0 ? range / dims.h : 1), [range, dims.h]);
  const tsToY = useCallback(ts => (endTs - ts) / secondsPerPixel, [endTs, secondsPerPixel]);
  const yToTs = useCallback(
    y => clampTs(endTs - y * secondsPerPixel, startTs, endTs),
    [startTs, endTs, secondsPerPixel]
  );

  const fontFamily = 'IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace';

  // Reticle bar — the rtcl-bar SVG already has triangular endpoints built in,
  // so we just stretch it from the midpoint to the right edge. No dots needed.
  function buildReticle(container, w, reticleY) {
    container.removeChildren();
    const tex = texRef.current;

    const barStart = Math.round(w * 0.48);
    const barEnd = w;
    const barW = barEnd - barStart;
    const barH = 16;

    if (tex.rtclBar) {
      const bar = makeSprite(tex.rtclBar, {
        w: barW,
        h: barH,
        ax: 0,
        ay: 0.5,
        tint: RETICLE_COLOR,
      });
      bar.x = barStart;
      bar.y = reticleY;
      container.addChild(bar);
    } else {
      // Fallback: simple line with triangle endpoints
      const g = new PIXI.Graphics();
      g.moveTo(barStart, reticleY).lineTo(barEnd, reticleY)
        .stroke({ color: RETICLE_COLOR, alpha: 0.9, width: 3 });
      // Left triangle
      g.poly([barStart, reticleY, barStart + 8, reticleY - 6, barStart + 8, reticleY + 6])
        .fill({ color: RETICLE_COLOR });
      // Right triangle
      g.poly([barEnd, reticleY, barEnd - 8, reticleY - 6, barEnd - 8, reticleY + 6])
        .fill({ color: RETICLE_COLOR });
      container.addChild(g);
    }
  }

  // Hints on BOTH left and right edges
  function buildScrollHints(container, w, h) {
    container.removeChildren();
    const tex = texRef.current;
    if (!tex.arrow) return;

    const edgeInset = 18;
    const arrowGap = ARROW_W * 0.6;

    // Helper: place a pair of arrows + label at a given edge X
    function placeHintColumn(centerX, label, isTop) {
      for (const xOff of [-arrowGap, arrowGap]) {
        const s = makeSprite(tex.arrow, {
          w: ARROW_W,
          h: ARROW_H,
          ax: 0.5,
          ay: isTop ? 1 : 0,
          tint: 0x808080,
          alpha: 0.55,
        });
        if (isTop) s.scale.y = -1;
        s.x = centerX + xOff;
        s.y = isTop ? 42 : h - 42;
        container.addChild(s);
      }

      const txt = new PIXI.Text({
        text: label,
        style: new PIXI.TextStyle({
          fontFamily: 'IBM Plex Mono, monospace',
          fontSize: 10,
          fill: '#808080',
        }),
      });
      txt.anchor.set(0.5, 0.5);
      txt.rotation = -Math.PI / 2;
      txt.x = centerX;
      txt.y = isTop ? 14 : h - 14;
      container.addChild(txt);
    }

    // PAST hints — top, on both left and right edges
    placeHintColumn(edgeInset, 'PAST', true);
    placeHintColumn(w - edgeInset, 'PAST', true);

    // NOW hints — bottom, on both left and right edges
    placeHintColumn(edgeInset, 'NOW', false);
    placeHintColumn(w - edgeInset, 'NOW', false);
  }

  const drawAllRef = useRef(null);

  // Build a lookup map from slotIndex → resolved slot data
  const resolvedMap = useMemo(() => {
    const m = new Map();
    for (const s of resolvedSlots) m.set(s.slotIndex, s);
    return m;
  }, [resolvedSlots]);

  const drawAll = useCallback(() => {
    if (!appReadyRef.current) return;

    const { bg, wheelC, hintC, reticleC } = layersRef.current;
    const { w, h } = dims;
    const reticleY = h * RETICLE_FRACTION;

    // Plain flat background
    bg.clear();
    bg.rect(0, 0, w, h).fill({ color: 0x1a1d24 });

    wheelC.removeChildren();

    const SLOT_COUNT = slotDefs.length || 60;
    const angleStep = (Math.PI * 2) / SLOT_COUNT;

    // Find which slot the cursor is in (slot times are in ms, cursorTs is in sec)
    let centerSlotIdx = 0;
    for (let i = 0; i < slotDefs.length; i++) {
      const s = slotDefs[i];
      if (cursorTs >= s.tSlotStart / 1000 && cursorTs < s.tSlotEnd / 1000) {
        centerSlotIdx = i;
        break;
      }
    }

    // Snap: the center angle is exactly at the center slot index (no fractional)
    const centerAngle = centerSlotIdx * angleStep;

    // Dynamic display radius — proportional to canvas height so ~15 rows are visible
    const displayRadius = Math.round(h * 0.50);

    // Row pitch = actual pixel distance between adjacent slot dividers
    const rowPitch = Math.round(Math.sin(angleStep) * displayRadius);

    // Slot time interval — if < 60s, show seconds in labels
    const tDivSec = slotDefs.length >= 2
      ? (slotDefs[1].tSlotStart - slotDefs[0].tSlotStart) / 1000
      : 60;
    const showSeconds = tDivSec < 60;

    // Icon zone — right portion of canvas
    const iconZoneLeft = Math.round(w * 0.58);
    const iconZoneRight = w - paddingRight;
    const iconZoneMid = (iconZoneLeft + iconZoneRight) / 2;

    for (let i = 0; i < SLOT_COUNT; i++) {
      const slotDef = slotDefs[i];
      if (!slotDef) continue;

      const resolved = resolvedMap.get(i);
      const slotAngle = i * angleStep;
      const angle = shortestAngleDiff(slotAngle, centerAngle);

      const y = Math.sin(angle) * displayRadius;
      const z = Math.cos(angle);
      const front = Math.max(0, z);
      const shaped = Math.pow(front, WHEEL.depthPower);
      const alphaShape = Math.pow(front, WHEEL.depthPower * 1.5);

      // Skip rows that are behind the wheel
      if (z <= WHEEL.visibleBackCutoff) continue;

      const isCenter = i === centerSlotIdx;

      // Center row gets extra height so its big readout doesn't cover adjacent rows
      const centerHeight = Math.max(rowPitch * 2.5, 70);
      const centerExtra = centerHeight - rowPitch;

      const row = createWheelRow(fontFamily);

      // Position: center slot's bottom edge aligns with reticle
      if (isCenter) {
        row.y = reticleY - centerHeight;
      } else if (i > centerSlotIdx) {
        // Below center: normal position (y is positive, pushes down from reticle)
        row.y = reticleY + y - rowPitch;
      } else {
        // Above center: shift up by centerExtra so they don't overlap the taller center
        row.y = reticleY + y - rowPitch - centerExtra;
      }
      row.visible = true;

      const rowAlpha = WHEEL.minAlpha + alphaShape * (WHEEL.maxAlpha - WHEEL.minAlpha);
      row.alpha = rowAlpha;

      const scale = WHEEL.minScale + shaped * (WHEEL.maxScale - WHEEL.minScale);
      const yScale = scale * (0.65 + 0.35 * front);
      const sideOffset = (1 - front) * WHEEL.sideParallax;
      const textOffset = -Math.sin(angle) * WHEEL.textParallax;

      // Divider line — bottom edge of each row
      const thisRowHeight = isCenter ? centerHeight : rowPitch;
      row.divider.clear();
      const divAlpha = WHEEL.dividerMinAlpha + shaped * WHEEL.dividerFrontAlpha;
      row.divider.moveTo(0, thisRowHeight).lineTo(w, thisRowHeight).stroke({
        color: isCenter ? 0xffffff : 0x3a3f4a,
        alpha: isCenter ? 0.9 : divAlpha,
        width: isCenter ? 2 : 1,
      });

      // Time label from slot center
      const slotCenterSec = slotDef.tSlotCenter / 1000;

      row.simpleText.visible = !isCenter;
      row.centerReadout.visible = isCenter;

      if (!isCenter) {
        if (showSeconds) {
          const d = new Date(slotCenterSec * 1000);
          let hh = d.getHours();
          const mm = String(d.getMinutes()).padStart(2, '0');
          const ss = String(d.getSeconds()).padStart(2, '0');
          if (timeFormat === '12h') { hh = hh % 12 || 12; }
          row.simpleText.text = `${String(hh).padStart(2, '0')}:${mm}:${ss}`;
        } else {
          row.simpleText.text = formatHHMM(slotCenterSec, timeFormat);
        }
        row.simpleText.x = w * 0.25 + textOffset;
        row.simpleText.y = rowPitch / 2;
        row.simpleText.scale.set(scale, yScale);
        const colorBlend = Math.pow(shaped, 0.5);
        const dimR = 0x40, dimG = 0x44, dimB = 0x4c;
        const brightR = 0xa7, brightG = 0xaf, brightB = 0xbc;
        const r = Math.round(dimR + (brightR - dimR) * colorBlend);
        const g = Math.round(dimG + (brightG - dimG) * colorBlend);
        const b = Math.round(dimB + (brightB - dimB) * colorBlend);
        row.simpleText.style.fill = (r << 16) | (g << 8) | b;
        row.simpleText.style.fontWeight = '500';
      } else {
        const parts = formatParts(cursorTs, timeFormat);
        buildCenterReadout(row.centerReadout, parts, fontFamily);
        row.centerReadout.x = 8;
        row.centerReadout.y = centerHeight / 2;
      }

      // Detection icons — driven by resolved slot data, using Lucide textures
      row.leftIconSlot.removeChildren();
      row.rightIconSlot.removeChildren();

      if (resolved && resolved.resolvedStrategy === 'B' && resolved.label) {
        const label = resolved.label;
        const lucideName = LABEL_TO_LUCIDE[label] ?? 'user';
        const col = EVENT_COLORS[label] ?? EVENT_COLORS.default;
        const tint = isCenter ? RETICLE_COLOR : col;
        const iconY = isCenter ? centerHeight / 2 : rowPitch / 2;

        // Target icon size scales with wheel depth
        const baseSize = 18;
        const iconSize = Math.max(6, baseSize * scale);

        const lucideTex = texRef.current?.lucide?.[lucideName];
        if (lucideTex) {
          const sprite = new PIXI.Sprite(lucideTex);
          sprite.anchor.set(0.5, 0.5);
          sprite.width = iconSize;
          sprite.height = iconSize;
          sprite.tint = tint;
          sprite.x = iconZoneMid - 10;
          sprite.y = iconY;
          row.leftIconSlot.addChild(sprite);
        }

        // Confidence dot next to the icon
        const dotR = Math.max(2, 4 * scale);
        const dot = new PIXI.Graphics();
        dot.circle(0, 0, dotR).fill({ color: tint });
        dot.x = iconZoneMid + 10;
        dot.y = iconY;
        row.rightIconSlot.addChild(dot);
      }

      wheelC.addChild(row);
    }

    buildScrollHints(hintC, w, h);
    buildReticle(reticleC, w, reticleY);

    appRef.current?.render();
  }, [
    dims,
    startTs,
    endTs,
    events,
    cursorTs,
    range,
    timeFormat,
    paddingLeft,
    paddingRight,
    slotDefs,
    resolvedMap,
  ]);

  // Keep drawAllRef in sync so the init effect can call it without a dep cycle
  useEffect(() => { drawAllRef.current = drawAll; }, [drawAll]);

  // Init PixiJS app — only re-runs on canvas size change, NOT on drawAll identity
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let dead = false;

    (async () => {
      const app = await createApp(canvas, dims.w, dims.h);
      if (dead) {
        app.destroy();
        return;
      }

      appRef.current = app;

      try {
        const tex = {};
        // Load reticle/hint assets
        tex.rtclBar = await PIXI.Assets.load(ASSET_PATHS.rtclBar);
        tex.rtclDot = await PIXI.Assets.load(ASSET_PATHS.rtclDot);
        tex.arrow = await PIXI.Assets.load(ASSET_PATHS.arrow);

        // Load Lucide icons as PIXI textures
        tex.lucide = {};
        for (const name of LUCIDE_ICONS_TO_LOAD) {
          try {
            const svgUrl = new URL(
              `../../node_modules/lucide-static/icons/${name}.svg`,
              import.meta.url,
            ).href;
            tex.lucide[name] = await PIXI.Assets.load(svgUrl);
          } catch {
            console.warn(`[Timeline] Failed to load lucide icon: ${name}`);
          }
        }

        texRef.current = tex;
      } catch (e) {
        console.warn('[Timeline] Asset load failed:', e.message);
      }

      const bg = new PIXI.Graphics();
      const wheelC = new PIXI.Container();
      const hintC = new PIXI.Container();
      const reticleC = new PIXI.Container();

      app.stage.addChild(bg, wheelC, hintC, reticleC);
      layersRef.current = { bg, wheelC, hintC, reticleC };

      appReadyRef.current = true;
      if (!dead) drawAllRef.current?.();
    })();

    return () => {
      dead = true;
      appReadyRef.current = false;
      appRef.current?.destroy(false);
      appRef.current = null;
    };
  }, [dims.w, dims.h]); // eslint-disable-line react-hooks/exhaustive-deps

  // Redraw when drawAll changes (cursor, zoom, data, etc.)
  useEffect(() => {
    if (!appReadyRef.current) return;
    drawAll();
  }, [drawAll]);

  // Resize renderer when canvas dimensions change
  useEffect(() => {
    if (!appReadyRef.current) return;
    appRef.current?.renderer.resize(dims.w, dims.h);
    drawAllRef.current?.();
  }, [dims.w, dims.h]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(entries => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        setDims({ w: Math.max(width, 1), h: Math.max(height, 1) });
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => () => {
    if (animRef.current?.rafId) cancelAnimationFrame(animRef.current.rafId);
  }, []);

  // ── Slot-step scroll handling ──────────────────────────────────────────────
  // Mouse wheel and touch gestures advance by whole slots, no velocity/momentum.

  // Accumulate scroll delta to trigger slot steps at a threshold
  const scrollAccumRef = useRef(0);
  const SCROLL_THRESHOLD = 40; // pixels of scroll delta to trigger one slot step

  const handleWheel = useCallback((e) => {
    if (!onStepSlots) return;
    e.preventDefault();

    scrollAccumRef.current += e.deltaY;

    // Each threshold crossing = one slot step
    while (Math.abs(scrollAccumRef.current) >= SCROLL_THRESHOLD) {
      const dir = scrollAccumRef.current > 0 ? -1 : 1; // scroll down = toward PAST (earlier), up = toward NOW
      onStepSlots(dir);
      scrollAccumRef.current -= Math.sign(scrollAccumRef.current) * SCROLL_THRESHOLD;
    }
  }, [onStepSlots]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.addEventListener('wheel', handleWheel, { passive: false });
    return () => c.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // Click on canvas → snap to nearest slot at that Y position
  const handleClick = useCallback((e) => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return;
    const ts = yToTs(e.clientY - r.top);
    if (ts != null) onSeek?.(ts);
  }, [yToTs, onSeek]);

  // Touch: track drag distance, step by slots
  const touchAccumRef = useRef(0);
  const TOUCH_THRESHOLD = 30;

  const handleTouchStart = useCallback((e) => {
    e.preventDefault();
    touchPannedRef.current = false;
    touchAccumRef.current = 0;
    touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, []);

  const handleTouchMove = useCallback((e) => {
    e.preventDefault();
    if (!onStepSlots) return;
    const t = e.touches[0];
    const dy = t.clientY - (touchStartRef.current?.y ?? t.clientY);

    touchAccumRef.current += dy;
    touchStartRef.current = { x: t.clientX, y: t.clientY };

    while (Math.abs(touchAccumRef.current) >= TOUCH_THRESHOLD) {
      const dir = touchAccumRef.current > 0 ? -1 : 1;
      onStepSlots(dir);
      touchAccumRef.current -= Math.sign(touchAccumRef.current) * TOUCH_THRESHOLD;
      touchPannedRef.current = true;
    }
  }, [onStepSlots]);

  const handleTouchEnd = useCallback((e) => {
    e.preventDefault();
    if (!touchPannedRef.current) {
      // Tap (no pan) → seek to tapped position
      const t = e.changedTouches[0];
      const r = canvasRef.current?.getBoundingClientRect();
      if (r) {
        const ts = yToTs(t.clientY - r.top);
        if (ts != null) onSeek?.(ts);
      }
    }
  }, [yToTs, onSeek]);

  return (
    <div className="timeline-wrapper">
      <div className="timeline-canvas-container" ref={containerRef}>
        <canvas
          ref={canvasRef}
          className="timeline-canvas"
          onClick={handleClick}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        />
      </div>
    </div>
  );
}
