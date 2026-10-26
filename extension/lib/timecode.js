const pad = (n) => String(n).padStart(2, '0');

// Matches the Frame.io player: partial frames are dropped (floor), not rounded.
// Fractional rates (23.976, 29.97) count frames at the real rate and label
// them against the nominal rate, like non-drop-frame timecode.
export function toTimecode(seconds, fps) {
  if (seconds == null || Number.isNaN(seconds)) return '';
  if (!fps) {
    const s = Math.floor(seconds + 1e-6);
    return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(pad).join(':');
  }
  const base = Math.round(fps);
  const totalFrames = Math.floor(seconds * fps + 1e-6);
  const ff = totalFrames % base;
  const totalSec = Math.floor(totalFrames / base);
  return [Math.floor(totalSec / 3600), Math.floor(totalSec / 60) % 60, totalSec % 60, ff].map(pad).join(':');
}
