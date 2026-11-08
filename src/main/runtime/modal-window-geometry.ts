import type { WindowGeometry } from '../../types';

export interface ContentGeometrySource {
  getGeometry: () => WindowGeometry | null;
  getContentGeometry: () => WindowGeometry | null;
}

function sameGeometry(a: WindowGeometry, b: WindowGeometry): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Bounds for the modal window (card review and other dialogs). While a modal is open the
 * window takes every click inside it, so it only covers mpv's client area: a windowed mpv's
 * title bar and borders stay usable for moving, resizing, minimizing or closing mpv.
 * Geometry that isn't the tracked mpv window (a fallback display area) is left alone.
 */
export function resolveModalWindowGeometry(
  geometry: WindowGeometry,
  tracker: ContentGeometrySource | null | undefined,
): WindowGeometry {
  if (!tracker) return geometry;
  const tracked = tracker.getGeometry();
  const content = tracker.getContentGeometry();
  if (!tracked || !content || !sameGeometry(tracked, geometry)) return geometry;
  return { x: content.x, y: content.y, width: content.width, height: content.height };
}
