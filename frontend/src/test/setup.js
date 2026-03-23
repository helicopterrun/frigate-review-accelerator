import { expect } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

// Mock matchMedia — jsdom does not implement this; useIsMobile() depends on it.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Stub requestAnimationFrame so App's RAF autoplay loop does not fire during
// tests. jsdom's implementation can call callbacks unexpectedly, causing
// cursorTs to advance between assertion points.
let _rafId = 0;
global.requestAnimationFrame = () => ++_rafId;
global.cancelAnimationFrame = () => {};
