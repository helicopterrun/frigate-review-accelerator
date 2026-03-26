// Where the reticle sits as a fraction of the timeline height (0=top, 1=bottom)
export const RETICLE_FRACTION = 0.45;

// Zoom
export const ZOOM_STOPS = [
  5*60, 8*60, 10*60, 15*60, 20*60, 30*60, 45*60,
  3600, 2*3600, 4*3600, 8*3600, 12*3600, 18*3600, 24*3600, 48*3600, 7*24*3600,
];
export const ZOOM_STOP_LABELS = [
  '5m','8m','10m','15m','20m','30m','45m',
  '1h','2h','4h','8h','12h','18h','24h','48h','7d',
];
export const ZOOM_PRESETS = [
  { label: '30m', sec: 30*60 },
  { label: '1h',  sec: 3600 },
  { label: '8h',  sec: 8*3600 },
  { label: '1d',  sec: 24*3600 },
];

// Scroll physics
export const DAMPING = 0.97;
export const K       = 0.06;
export const K_TOUCH = 0.03;

// Tick marks
export const TICK_INTERVALS = [5,10,15,30,60,120,300,600,900,1800,3600,7200,10800,21600,43200,86400];
export const MIN_TICK_PX = 32;

// Design tokens
export const RETICLE_COLOR     = 0xFF592E;
export const RETICLE_BAR_H     = 14;
export const RETICLE_DOT_SIZE  = 13;
export const ICON_SIZE_PERSON  = { w: 16, h: 20 };
export const ICON_SIZE_ANIMAL  = { w: 20, h: 20 };
export const ICON_FALLBACK_R   = 5;
export const ARROW_W           = 14;
export const ARROW_H           = 30;

export const PERSON_LABELS = new Set(['person']);
export const ANIMAL_LABELS = new Set(['dog','cat','bird','horse','bear','deer']);

export const EVENT_COLORS = {
  person: 0x4CAF50, car: 0x2196F3, truck: 0x1565C0, motorcycle: 0xE91E63,
  bicycle: 0x00BCD4, dog: 0xFF9800, cat: 0x9C27B0, bird: 0x8BC34A,
  horse: 0x795548, bear: 0x607D8B, deer: 0xA1887F, package: 0xFFC107,
  default: 0x888888,
};

export const ASSET_PATHS = {
  rtclBar: '/assets/timeline/rtcl-bar.svg',
  rtclDot: '/assets/timeline/rtcl-dot.svg',
  person:  '/assets/timeline/object-person.svg',
  animal:  '/assets/timeline/object-animal.svg',
  arrow:   '/assets/timeline/arrow.svg',
};
