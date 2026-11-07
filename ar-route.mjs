export const signedAngle = angle => ((angle + 180) % 360 + 360) % 360 - 180;

export function cameraHeading({ alpha, beta, gamma }) {
  if (![alpha, beta, gamma].every(Number.isFinite)) return null;
  const [yaw, pitch, roll] = [alpha, beta, gamma].map(angle => angle * Math.PI / 180);
  const east = -Math.cos(yaw) * Math.sin(roll) - Math.sin(yaw) * Math.sin(pitch) * Math.cos(roll);
  const north = -Math.sin(yaw) * Math.sin(roll) + Math.cos(yaw) * Math.sin(pitch) * Math.cos(roll);
  if (Math.hypot(east, north) < .45) return null;
  return Math.atan2(east, north) * 180 / Math.PI;
}

// Reuse the old B1 exit-based scale, adjusted for the new image width.
const metersPerPixel = .33 * 1518 / 1872;
export const mapDistance = (a, b) => Math.hypot((b[0] - a[0]) * 1872, (b[1] - a[1]) * 2013) * metersPerPixel;

function walkingSegments(step, positions) {
  if (!step || step.edge.mode !== 'walk' || step.from.level_id !== step.to.level_id) return [];
  const geometry = step.edge.geometry?.uv;
  const points = geometry
    ? step.edge.from_node === step.from.id ? geometry : [...geometry].reverse()
    : [positions.get(step.from.id), positions.get(step.to.id)];
  if (points.some(point => !point)) return [];
  const segments = [];
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    const length = mapDistance(from, to);
    if (!length) continue;
    const bearing = Math.atan2((to[0] - from[0]) * 1872, (from[1] - to[1]) * 2013) * 180 / Math.PI;
    segments.push({ from, to, length, bearing });
  }
  return segments;
}

export function walkingLegs(step, after, positions) {
  const legs = [];
  for (const segment of walkingSegments(step, positions)) {
    let leg = legs.at(-1);
    if (!leg || Math.abs(signedAngle(segment.bearing - leg.segments.at(-1).bearing)) >= 25) {
      leg = { segments: [], length: 0, turn: 0 };
      legs.push(leg);
    }
    leg.segments.push(segment);
    leg.length += segment.length;
  }
  const afterBearing = walkingSegments(after, positions)[0]?.bearing;
  for (const [i, leg] of legs.entries()) {
    const next = legs[i + 1]?.segments[0].bearing ?? afterBearing;
    const turn = Number.isFinite(next) ? signedAngle(next - leg.segments.at(-1).bearing) : 0;
    if (Math.abs(turn) >= 25) leg.turn = turn;
  }
  return legs;
}

export function walkingPosition(leg, distance) {
  let remaining = Math.max(0, distance);
  for (const segment of leg.segments) {
    if (remaining >= segment.length && segment !== leg.segments.at(-1)) {
      remaining -= segment.length;
      continue;
    }
    const t = Math.min(1, remaining / segment.length);
    return {
      uv: segment.from.map((value, axis) => value + (segment.to[axis] - value) * t),
      bearing: segment.bearing,
    };
  }
}
