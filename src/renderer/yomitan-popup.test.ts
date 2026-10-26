import test from 'node:test';
import assert from 'node:assert/strict';
import {
  YOMITAN_POPUP_HOST_SELECTOR,
  YOMITAN_POPUP_IFRAME_SELECTOR,
  YOMITAN_POPUP_VISIBLE_HOST_SELECTOR,
  hasYomitanPopupIframe,
  isYomitanPopupIframe,
  isYomitanPopupVisible,
  registerDictionaryPopupVisibilityListener,
  shieldYomitanHoverScan,
} from './yomitan-popup.js';

type FakeStyle = Pick<CSSStyleDeclaration, 'visibility' | 'display' | 'opacity'>;
type FakeFrame = Element & { fakeStyle: FakeStyle };

test('native popup attention events from either backend have the same lifecycle', () => {
  for (const backend of ['yomitan', 'hachidori']) {
    const target = new EventTarget();
    const calls: string[] = [];
    const disposeShown = registerDictionaryPopupVisibilityListener(
      'shown',
      () => calls.push('shown'),
      target,
    );
    const disposeHidden = registerDictionaryPopupVisibilityListener(
      'hidden',
      () => calls.push('hidden'),
      target,
    );
    target.dispatchEvent(new CustomEvent(`${backend}-popup-shown`));
    target.dispatchEvent(new CustomEvent(`${backend}-popup-hidden`));
    disposeShown();
    disposeHidden();
    target.dispatchEvent(new CustomEvent(`${backend}-popup-shown`));
    target.dispatchEvent(new CustomEvent(`${backend}-popup-hidden`));
    assert.deepEqual(calls, ['shown', 'hidden']);
  }
});

const VISIBLE_STYLE: FakeStyle = { visibility: 'visible', display: 'block', opacity: '1' };

function frame(options: { width?: number; height?: number; style?: Partial<FakeStyle> } = {}) {
  return {
    getBoundingClientRect: () => ({ width: options.width ?? 320, height: options.height ?? 180 }),
    fakeStyle: { ...VISIBLE_STYLE, ...options.style },
  } as unknown as FakeFrame;
}

function host(visibleAttribute: string | null): Element {
  return { getAttribute: () => visibleAttribute } as unknown as Element;
}

// Root whose querySelectorAll answers each popup selector with the given elements.
function popupRoot(elements: { visibleHosts?: Element[]; iframes?: Element[]; hosts?: Element[] }) {
  const bySelector: Record<string, Element[]> = {
    [YOMITAN_POPUP_VISIBLE_HOST_SELECTOR]: elements.visibleHosts ?? [],
    [YOMITAN_POPUP_IFRAME_SELECTOR]: elements.iframes ?? [],
    [YOMITAN_POPUP_HOST_SELECTOR]: elements.hosts ?? [],
  };
  return {
    querySelectorAll: (selector: string) => bySelector[selector] ?? [],
  } as unknown as ParentNode;
}

function withComputedStyle(run: () => void): void {
  const previousWindow = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { getComputedStyle: (element: FakeFrame) => element.fakeStyle },
  });
  try {
    run();
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  }
}

test('isYomitanPopupIframe matches modern popup class and legacy id prefix', () => {
  const element = (options: { id?: string; classNames?: string[] }): Element =>
    ({
      tagName: 'IFRAME',
      id: options.id ?? '',
      classList: {
        contains: (className: string) => (options.classNames ?? []).includes(className),
      },
    }) as unknown as Element;

  assert.equal(isYomitanPopupIframe(element({ classNames: ['yomitan-popup'] })), true);
  assert.equal(isYomitanPopupIframe(element({ id: 'yomitan-popup-123' })), true);
  assert.equal(isYomitanPopupIframe(element({ id: 'something-else' })), false);
});

test('hasYomitanPopupIframe detects popup iframes or shadow-hosted popup hosts', () => {
  const rootWith = (matches: string[]) =>
    ({
      querySelector: (selector: string) => (matches.includes(selector) ? {} : null),
    }) as unknown as ParentNode;

  assert.equal(hasYomitanPopupIframe(rootWith([YOMITAN_POPUP_IFRAME_SELECTOR])), true);
  assert.equal(hasYomitanPopupIframe(rootWith([YOMITAN_POPUP_HOST_SELECTOR])), true);
  assert.equal(hasYomitanPopupIframe(rootWith([])), false);
});

const visibilityCases: Array<{
  name: string;
  root: () => ParentNode;
  expected: boolean;
}> = [
  {
    name: 'detects a host marked visible without iframe access',
    root: () => popupRoot({ visibleHosts: [host('true')] }),
    expected: true,
  },
  {
    name: 'detects a visible iframe among hidden ones',
    root: () => popupRoot({ iframes: [frame({ style: { visibility: 'hidden' } }), frame()] }),
    expected: true,
  },
  {
    name: 'ignores iframes that are hidden, undisplayed, transparent, or zero-sized',
    root: () =>
      popupRoot({
        iframes: [
          frame({ style: { visibility: 'hidden' } }),
          frame({ style: { display: 'none' } }),
          frame({ style: { opacity: '0' } }),
          frame({ width: 0 }),
          frame({ height: 0 }),
        ],
      }),
    expected: false,
  },
  {
    name: 'detects a popup host carrying the visible attribute',
    root: () => popupRoot({ hosts: [host('false'), host('true')] }),
    expected: true,
  },
  {
    name: 'ignores popup hosts without the visible attribute',
    root: () => popupRoot({ hosts: [host(null), host('false')] }),
    expected: false,
  },
];

for (const c of visibilityCases) {
  test(`isYomitanPopupVisible ${c.name}`, () => {
    withComputedStyle(() => {
      assert.equal(isYomitanPopupVisible(c.root()), c.expected);
    });
  });
}

test('isYomitanPopupVisible falls back to querySelector when querySelectorAll is unavailable', () => {
  const root = {
    querySelector: (selector: string) =>
      selector === YOMITAN_POPUP_VISIBLE_HOST_SELECTOR ? ({} as Element) : null,
  } as ParentNode;

  assert.equal(isYomitanPopupVisible(root), true);
});

test('hover scan shield stops idle pointer hover inside the container before the scanner', () => {
  const root = new EventTarget();
  const inside = { nodeType: 1 };
  const outside = { nodeType: 1 };
  const container = { contains: (node: unknown) => node === inside } as unknown as Node;
  let active = true;
  const scanned: string[] = [];
  const dispose = shieldYomitanHoverScan(container, () => active, root);
  // Registered after the shield, like Yomitan's scanner hooking up once its options load.
  for (const type of ['pointerover', 'pointermove']) {
    root.addEventListener(type, (event) => scanned.push(`${type}:${String(event.target)}`), true);
  }

  const fire = (type: string, origin: unknown, buttons = 0) => {
    const event = new Event(type);
    Object.defineProperty(event, 'buttons', { value: buttons });
    Object.defineProperty(event, 'target', { value: origin });
    root.dispatchEvent(event);
  };

  fire('pointermove', inside);
  fire('pointerover', inside);
  assert.deepEqual(scanned, [], 'idle hover inside the container is not scanned');

  fire('pointermove', inside, 1);
  assert.equal(scanned.length, 1, 'drags still reach other listeners');

  fire('pointermove', outside);
  assert.equal(scanned.length, 2, 'hover outside the container is untouched');

  active = false;
  fire('pointermove', inside);
  assert.equal(scanned.length, 3, 'an inactive shield lets everything through');

  active = true;
  dispose();
  fire('pointermove', inside);
  assert.equal(scanned.length, 4, 'disposing removes the shield');
});
