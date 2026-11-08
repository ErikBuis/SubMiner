export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The part of a window's visible frame that is its client area, i.e. the frame minus the
 * title bar and borders. Returns null when the client area fills the whole frame
 * (fullscreen or borderless mpv) or can't be read, so callers fall back to the frame.
 */
export function resolveClientAreaBounds(
  frame: WindowBounds,
  client: WindowBounds | null,
): WindowBounds | null {
  if (!client) return null;
  const values = [client.x, client.y, client.width, client.height];
  if (values.some((value) => !Number.isFinite(value)) || client.width <= 0 || client.height <= 0) {
    return null;
  }

  // The client area should already sit inside the frame; clamp in case a resize races the poll.
  const left = Math.max(frame.x, client.x);
  const top = Math.max(frame.y, client.y);
  const right = Math.min(frame.x + frame.width, client.x + client.width);
  const bottom = Math.min(frame.y + frame.height, client.y + client.height);
  if (right <= left || bottom <= top) return null;

  const bounds = { x: left, y: top, width: right - left, height: bottom - top };
  if (
    bounds.x === frame.x &&
    bounds.y === frame.y &&
    bounds.width === frame.width &&
    bounds.height === frame.height
  ) {
    return null;
  }
  return bounds;
}
