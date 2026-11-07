
export function createStepDetector() {
  let baseline;
  let armed = true;
  let lastStep = -Infinity;
  return (axes, timestamp) => {
    if (!axes || ![axes.x, axes.y, axes.z].every(Number.isFinite)) return false;
    const magnitude = Math.hypot(axes.x, axes.y, axes.z);
    baseline ??= magnitude;
    baseline += (magnitude - baseline) * 0.04;
    const pulse = magnitude - baseline;
    if (pulse < 0.45) armed = true;
    if (!armed || pulse < 1.1 || timestamp - lastStep < 320) return false;
    armed = false;
    lastStep = timestamp;
    return true;
  };
}

export function advanceDistance(distance, stride, headingError, maxDistance) {
  if (Math.abs(headingError) > 40) return distance;
  return Math.min(maxDistance, distance + stride * Math.cos(headingError * Math.PI / 180));
}
