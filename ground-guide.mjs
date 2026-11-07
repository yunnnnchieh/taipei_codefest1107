const radians = degrees => degrees * Math.PI / 180;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function cameraDownAngle({ beta, gamma }) {
  if (![beta, gamma].every(Number.isFinite)) return 0;
  return Math.asin(Math.cos(radians(beta)) * Math.cos(radians(gamma))) * 180 / Math.PI;
}

// Pinhole projection with an assumed camera height and lens field of view.
export function groundProjector(width, height, tilt, heading) {
  const pitch = radians(tilt);
  const yaw = radians(heading);
  const pitchCos = Math.cos(pitch);
  const pitchSin = Math.sin(pitch);
  const yawCos = Math.cos(yaw);
  const yawSin = Math.sin(yaw);
  const focal = Math.max(width, height) * .77;
  const cameraHeight = 1.45;
  return (along, across) => {
    const right = along * yawSin + across * yawCos;
    const forward = along * yawCos - across * yawSin;
    const depth = forward * pitchCos + cameraHeight * pitchSin;
    if (depth < .30) return null;
    return {
      x: width / 2 + focal * right / depth,
      y: height / 2 + focal * (cameraHeight * pitchCos - forward * pitchSin) / depth,
    };
  };
}

// Follow an incoming line, a tangent circular arc, then an outgoing line.
export function groundPath({ remaining, turn }) {
  const near = .65;
  if (!turn) {
    return {
      near, far: Math.min(14, remaining ?? 14), halfWidth: .34,
      point: (at, lateral) => [at, lateral],
    };
  }
  const sweep = radians(Math.abs(turn));
  const side = Math.sign(turn);
  // The corner is a preview. Keep it ahead even when the estimated corner is very near or far.
  const start = clamp(remaining - 1.15, 3.4, 5.8);
  const radius = Math.max(.8, 1.15 / Math.tan(sweep / 2));
  const arcEnd = start + radius * sweep;
  return {
    near, far: arcEnd + 2.4, halfWidth: .34, bend: [start, arcEnd],
    point(at, lateral) {
      if (at <= start) return [at, lateral];
      const theta = Math.min(sweep, (at - start) / radius);
      const tail = Math.max(0, at - arcEnd);
      const forward = start + (radius - side * lateral) * Math.sin(theta) + tail * Math.cos(theta);
      const right = side * radius - (side * radius - lateral) * Math.cos(theta) + side * tail * Math.sin(theta);
      return [forward, right];
    },
  };
}

// Fit the upcoming arc between the AR header and the walking controls.
export function projectGuide(width, height, tilt, angle, path) {
  if (!path.bend) return groundProjector(width, height, tilt, angle);
  const project = groundProjector(width, height, clamp(tilt, 16, 38), clamp(angle, -15, 15));
  const [start, end] = path.bend;
  const samples = Array.from({ length: 7 }, (_, i) => project(...path.point(start + (end - start) * i / 6, 0)));
  const xs = samples.map(point => point.x);
  const ys = samples.map(point => point.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min(1, width * .73 / (maxX - minX), height * .29 / (maxY - minY));
  const shiftX = clamp(0, width * .13 - scale * minX, width * .87 - scale * maxX);
  const shiftY = clamp(0, height * .23 - scale * minY, height * .55 - scale * maxY);
  return (along, across) => {
    const point = project(along, across);
    return point && { x: point.x * scale + shiftX, y: point.y * scale + shiftY };
  };
}

export function createGroundGuide(canvas) {
  const ctx = canvas.getContext('2d');
  let state;
  let frame = 0;
  let width = 0;
  let height = 0;
  let ratio = 1;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const resize = new ResizeObserver(() => {
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    if (width && height && state && !frame && !document.hidden) frame = requestAnimationFrame(render);
  });
  resize.observe(canvas);

  function polygon(vertices, fill, stroke) {
    if (vertices.some(point => !point)) return;
    ctx.beginPath();
    vertices.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }

  function render(time) {
    frame = 0;
    if (!state || document.hidden) return;
    const { angle, tilt, remaining, path } = state;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!width || !height) return;
    const project = projectGuide(width, height, tilt, angle, path);
    const { near, far, halfWidth, bend } = path;
    const chevronWidth = halfWidth * .8;
    const at = (along, across) => project(...path.point(along, across));
    if (far > near) {
      ctx.lineWidth = 1.2;
      for (let end = far; end > near; end -= .20) {
        const start = Math.max(near, end - .20);
        const curving = bend && end >= bend[0] && start <= bend[1];
        polygon([at(start, -halfWidth), at(start, halfWidth), at(end, halfWidth), at(end, -halfWidth)],
          curving ? '#f5ba4b86' : '#5ab4c552', curving ? '#f8e3bc' : '#b4e2ea70');
      }
      const phase = reduceMotion.matches ? 0 : time / 1000 % 1;
      for (let end = far - 1 + phase; end > near + .48; end -= 1) {
        const vertices = [
          at(end - .47, -chevronWidth), at(end, 0), at(end - .47, chevronWidth),
          at(end - .55, chevronWidth), at(end - .16, 0), at(end - .55, -chevronWidth),
        ];
        polygon(vertices, '#dbf1f5', '#112629');
      }
    }
    if (!bend && remaining !== null && remaining >= .4 && remaining <= 14) {
      const ring = Array.from({ length: 20 }, (_, i) => {
        const a = i * Math.PI / 10;
        return project(remaining + Math.cos(a) * .34, Math.sin(a) * .34);
      });
      ctx.lineWidth = 3;
      polygon(ring, '#f5ba4b50', '#f8e3bc');
    }
    frame = requestAnimationFrame(render);
  }

  document.addEventListener('visibilitychange', () => {
    if (state && !frame && !document.hidden) frame = requestAnimationFrame(render);
  });

  return next => {
    state = next ? { ...next, path: groundPath(next) } : null;
    canvas.hidden = !next;
    if (next && !frame && !document.hidden) frame = requestAnimationFrame(render);
    if (!next && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}
