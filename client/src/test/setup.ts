import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

configure({ asyncUtilTimeout: 15_000 });

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? function scrollIntoView() {};

// Node 26 emits localStorage as an experimental global without --localstorage-file.
// JSDOM in this runner may consequently leave localStorage undefined even with a
// valid origin. Install a deterministic Web Storage fallback for test-only use.
class TestStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(String(key)) ?? null; }
  key(index: number): string | null { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string): void { this.values.delete(String(key)); }
  setItem(key: string, value: string): void { this.values.set(String(key), String(value)); }
}

if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage?.clear !== 'function') {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: new TestStorage() });
}
if (typeof globalThis.sessionStorage === 'undefined' || typeof globalThis.sessionStorage?.clear !== 'function') {
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, writable: true, value: new TestStorage() });
}
