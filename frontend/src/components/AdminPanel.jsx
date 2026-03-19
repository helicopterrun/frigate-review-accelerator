/**
 * AdminPanel — Operational controls and live log viewer.
 *
 * v2 additions:
 *   - Restart reconnect UX: detects network drop during restart, polls
 *     /api/health until the server is back, then shows "✓ Back online".
 *   - Progress tab: per-camera preview generation progress bars.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchPreviewProgress } from '../utils/api.js';

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
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  async function runReindex(hours) {
    if (running) return;
    setRunning(true);
    setLines([`▶ Reindexing last ${hours}h…`]);

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
          } else if (event === 'done') {
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

// ── AdminPanel ────────────────────────────────────────────────────────────────
export default function AdminPanel() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('logs');
  const [status, setStatus] = useState(null);
  const [logLines, setLogLines] = useState([]);
  const [isLive, setIsLive] = useState(false);
  const [filter, setFilter] = useState('all');
  const [running, setRunning] = useState(null);
  const [scriptLines, setScriptLines] = useState([]);
  const [reconnecting, setReconnecting] = useState(false);

  const sseRef = useRef(null);
  const healthPollRef = useRef(null);

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

    fetch(`${API}/${action}`, { method: 'POST' })
      .then(async (res) => {
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
            const dataMatch  = frame.match(/^data: (.+)/m);
            if (!eventMatch || !dataMatch) continue;

            const event = eventMatch[1];
            const data  = dataMatch[1];

            if (event === 'line') {
              setScriptLines((prev) => [...prev, data]);
            } else if (event === 'done') {
              setScriptLines((prev) => [...prev, '✓ Done.']);
              setRunning(null);
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
      })
      .catch((err) => {
        if (isRestart) {
          // Network drop during restart is expected — server killed itself
          setReconnecting(true);
          setScriptLines((prev) => [...prev, 'Server restarting… reconnecting']);
          startHealthPoll(() => {
            setReconnecting(false);
            setRunning(null);
            setScriptLines((prev) => [...prev, '✓ Back online']);
            // Re-establish log stream
            if (tab === 'logs') connectLogStream();
          });
        } else {
          setScriptLines((prev) => [...prev, `✗ Fetch error: ${err.message}`]);
          setRunning(null);
        }
      });
  }, [running, tab, startHealthPoll, connectLogStream]);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={s.wrapper}>
      <button onClick={() => setOpen((v) => !v)} style={s.toggleBtn}>
        {open ? '✕ Close Ops' : '⚙ Ops'}
      </button>

      {open && (
        <div style={s.panel}>
          <div style={s.panelHeader}>
            <span style={s.panelTitle}>Ops Panel</span>

            <div style={s.actionRow}>
              {[
                { id: 'restart', label: '↺ Restart backend', color: '#4ecdc4' },
                { id: 'update',  label: '↑ Update deps',     color: '#ffd93d' },
                { id: 'pull',    label: '⬇ Git pull',        color: '#c77dff' },
              ].map(({ id, label, color }) => (
                <button
                  key={id}
                  onClick={() => runScript(id)}
                  disabled={!!running}
                  style={{
                    ...s.actionBtn,
                    borderColor: color,
                    color: running === id ? color : '#888',
                    opacity: running && running !== id ? 0.4 : 1,
                  }}
                >
                  {running === id
                    ? reconnecting ? 'Reconnecting…' : `${label}…`
                    : label}
                </button>
              ))}
            </div>

            <div style={s.tabs}>
              {['logs', 'status', 'progress', 'reindex', 'script'].map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  style={{
                    ...s.tab,
                    borderBottom: tab === t ? '2px solid #4ecdc4' : '2px solid transparent',
                    color: tab === t ? '#4ecdc4' : '#666',
                  }}
                >
                  {t}
                  {t === 'script' && running && <span style={s.runningDot} />}
                </button>
              ))}
            </div>
          </div>

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

          {tab === 'script' && (
            <div style={{ ...s.logOutput, height: 280 }}>
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
          )}
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = {
  wrapper: {
    position: 'fixed',
    bottom: 0,
    right: 0,
    zIndex: 1000,
    fontFamily: 'monospace',
    fontSize: 12,
  },
  toggleBtn: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    background: '#1a1d27',
    border: '1px solid #333',
    color: '#aaa',
    padding: '6px 14px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  panel: {
    position: 'fixed',
    bottom: 48,
    right: 12,
    width: 680,
    maxWidth: 'calc(100vw - 24px)',
    background: '#0d1017',
    border: '1px solid #2a2d37',
    borderRadius: 8,
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  panelHeader: {
    background: '#13161f',
    borderBottom: '1px solid #2a2d37',
    padding: '10px 14px 0',
  },
  panelTitle: {
    color: '#e0e0e0',
    fontWeight: 600,
    fontSize: 13,
    display: 'block',
    marginBottom: 8,
  },
  actionRow: { display: 'flex', gap: 8, marginBottom: 10 },
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
  tabs: { display: 'flex', gap: 0 },
  tab: {
    background: 'transparent',
    border: 'none',
    padding: '6px 14px',
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: 'monospace',
    position: 'relative',
  },
  logWrapper: { display: 'flex', flexDirection: 'column', height: 320 },
  logToolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '6px 10px',
    borderBottom: '1px solid #1a1d27',
    background: '#0f1117',
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
  statusPane: { padding: 14, overflowY: 'auto', maxHeight: 320 },
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
};
