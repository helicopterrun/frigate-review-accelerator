/**
 * AdminPanel — Operational controls and live log viewer.
 *
 * Rendered as a full-height side drawer from the right, opened by the
 * hamburger button in the app header. Accepts open/onClose props.
 *
 * v3 additions:
 *   - Drawer layout replaces fixed bottom-right overlay
 *   - Reindex tab with live progress bar (discovered + batch events)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchPreviewProgress } from '../utils/api.js';
import { formatDateTime } from '../utils/time.js';

const API = '/api/admin';
const MAX_LOG_LINES = 500;
const HEALTH_POLL_MS = 2000;

function colorizeLine(line) {
  if (/ERROR|ImportError|Traceback|Exception/.test(line)) return '#ff6b6b';
  if (/WARNING/.test(line)) return '#ffd93d';
  if (/Recency pass|Indexed.*new|worker started/.test(line)) return '#6bcb77';
  if (/On-demand/.test(line)) return '#4ecdc4';
  if (/Background pass/.test(line)) return '#c77dff';
  if (/GET|POST|PUT|DELETE/.test(line)) return '#555';
  return '#ccc';
}

// ── StatusCard ────────────────────────────────────────────────────────────────
function StatusCard({ status }) {
  if (!status) return <div style={s.statusPlaceholder}>Loading status…</div>;

  const rows = [
    { label: 'Last index',      value: status.worker?.last_index,      color: '#6bcb77' },
    { label: 'Last recency',    value: status.worker?.last_recency,    color: '#6bcb77' },
    { label: 'Last on-demand',  value: status.worker?.last_on_demand,  color: '#4ecdc4' },
    { label: 'Last background', value: status.worker?.last_background, color: '#c77dff' },
  ];

  return (
    <div style={s.statusGrid}>
      {rows.map(({ label, value, color }) => (
        <div key={label} style={s.statusRow}>
          <span style={s.statusLabel}>{label}</span>
          <span style={{ ...s.statusValue, color: value ? color : '#444' }}>
            {value ? value.replace(/^\S+ \S+ \S+ — /, '') : 'none yet'}
          </span>
        </div>
      ))}
      {status.recent_errors?.length > 0 && (
        <div style={s.errorBlock}>
          <span style={{ color: '#ff6b6b', fontSize: 11, fontWeight: 600 }}>Recent errors:</span>
          {status.recent_errors.map((e, i) => (
            <div key={i} style={{ color: '#ff6b6b', fontSize: 11, marginTop: 2 }}>
              {e.replace(/^\S+ \S+ \S+ — /, '')}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── ProgressTab ───────────────────────────────────────────────────────────────
function ProgressTab() {
  const [progress, setProgress] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const data = await fetchPreviewProgress();
        setProgress(data);
      } catch { /* ignore */ }
      finally { setLoading(false); }
    }
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  if (loading) return <div style={s.statusPlaceholder}>Loading…</div>;
  if (!progress?.length) return <div style={s.statusPlaceholder}>No camera data yet.</div>;

  return (
    <div style={{ padding: 12, overflowY: 'auto', maxHeight: 320 }}>
      {progress.map((cam) => {
        const pct = cam.pct_recent_complete;
        const totalPending = cam.pending_recent + cam.pending_historical;
        return (
          <div key={cam.camera} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span style={{ color: '#aaa', fontSize: 12, fontFamily: 'monospace' }}>
                {cam.camera}
              </span>
              <span style={{ color: '#666', fontSize: 11 }}>
                {cam.total_segments.toLocaleString()} segs · {totalPending.toLocaleString()} pending
              </span>
            </div>
            <div style={s.progressTrack}>
              <div
                style={{
                  ...s.progressBar,
                  width: `${pct}%`,
                  background: pct >= 100 ? '#4CAF50' : pct > 50 ? '#2196F3' : '#FF9800',
                }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
              <span style={{ color: '#555', fontSize: 10 }}>
                {pct.toFixed(0)}% recent complete
              </span>
              {cam.pending_recent > 0 && (
                <span style={{ color: '#FF9800', fontSize: 10 }}>
                  {cam.pending_recent.toLocaleString()} recent pending
                </span>
              )}
              {cam.pending_historical > 0 && (
                <span style={{ color: '#555', fontSize: 10 }}>
                  {cam.pending_historical.toLocaleString()} historical pending
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── ReindexTab ────────────────────────────────────────────────────────────────
const REINDEX_PRESETS = [
  { label: 'Last 1h',  hours: 1,    description: 'Quick fix — finds segments from the last hour' },
  { label: 'Today',    hours: null,  description: 'From midnight UTC today' },
  { label: 'Last 24h', hours: 24,   description: 'Yesterday + today' },
  { label: 'Last 72h', hours: 72,   description: 'Recommended starting point' },
  { label: '7 days',   hours: 168,  description: 'Full week — slower' },
  { label: '30 days',  hours: 720,  description: 'Full month — slow, run once' },
];

function ReindexTab() {
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState([]);
  const [customHours, setCustomHours] = useState('');
  const [reindexProgress, setReindexProgress] = useState(null);
  // null | { done: number, total: number, pct: number }
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  async function runReindex(hours) {
    if (running) return;
    setRunning(true);
    setLines([`▶ Reindexing last ${hours}h…`]);
    setReindexProgress(null);

    try {
      const res = await fetch(`${API}/reindex?since_hours=${hours}`, { method: 'POST' });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const eventMatch = frame.match(/^event: (\w+)/m);
          const dataMatch = frame.match(/^data: (.+)/m);
          if (!eventMatch || !dataMatch) continue;

          const event = eventMatch[1];
          const data = dataMatch[1];

          if (event === 'line') {
            setLines(prev => [...prev, data]);
          } else if (event === 'discovered') {
            try {
              const p = JSON.parse(data);
              if (p.total > 0) {
                setReindexProgress({ done: 0, total: p.total, pct: 0 });
              }
            } catch {}
          } else if (event === 'progress') {
            try {
              const p = JSON.parse(data);
              setReindexProgress({ done: p.done, total: p.total, pct: p.pct });
            } catch {}
          } else if (event === 'done') {
            setReindexProgress(prev => prev ? { ...prev, pct: 100, done: prev.total } : null);
            try {
              const parsed = JSON.parse(data);
              setLines(prev => [
                ...prev,
                `✓ Complete: ${parsed.total} new segments across ${parsed.cameras} cameras`,
              ]);
            } catch {
              setLines(prev => [...prev, '✓ Complete']);
            }
            setRunning(false);
          } else if (event === 'error') {
            try {
              const parsed = JSON.parse(data);
              setLines(prev => [...prev, `✗ Error: ${parsed.msg}`]);
            } catch {
              setLines(prev => [...prev, `✗ Error: ${data}`]);
            }
            setRunning(false);
          }
        }
      }
    } catch (err) {
      setLines(prev => [...prev, `✗ Fetch error: ${err.message}`]);
      setRunning(false);
    }
  }

  function getTodayHours() {
    const now = Date.now() / 1000;
    const midnight = Math.floor(now / 86400) * 86400;
    return Math.ceil((now - midnight) / 3600) + 1;
  }

  return (
    <div style={{ padding: 12 }}>
      <div style={{
        fontSize: 11, color: '#666', marginBottom: 12, lineHeight: 1.6,
        borderLeft: '2px solid #2a2d37', paddingLeft: 8,
      }}>
        Targeted reindex scans recording directories within a time window,
        bypassing the incremental scanner. Use this when the timeline shows
        gaps despite recordings existing in Frigate.
      </div>

      {/* Progress bar — visible after discovery */}
      {reindexProgress && (
        <div style={{ marginBottom: 12 }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            marginBottom: 4, fontSize: 10, fontFamily: 'monospace', color: '#666',
          }}>
            <span>
              {reindexProgress.done.toLocaleString()} / {reindexProgress.total.toLocaleString()} segments
            </span>
            <span>{reindexProgress.pct}%</span>
          </div>
          <div style={{
            height: 6, background: '#1a1d27', borderRadius: 3,
            overflow: 'hidden', border: '1px solid #2a2d37',
          }}>
            <div style={{
              height: '100%',
              width: `${reindexProgress.pct}%`,
              background: reindexProgress.pct === 100 ? '#4CAF50' : '#4ecdc4',
              borderRadius: 3,
              transition: 'width 0.3s ease',
            }} />
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 12 }}>
        {REINDEX_PRESETS.map(({ label, hours, description }) => {
          const resolvedHours = hours ?? getTodayHours();
          return (
            <button
              key={label}
              onClick={() => runReindex(resolvedHours)}
              disabled={running}
              style={{
                background: '#13161f',
                border: '1px solid #2a2d37',
                borderRadius: 4,
                padding: '8px 10px',
                cursor: running ? 'not-allowed' : 'pointer',
                opacity: running ? 0.5 : 1,
                textAlign: 'left',
              }}
            >
              <div style={{ color: '#4ecdc4', fontSize: 12, fontFamily: 'monospace', fontWeight: 600, marginBottom: 2 }}>
                {label}
              </div>
              <div style={{ color: '#555', fontSize: 10 }}>
                {description}
              </div>
            </button>
          );
        })}
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
        padding: '8px 10px', background: '#13161f',
        border: '1px solid #2a2d37', borderRadius: 4,
      }}>
        <span style={{ color: '#666', fontSize: 11, flexShrink: 0 }}>Custom:</span>
        <input
          type="number"
          min="1"
          max="8760"
          value={customHours}
          onChange={e => setCustomHours(e.target.value)}
          placeholder="hours"
          style={{
            flex: 1, background: '#0a0c12', border: '1px solid #333',
            borderRadius: 3, color: '#aaa', fontSize: 11,
            padding: '3px 6px', fontFamily: 'monospace',
          }}
        />
        <span style={{ color: '#555', fontSize: 11, flexShrink: 0 }}>hours</span>
        <button
          onClick={() => { const h = parseFloat(customHours); if (!isNaN(h) && h > 0) runReindex(h); }}
          disabled={running || !customHours || isNaN(parseFloat(customHours))}
          style={{
            background: '#1a1d27', border: '1px solid #333', borderRadius: 3,
            color: '#aaa', padding: '3px 10px', cursor: 'pointer',
            fontSize: 11, fontFamily: 'monospace', flexShrink: 0,
          }}
        >
          Go
        </button>
      </div>

      {lines.length > 0 && (
        <div style={{
          background: '#0a0c12', border: '1px solid #1e2130', borderRadius: 4,
          padding: '8px 10px', fontSize: 11, fontFamily: 'monospace',
          maxHeight: 200, overflowY: 'auto',
        }}>
          {lines.map((line, i) => (
            <div key={i} style={{
              color: line.startsWith('✓') ? '#6bcb77'
                   : line.startsWith('✗') ? '#ff6b6b'
                   : line.startsWith('▶') ? '#4ecdc4'
                   : line.startsWith('  ') ? '#888'
                   : '#ccc',
              lineHeight: 1.6,
            }}>
              {line}
            </div>
          ))}
          {running && <div style={{ color: '#666', marginTop: 4 }}>Running…</div>}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}

// ── LogPane ───────────────────────────────────────────────────────────────────
function LogPane({ lines, isLive, filter, onFilterChange }) {
  const bottomRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lines, autoScroll]);

  return (
    <div style={s.logWrapper}>
      <div style={s.logToolbar}>
        <div style={s.filterButtons}>
          {['all', 'previews', 'errors'].map((f) => (
            <button
              key={f}
              onClick={() => onFilterChange(f)}
              style={{
                ...s.filterBtn,
                background: filter === f ? '#2a3a5c' : 'transparent',
                color: filter === f ? '#4ecdc4' : '#666',
              }}
            >
              {f}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isLive && (
            <span style={s.liveBadge}>
              <span style={s.liveDot} />
              LIVE
            </span>
          )}
          <label style={s.autoScrollLabel}>
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              style={{ marginRight: 4 }}
            />
            auto-scroll
          </label>
          <span style={{ color: '#444', fontSize: 11 }}>{lines.length} lines</span>
        </div>
      </div>
      <div style={s.logOutput}>
        {lines.length === 0 ? (
          <span style={{ color: '#444', fontSize: 12 }}>No log output yet…</span>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              style={{ color: colorizeLine(line), lineHeight: '1.5', whiteSpace: 'pre-wrap' }}
            >
              {line}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ── DebugTab (DEV only) ───────────────────────────────────────────────────────
// TODO: test debug tab hidden in production (import.meta.env.DEV=false)
// TODO: test forceShowScrubOverlay bypasses autoplayActive condition
function DebugTab({
  debugOverrides,
  setDebugOverrides,
  debugState,
  onDebugTriggerAutoplay,
  onDebugPromotePreload,
  onDebugClearPlayback,
}) {
  const [queueStats, setQueueStats] = useState(null);
  const [, setTick] = useState(0); // 500ms refresh for readouts

  // Track when autoplayActive first became true — used for the stalled-video warning.
  const autoplayActiveSinceRef = useRef(null);
  useEffect(() => {
    if (debugState?.autoplayActive && autoplayActiveSinceRef.current == null) {
      autoplayActiveSinceRef.current = Date.now();
    } else if (!debugState?.autoplayActive) {
      autoplayActiveSinceRef.current = null;
    }
  }, [debugState?.autoplayActive]);

  useEffect(() => {
    async function fetchStats() {
      try {
        const res = await fetch('/api/debug/stats');
        if (res.ok) setQueueStats(await res.json());
      } catch { /* endpoint may not exist yet — ignore */ }
    }
    fetchStats();
    const id = setInterval(fetchStats, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 500);
    return () => clearInterval(id);
  }, []);

  // ── Helper renderers ────────────────────────────────────────────────────────

  function boolBadge(val) {
    if (val == null) return <span style={{ color: '#555' }}>—</span>;
    return (
      <span style={{
        background: val ? 'rgba(107,203,119,0.2)' : 'rgba(255,107,107,0.2)',
        color: val ? '#6bcb77' : '#ff6b6b',
        padding: '1px 6px', borderRadius: 8, fontSize: 10, fontFamily: 'monospace',
      }}>
        {val ? 'true' : 'false'}
      </span>
    );
  }

  function hint(text, color = '#555') {
    return <span style={{ color, fontSize: 10, marginTop: 2, lineHeight: 1.4 }}>{text}</span>;
  }

  function warn(text) {
    return <span style={{ color: '#ffd93d', fontSize: 10, marginTop: 3, lineHeight: 1.4 }}>⚠ {text}</span>;
  }

  // ── Derived display values ──────────────────────────────────────────────────

  const st = debugState ?? {};
  const pt = st.playbackTarget;
  const pret = st.preloadTarget;
  const scrubShort = st.scrubPreviewUrl ? st.scrubPreviewUrl.slice(-60) : null;
  const dispShort = st.displayedPreviewUrl ? st.displayedPreviewUrl.slice(-60) : null;

  // Autoplay state text — derived from boolean since autoplayState string isn't
  // separately plumbed through debugState. "approaching event" is indistinguishable
  // from "advancing" at this level; both show as "advancing".
  const autoplayStateText = st.autoplayActive ? 'advancing' : 'idle';

  // Stalled-video warning: autoplay active but video not playing for >2s.
  const autoplayStalled =
    st.autoplayActive &&
    !st.isPlaying &&
    autoplayActiveSinceRef.current != null &&
    Date.now() - autoplayActiveSinceRef.current > 2000;

  // RAF guard divergence.
  const rafDiverged = st.isPlaying !== st.videoPlayingRef;

  // Preview status color and notes.
  const previewStatus = st.scrubPreviewStatus;
  const previewStatusColor =
    previewStatus === 200 ? '#6bcb77' :
    previewStatus === 404 ? '#ff6b6b' :
    previewStatus === 'pending' ? '#ffd93d' : '#555';
  const previewStatusText =
    previewStatus === 200 ? '200 OK' :
    previewStatus === 404 ? '404' :
    previewStatus === 'pending' ? 'pending…' : '—';

  // Queue stats display.
  const queueDepth = queueStats?.scheduler_queue_depth ?? null;
  const genRate = queueStats?.generation_rate_fps ?? null;
  const queueDepthColor =
    queueDepth == null ? '#555' :
    queueDepth === 0 ? '#6bcb77' :
    queueDepth > 1000 ? '#ff6b6b' : '#ffd93d';
  const queueDepthText =
    queueDepth == null ? 'polling…' :
    queueDepth === 0 ? '0 — all caught up ✓' :
    queueDepth > 1000
      ? `${queueDepth.toLocaleString()} — large backlog`
      : `${queueDepth.toLocaleString()} previews generating`;

  // ── Sub-components ──────────────────────────────────────────────────────────

  function OverrideCheckbox({ id, label, description }) {
    return (
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={debugOverrides?.[id] ?? false}
            onChange={e => setDebugOverrides(prev => ({ ...prev, [id]: e.target.checked }))}
            style={{ accentColor: '#4ecdc4', marginTop: 1, flexShrink: 0 }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ color: '#ccc', fontSize: 11 }}>{label}</span>
            <span style={{ color: '#555', fontSize: 10, lineHeight: 1.5 }}>{description}</span>
          </div>
        </label>
      </div>
    );
  }

  function ReadoutRow({ label, children }) {
    return (
      <div style={{ ...s.statusRow, flexDirection: 'column', gap: 2 }}>
        <span style={s.statusLabel}>{label}</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {children}
        </div>
      </div>
    );
  }

  function ActionGroup({ purpose, children, color = '#4ecdc4' }) {
    return (
      <div style={{ marginBottom: 12 }}>
        <div style={{ color: '#555', fontSize: 10, marginBottom: 5, lineHeight: 1.5 }}>{purpose}</div>
        {children}
      </div>
    );
  }

  function DebugBtn({ label, onClick, color = '#4ecdc4' }) {
    return (
      <button
        onClick={onClick}
        style={{
          background: 'transparent', border: `1px solid ${color}`,
          color, borderRadius: 4, padding: '4px 12px',
          cursor: 'pointer', fontSize: 11, fontFamily: 'monospace',
        }}
      >{label}</button>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: 12, overflowY: 'auto', flex: 1, fontSize: 11, fontFamily: 'monospace' }}>

      {/* ── Section 1: Layer overrides ── */}
      <div style={sd.section}>
        <div style={sd.sectionTitle}>Layer overrides</div>

        <OverrideCheckbox
          id="forceShowScrubOverlay"
          label="Always show scrub preview"
          description="Use this when the video player looks blank after clicking the timeline. If a preview image appears after enabling this, the overlay is working but being suppressed by the autoplay condition."
        />
        <OverrideCheckbox
          id="forceHideVideo"
          label="Hide video element"
          description="Hides the <video> element without stopping playback. Use this to confirm what's behind the video — if you can see the scrub preview image underneath, the video was covering it."
        />
        <OverrideCheckbox
          id="forceShowPreloadVideo"
          label="Show preload buffer (top-left)"
          description="Makes the hidden preload video element visible in the top-left corner. If it shows moving video, the idle preload is working and buffering ahead correctly."
        />
      </div>

      {/* ── Section 2: Live readouts ── */}
      <div style={sd.section}>
        <div style={sd.sectionTitle}>Live readouts</div>

        <ReadoutRow label="AUTOPLAY STATE">
          <span style={{ color: st.autoplayActive ? '#6bcb77' : '#aaa', fontSize: 11 }}>
            {autoplayStateText}
          </span>
          {hint('idle while scrubbing · advancing after 1.5s')}
        </ReadoutRow>

        <ReadoutRow label="VIDEO PLAYING">
          {boolBadge(st.isPlaying)}
          {hint('true only during active HLS/MP4 playback')}
          {autoplayStalled && warn('autoplay active but video not playing — check for stalled segment')}
        </ReadoutRow>

        <ReadoutRow label="RAF GUARD (videoPlayingRef)">
          <span style={{ color: rafDiverged ? '#ffd93d' : '#aaa', fontSize: 11 }}>
            {st.videoPlayingRef == null ? '—' : String(st.videoPlayingRef)}
          </span>
          {hint('should match VIDEO PLAYING — divergence causes cursor drift')}
          {rafDiverged && warn('diverges from VIDEO PLAYING')}
        </ReadoutRow>

        <ReadoutRow label="CURRENT PREVIEW URL">
          <span style={{ color: '#aaa', wordBreak: 'break-all' }}>{scrubShort ?? 'none'}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ color: '#555', fontSize: 10 }}>HTTP status:</span>
            <span style={{ color: previewStatusColor, fontSize: 11 }}>{previewStatusText}</span>
          </span>
          {previewStatus === 404 && hint('preview not yet generated — will retry after worker processes the on-demand queue', '#ff6b6b')}
          {previewStatus === 200 && st.displayedPreviewUrl !== st.scrubPreviewUrl && hint('new frame loading…')}
        </ReadoutRow>

        <ReadoutRow label="DISPLAYED PREVIEW (last good frame)">
          <span style={{ color: '#aaa', wordBreak: 'break-all' }}>{dispShort ?? 'none'}</span>
          {hint('updates only on successful load — intentional to prevent black flashes')}
        </ReadoutRow>

        <ReadoutRow label="PLAYBACK TARGET">
          {pt ? (
            <>
              <span style={{ color: '#4ecdc4' }}>
                {pt.requested_ts} — {formatDateTime(pt.requested_ts)}
              </span>
              <span style={{ color: '#888', fontSize: 10 }}>
                offset: {pt.offset_sec != null ? `${pt.offset_sec.toFixed(1)}s into segment` : 'unknown'}
              </span>
            </>
          ) : hint('none — player in placeholder state')}
        </ReadoutRow>

        <ReadoutRow label="PRELOAD TARGET">
          {pret ? (
            <>
              <span style={{ color: '#c77dff' }}>
                {pret.requested_ts} — {formatDateTime(pret.requested_ts)}
              </span>
              <span style={{ color: '#ffd93d', fontSize: 10 }}>buffering…</span>
            </>
          ) : hint('none — will fetch at 400ms idle')}
        </ReadoutRow>

        <ReadoutRow label="PRELOAD HLS URL">
          {pret?.hls_url
            ? <span style={{ color: '#6bcb77' }}>ready ✓</span>
            : <span style={{ color: '#555' }}>none</span>}
        </ReadoutRow>

        <ReadoutRow label="PREVIEW QUEUE DEPTH">
          {queueStats == null
            ? <span style={{ color: '#555' }}>polling…</span>
            : <span style={{ color: queueDepthColor }}>{queueDepthText}</span>
          }
          {queueDepth > 1000 && hint('scrub previews may 404 until backlog drains', '#ff6b6b')}
        </ReadoutRow>

        <ReadoutRow label="PREVIEW GENERATION RATE">
          {genRate == null
            ? <span style={{ color: '#555' }}>polling…</span>
            : genRate > 0
              ? <span style={{ color: '#6bcb77' }}>{genRate.toFixed(1)} frames/sec</span>
              : <span style={{ color: queueDepth > 0 ? '#ffd93d' : '#aaa' }}>
                  {genRate.toFixed(1)} frames/sec
                </span>
          }
          {genRate === 0 && queueDepth > 0 && warn('queue not draining')}
        </ReadoutRow>

        {queueStats == null && (
          <div style={{ color: '#444', fontSize: 10, marginTop: 4 }}>/api/debug/stats not available</div>
        )}
      </div>

      {/* ── Section 3: Actions ── */}
      <div style={sd.section}>
        <div style={sd.sectionTitle}>Actions</div>

        <ActionGroup purpose="Skip the 1.5s idle wait and start video immediately">
          <DebugBtn label="Trigger autoplay now" onClick={onDebugTriggerAutoplay} color="#4ecdc4" />
        </ActionGroup>

        <ActionGroup purpose="Promote the buffered preload to the main player — use to test if preload is working without waiting for autoplay">
          <DebugBtn label="Force preload → playback" onClick={onDebugPromotePreload} color="#c77dff" />
        </ActionGroup>

        <ActionGroup purpose="Reset the player to blank state — use to test the placeholder and scrub preview overlay from scratch">
          <DebugBtn label="Clear playback target" onClick={onDebugClearPlayback} color="#ff6b6b" />
        </ActionGroup>

        <ActionGroup purpose="Turn off all layer overrides above">
          <DebugBtn
            label="Reset all overrides"
            onClick={() => setDebugOverrides({ forceShowScrubOverlay: false, forceHideVideo: false, forceShowPreloadVideo: false })}
            color="#ffd93d"
          />
        </ActionGroup>
      </div>
    </div>
  );
}

// DebugTab section styles
const sd = {
  section: {
    marginBottom: 16,
    padding: '10px 12px',
    background: '#13161f',
    border: '1px solid #1e2130',
    borderRadius: 4,
  },
  sectionTitle: {
    color: '#4ecdc4',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: 10,
  },
};

// ── AdminPanel ────────────────────────────────────────────────────────────────
export default function AdminPanel({
  open,
  onClose,
  // DEV-only debug props — never passed in production
  debugOverrides,
  setDebugOverrides,
  debugState,
  onDebugTriggerAutoplay,
  onDebugPromotePreload,
  onDebugClearPlayback,
}) {
  const [tab, setTab] = useState('logs');
  const [status, setStatus] = useState(null);
  const [logLines, setLogLines] = useState([]);
  const [isLive, setIsLive] = useState(false);
  const [filter, setFilter] = useState('all');
  const [running, setRunning] = useState(null);
  const [scriptLines, setScriptLines] = useState([]);
  const [reconnecting, setReconnecting] = useState(false);
  const [pendingRestart, setPendingRestart] = useState(null); // null | { countdown: number }

  const sseRef = useRef(null);
  const healthPollRef = useRef(null);
  const runScriptRef = useRef(null);

  // ── Status polling ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;

    async function fetchStatus() {
      try {
        const res = await fetch(`${API}/status`);
        if (res.ok) setStatus(await res.json());
      } catch { /* ignore */ }
    }

    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, [open]);

  // ── Clear health poll on unmount ────────────────────────────────────────────
  useEffect(() => {
    return () => { if (healthPollRef.current) clearInterval(healthPollRef.current); };
  }, []);

  // ── Log SSE stream ──────────────────────────────────────────────────────────
  const connectLogStream = useCallback(() => {
    if (sseRef.current) sseRef.current.close();
    setLogLines([]);
    setIsLive(false);

    const filterParam = filter === 'previews'
      ? 'Recency pass|On-demand|Background pass|Indexed|worker'
      : filter === 'errors'
      ? 'ERROR|WARNING|ImportError|Traceback'
      : '';

    const url = `${API}/logs/stream?lines=100&filter=${encodeURIComponent(filterParam)}`;
    const sse = new EventSource(url);
    sseRef.current = sse;

    sse.addEventListener('line', (e) => {
      setLogLines((prev) => {
        const next = [...prev, e.data];
        return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
      });
    });

    sse.addEventListener('ready', () => setIsLive(true));
    sse.addEventListener('ping', () => {});
    sse.addEventListener('error', () => {
      setIsLive(false);
      setTimeout(connectLogStream, 3000);
    });
  }, [filter]);

  useEffect(() => {
    if (!open || tab !== 'logs') {
      sseRef.current?.close();
      return;
    }
    connectLogStream();
    return () => sseRef.current?.close();
  }, [open, tab, connectLogStream]);

  // ── Health polling after restart ────────────────────────────────────────────
  const startHealthPoll = useCallback((onBack) => {
    if (healthPollRef.current) clearInterval(healthPollRef.current);
    healthPollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/health');
        if (res.ok) {
          clearInterval(healthPollRef.current);
          healthPollRef.current = null;
          onBack();
        }
      } catch { /* still restarting */ }
    }, HEALTH_POLL_MS);
  }, []);

  // ── Script execution ────────────────────────────────────────────────────────
  const runScript = useCallback((action) => {
    if (running) return;

    setRunning(action);
    setReconnecting(false);
    setScriptLines([`▶ Running ${action}…`]);
    setTab('script');

    const isRestart = action === 'restart';

    // Shared reconnect path — used by stream errors, clean EOF without a
    // done event, and outer fetch rejections (e.g. network down before 200).
    const triggerReconnect = () => {
      setReconnecting(true);
      setScriptLines((prev) => [...prev, 'Server restarting… reconnecting']);
      startHealthPoll(() => {
        setReconnecting(false);
        setRunning(null);
        setScriptLines((prev) => [...prev, '✓ Back online']);
        if (tab === 'logs') connectLogStream();
      });
    };

    fetch(`${API}/${action}`, { method: 'POST' })
      .then(async (res) => {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let gotDoneEvent = false;

        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split('\n\n');
            buffer = frames.pop() ?? '';

            for (const frame of frames) {
              const eventMatch = frame.match(/^event: (\w+)/m);
              const dataMatch  = frame.match(/^data: (.+)/m);
              if (!eventMatch || !dataMatch) continue;

              const event = eventMatch[1];
              const data  = dataMatch[1];

              if (event === 'line') {
                setScriptLines((prev) => [...prev, data]);
              } else if (event === 'done') {
                gotDoneEvent = true;
                let returncode = 0;
                try { returncode = JSON.parse(data).returncode ?? 0; } catch {}
                if ((action === 'update' || action === 'pull') && returncode === 0) {
                  setScriptLines((prev) => [...prev, '✓ Update complete. Restart required to apply changes.']);
                  setRunning(null);
                  setPendingRestart({ countdown: 5 });
                } else {
                  setScriptLines((prev) => [...prev, '✓ Done.']);
                  setRunning(null);
                }
              } else if (event === 'error') {
                try {
                  const parsed = JSON.parse(data);
                  setScriptLines((prev) => [...prev, `✗ Error: ${parsed.msg}`]);
                } catch {
                  setScriptLines((prev) => [...prev, `✗ Error: ${data}`]);
                }
                setRunning(null);
              }
            }
          }
        } catch {
          // reader.read() threw — connection dropped mid-stream.
          if (isRestart) {
            triggerReconnect();
          } else {
            setScriptLines((prev) => [...prev, '✗ Connection lost.']);
            setRunning(null);
          }
          return;
        }

        // Stream ended cleanly (done=true) but no `done` SSE event was received.
        // This happens when uvicorn exits before it can flush the final frame.
        if (isRestart && !gotDoneEvent) {
          triggerReconnect();
        }
      })
      .catch((err) => {
        // fetch() itself rejected — network error before any response bytes.
        if (isRestart) {
          triggerReconnect();
        } else {
          setScriptLines((prev) => [...prev, `✗ Fetch error: ${err.message}`]);
          setRunning(null);
        }
      });
  }, [running, tab, startHealthPoll, connectLogStream]);

  // Keep ref in sync so the countdown effect always calls the latest runScript
  // without needing it as a dependency (which would reset the countdown on each tick).
  runScriptRef.current = runScript;

  // ── Countdown: auto-restart after update/pull succeeds ──────────────────────
  useEffect(() => {
    if (!pendingRestart) return;
    if (!open) { setPendingRestart(null); return; }
    if (pendingRestart.countdown <= 0) {
      setPendingRestart(null);
      runScriptRef.current?.('restart');
      return;
    }
    const id = setTimeout(
      () => setPendingRestart((p) => (p ? { countdown: p.countdown - 1 } : null)),
      1000,
    );
    return () => clearTimeout(id);
  }, [pendingRestart, open]);

  // ── Render ──────────────────────────────────────────────────────────────────
  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.4)',
          zIndex: 999,
        }}
      />
      {/* Drawer */}
      <div style={{
        position: 'fixed',
        top: 0, right: 0,
        width: Math.min(700, window.innerWidth),
        height: '100vh',
        background: '#0d1017',
        border: '1px solid #2a2d37',
        boxShadow: '-8px 0 32px rgba(0,0,0,0.6)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: 'monospace',
        fontSize: 12,
      }}>
        {/* Drawer header */}
        <div style={{
          display: 'flex', alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: '1px solid #2a2d37',
          background: '#13161f',
          flexShrink: 0,
        }}>
          <span style={{ color: '#e0e0e0', fontWeight: 600, fontSize: 14 }}>
            ⚙ Ops Panel
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none',
              color: '#666', fontSize: 20, cursor: 'pointer',
              padding: '0 4px', lineHeight: 1,
            }}
          >✕</button>
        </div>

        {/* Action buttons */}
        <div style={{ ...s.actionRow, padding: '10px 14px', flexShrink: 0 }}>
          {[
            { id: 'restart', label: '↺ Restart backend', color: '#4ecdc4' },
            { id: 'update',  label: '↑ Update deps',     color: '#ffd93d' },
            { id: 'pull',    label: '⬇ Git pull',        color: '#c77dff' },
          ].map(({ id, label, color }) => (
            <button
              key={id}
              onClick={() => runScript(id)}
              disabled={!!running || !!pendingRestart}
              style={{
                ...s.actionBtn,
                borderColor: color,
                color: running === id ? color : '#888',
                opacity: (running && running !== id) || (pendingRestart && id !== 'restart') ? 0.4 : 1,
              }}
            >
              {running === id
                ? reconnecting ? 'Reconnecting…' : `${label}…`
                : label}
            </button>
          ))}
        </div>

        {/* Tab strip */}
        <div style={{ ...s.tabs, borderBottom: '1px solid #2a2d37', flexShrink: 0 }}>
          {[
            'logs', 'status', 'progress', 'reindex', 'script',
            ...(import.meta.env.DEV ? ['debug'] : []),
          ].map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                ...s.tab,
                borderBottom: tab === t ? '2px solid #4ecdc4' : '2px solid transparent',
                color: tab === t ? '#4ecdc4' : t === 'debug' ? '#9966cc' : '#666',
              }}
            >
              {t}
              {t === 'script' && (running || pendingRestart) && <span style={s.runningDot} />}
            </button>
          ))}
        </div>

        {/* Tab content — scrollable */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {tab === 'logs' && (
            <LogPane
              lines={logLines}
              isLive={isLive}
              filter={filter}
              onFilterChange={setFilter}
            />
          )}

          {tab === 'status' && (
            <div style={s.statusPane}>
              <StatusCard status={status} />
            </div>
          )}

          {tab === 'progress' && <ProgressTab />}

          {tab === 'reindex' && <ReindexTab />}

          {tab === 'debug' && import.meta.env.DEV && (
            <DebugTab
              debugOverrides={debugOverrides}
              setDebugOverrides={setDebugOverrides}
              debugState={debugState}
              onDebugTriggerAutoplay={onDebugTriggerAutoplay}
              onDebugPromotePreload={onDebugPromotePreload}
              onDebugClearPlayback={onDebugClearPlayback}
            />
          )}

          {tab === 'script' && (
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
              {pendingRestart && (
                <div style={s.restartBanner}>
                  <span style={{ color: '#ffd93d', fontSize: 12 }}>
                    ⚡ Restart required — auto-restarting in {pendingRestart.countdown}s…
                  </span>
                  <button
                    onClick={() => { setPendingRestart(null); runScriptRef.current?.('restart'); }}
                    style={s.restartNowBtn}
                  >
                    Restart now
                  </button>
                </div>
              )}
              <div style={{ ...s.logOutput, flex: 1 }}>
                {scriptLines.map((line, i) => (
                  <div
                    key={i}
                    style={{
                      color: line.startsWith('✗') ? '#ff6b6b'
                           : line.startsWith('✓') ? '#6bcb77'
                           : line.startsWith('▶') ? '#4ecdc4'
                           : line.includes('reconnect') ? '#ffd93d'
                           : colorizeLine(line),
                      lineHeight: '1.5',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {line}
                  </div>
                ))}
                {reconnecting && (
                  <div style={{ color: '#ffd93d', marginTop: 8 }}>
                    Polling /api/health every 2s…
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = {
  actionRow: { display: 'flex', gap: 8 },
  actionBtn: {
    background: 'transparent',
    border: '1px solid',
    borderRadius: 4,
    padding: '4px 12px',
    cursor: 'pointer',
    fontSize: 11,
    fontFamily: 'monospace',
    transition: 'opacity 0.15s',
  },
  tabs: { display: 'flex', gap: 0, background: '#13161f' },
  tab: {
    background: 'transparent',
    border: 'none',
    padding: '6px 14px',
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: 'monospace',
    position: 'relative',
  },
  logWrapper: { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' },
  logToolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '6px 10px',
    borderBottom: '1px solid #1a1d27',
    background: '#0f1117',
    flexShrink: 0,
  },
  filterButtons: { display: 'flex', gap: 4 },
  filterBtn: {
    border: '1px solid #2a2d37',
    borderRadius: 3,
    padding: '2px 8px',
    cursor: 'pointer',
    fontSize: 11,
    fontFamily: 'monospace',
  },
  liveBadge: { display: 'flex', alignItems: 'center', gap: 4, color: '#6bcb77', fontSize: 10, fontWeight: 700 },
  liveDot: { width: 6, height: 6, borderRadius: '50%', background: '#6bcb77' },
  autoScrollLabel: { color: '#555', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center' },
  logOutput: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 12px',
    background: '#0a0c12',
    fontSize: 11,
    lineHeight: '1.6',
  },
  statusPane: { padding: 14, overflowY: 'auto', flex: 1 },
  statusGrid: { display: 'flex', flexDirection: 'column', gap: 8 },
  statusRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '6px 10px',
    background: '#13161f',
    borderRadius: 4,
    border: '1px solid #1e2130',
  },
  statusLabel: { color: '#555', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' },
  statusValue: { fontSize: 11, wordBreak: 'break-all' },
  errorBlock: { padding: '6px 10px', background: '#1a0d0d', borderRadius: 4, border: '1px solid #3a1515' },
  statusPlaceholder: { color: '#444', fontSize: 12, padding: 12 },
  runningDot: {
    display: 'inline-block',
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#ffd93d',
    marginLeft: 5,
    verticalAlign: 'middle',
  },
  progressTrack: {
    height: 8,
    background: '#1a1d27',
    borderRadius: 4,
    overflow: 'hidden',
    border: '1px solid #2a2d37',
  },
  progressBar: {
    height: '100%',
    borderRadius: 4,
    transition: 'width 0.3s ease',
  },
  restartBanner: {
    background: '#1a1400',
    borderBottom: '1px solid #5a4a00',
    padding: '10px 14px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    flexShrink: 0,
  },
  restartNowBtn: {
    background: '#4ecdc4',
    border: 'none',
    borderRadius: 4,
    color: '#000',
    padding: '4px 12px',
    cursor: 'pointer',
    fontSize: 11,
    fontFamily: 'monospace',
    fontWeight: 700,
    flexShrink: 0,
  },
};
