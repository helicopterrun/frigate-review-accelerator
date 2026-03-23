/**
 * cursorTs invariant tests
 *
 * Core invariants under test:
 *   1. cursorTs is always a finite number after initial app load.
 *   2. cursorTs is always a finite number after switching cameras.
 *   3. The repeated health-poll init() call does NOT reset selectedCamera
 *      when one is already active (functional-updater guard).
 *
 * Heavy child components (VideoPlayer, VerticalTimeline, AdminPanel) are
 * replaced with stubs to avoid canvas / hls.js / WebGL dependencies that
 * do not exist in jsdom. All API calls are mocked via vi.mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import App from '../App.jsx';

// ── Stub heavy child components ──────────────────────────────────────────────

vi.mock('../components/VideoPlayer.jsx', () => ({
  default: function VideoPlayerStub() {
    return <div data-testid="video-player" />;
  },
}));

vi.mock('../components/VerticalTimeline.jsx', () => ({
  default: function VerticalTimelineStub() {
    return <div data-testid="vertical-timeline" />;
  },
}));

vi.mock('../components/AdminPanel.jsx', () => ({
  default: function AdminPanelStub() {
    return null;
  },
}));

// ── Mock all API calls ────────────────────────────────────────────────────────

vi.mock('../utils/api.js', () => ({
  fetchCameras: vi.fn(),
  fetchHealth: vi.fn(),
  fetchTimeline: vi.fn(),
  fetchPreviewStrip: vi.fn(),
  fetchPlaybackTarget: vi.fn(),
  fetchSegmentInfo: vi.fn(),
  fetchDensity: vi.fn(),
  requestPreviews: vi.fn(),
  eventSnapshotUrl: vi.fn((id) => `/api/events/${id}/snapshot`),
  previewFrameUrl: vi.fn(() => ''),
}));

import {
  fetchCameras,
  fetchHealth,
  fetchTimeline,
  fetchPreviewStrip,
  fetchDensity,
  requestPreviews,
} from '../utils/api.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CAMERAS = [
  { name: 'cam_a', latest_ts: 1700001000 },
  { name: 'cam_b', latest_ts: 1700001200 },
  { name: 'cam_nots' /* no latest_ts — tests fallback to nowTs() */ },
];

const EMPTY_TIMELINE = {
  segments: [],
  gaps: [],
  coverage_pct: 0,
  events: [],
};

const HEALTH = {
  status: 'ok',
  frigate_reachable: true,
  total_segments: 0,
  total_previews: 0,
  pending_previews: 0,
};

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  fetchCameras.mockResolvedValue(CAMERAS);
  fetchHealth.mockResolvedValue(HEALTH);
  fetchTimeline.mockResolvedValue(EMPTY_TIMELINE);
  fetchPreviewStrip.mockResolvedValue({ frames: [] });
  fetchDensity.mockResolvedValue({ buckets: [], bucket_sec: 60 });
  requestPreviews.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** Render App and wait for the loading screen to disappear. */
async function renderApp() {
  render(<App />);
  await waitFor(
    () => expect(screen.queryByText(/Connecting to Accelerator/)).not.toBeInTheDocument(),
    { timeout: 3000 }
  );
}

/** Return the first <select> (camera selector) once it is in the DOM. */
async function getCameraSelect() {
  return screen.findByRole('combobox', {}, { timeout: 2000 });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('cursorTs — initial value', () => {
  it('is a valid timestamp after load (not NaN, not shown as "—")', async () => {
    await renderApp();

    // The timestamp span renders formatTime(cursorTs, '12h') in mobile mode.
    // If cursorTs were NaN or falsy the fallback '—' would appear instead.
    expect(screen.queryByText('—')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('NaN');
  });
});

describe('cursorTs — camera switch', () => {
  it('is set to latest_ts of the new camera (a finite number)', async () => {
    await renderApp();
    const select = await getCameraSelect();

    act(() => {
      fireEvent.change(select, { target: { value: 'cam_b' } });
    });

    // After the switch, cursorTs = cam_b.latest_ts = 1700001200 (finite).
    // The display must not contain NaN or show the fallback dash.
    expect(document.body.textContent).not.toContain('NaN');
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('falls back to nowTs() when camera has no latest_ts (still finite)', async () => {
    await renderApp();
    const select = await getCameraSelect();

    act(() => {
      fireEvent.change(select, { target: { value: 'cam_nots' } });
    });

    // cam_nots has no latest_ts; handleCameraChange calls setCursorTs(nowTs()).
    // nowTs() is always finite — the display must not show NaN or '—'.
    expect(document.body.textContent).not.toContain('NaN');
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });
});

describe('cursorTs — health poll does not reset selectedCamera', () => {
  it('preserves the user-selected camera across repeated init() calls', async () => {
    vi.useFakeTimers();

    render(<App />);

    // Drain the async init() Promise chain.
    // Needs multiple ticks: Promise.all resolve → await continuation →
    // React batch state flush. 10 ticks is conservative but reliable.
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    // Loading is now false; the camera selector is rendered.
    const select = screen.getByRole('combobox');

    // Switch from the default cam_a to cam_b.
    act(() => {
      fireEvent.change(select, { target: { value: 'cam_b' } });
    });
    expect(select.value).toBe('cam_b');

    // Advance 30 s to fire the health-poll setInterval (setInterval(init, 30000)).
    // Then drain the resulting async init() Promise chain again.
    await act(async () => {
      vi.advanceTimersByTime(30001);
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    // The functional updater `setSelectedCamera(prev => prev ?? ...)` must
    // return prev unchanged when prev is already 'cam_b'.
    expect(select.value).toBe('cam_b');
  });
});
