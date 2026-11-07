import { cameraDownAngle, createGroundGuide } from './ground-guide.mjs';
import { cameraHeading, signedAngle, walkingLegs, walkingPosition } from './ar-route.mjs';
import { advanceDistance, createStepDetector } from './motion.mjs';

const stride = .65;

async function sensorAllowed(sensor) {
  if (!sensor) return false;
  try {
    return typeof sensor.requestPermission !== 'function' || await sensor.requestPermission() === 'granted';
  } catch {
    return false;
  }
}

export function createAR(dialog, network, advance, updateMiniMap) {
  const find = name => dialog.querySelector('[data-ar="' + name + '"]');
  const video = find('video');
  const calibrate = find('calibrate');
  const stepButton = find('step');
  const draw = createGroundGuide(find('ground'));
  let context;
  let legs = [];
  let subleg = 0;
  let distance = 0;
  let stream;
  let request = 0;
  let heading = null;
  let tilt = 20;
  let offset = null;
  let aligned = false;
  let sensorRequest;
  let pendingBearing = null;
  let detectStep = createStepDetector();
  let motionSeen = false;
  let message = '';

  function headingError(position) {
    return heading !== null && offset !== null ? signedAngle(position.bearing - heading - offset) : null;
  }

  function paint() {
    const leg = legs[subleg];
    const position = leg && walkingPosition(leg, distance);
    const mapHeading = heading !== null && offset !== null ? heading + offset : 0;
    const angle = position ? headingError(position) : null;
    if (dialog.open) updateMiniMap(mapHeading, position?.uv);
    const ready = Boolean(stream && aligned && leg);
    const facing = angle === null || Math.abs(angle) <= 55;
    const remaining = leg ? Math.max(0, leg.length - distance) : 0;
    const turn = leg?.turn ?? 0;
    draw(ready && facing ? { angle: angle ?? 0, tilt, remaining, turn } : null);
    const alert = find('direction');
    alert.hidden = !(ready && !facing);
    if (!alert.hidden) alert.textContent = Math.abs(angle) > 155 ? '↶ 轉身後繼續' : angle > 0 ? '→ 朝右方通道前進' : '← 朝左方通道前進';
    const turnLabel = Math.abs(turn) >= 165 ? '迴轉' : turn > 0 ? '右轉' : '左轉';
    const hint = message || (!stream ? '' : !leg
      ? context.step ? '依站內標示通過設施，到達後按「到了」。' : '路線已完成。'
      : !ready ? '面向第一段通道，按「開始步伐引導」。'
        : remaining <= .05 ? '估算已到。看到地標或轉角後，請按「到了」。'
          : turn ? '前方' + turnLabel + ' · 到了實際轉角再轉。'
            : '將手機稍向下。到達轉角或地標後按「到了」。');
    const hintElement = find('hint');
    if (hintElement.textContent !== hint) hintElement.textContent = hint;
    const progress = find('progress');
    const progressText = ready
      ? (motionSeen ? '步伐偵測中' : '尚未收到步伐感測 · 可手動補步') + ' · 本段約 ' + distance.toFixed(1) + ' / ' + leg.length.toFixed(1) + ' m'
      : '';
    if (progress.textContent !== progressText) progress.textContent = progressText;
    stepButton.hidden = !ready || remaining <= .05;
    calibrate.hidden = !stream || !leg;
    calibrate.textContent = aligned ? '重設朝向' : '開始步伐引導';
    calibrate.classList.toggle('quiet', aligned);
  }

  function recordStep(manual = false) {
    const leg = legs[subleg];
    if (!stream || !aligned || !leg || distance >= leg.length) return;
    const angle = manual ? 0 : headingError(walkingPosition(leg, distance)) ?? 0;
    const next = advanceDistance(distance, stride, angle, leg.length);
    if (next === distance) return;
    distance = next;
    paint();
  }

  function onMotion(event) {
    const axes = event.accelerationIncludingGravity;
    if (!axes || ![axes.x, axes.y, axes.z].every(Number.isFinite)) return;
    const step = detectStep(axes, event.timeStamp);
    if (!motionSeen) {
      motionSeen = true;
      paint();
    }
    if (step) recordStep();
  }

  function onOrientation(event) {
    const value = cameraHeading(event);
    if (value === null) return;
    heading = heading === null ? value : heading + signedAngle(value - heading) * .35;
    tilt = Math.max(-12, Math.min(65, cameraDownAngle(event)));
    if (pendingBearing !== null) {
      offset = signedAngle(pendingBearing - heading);
      pendingBearing = null;
    }
    paint();
  }

  function stop() {
    request++;
    window.removeEventListener('deviceorientation', onOrientation);
    window.removeEventListener('devicemotion', onMotion);
    stream?.getTracks().forEach(track => track.stop());
    stream = undefined;
    video.srcObject = null;
    draw(null);
    heading = offset = pendingBearing = null;
    sensorRequest = undefined;
    tilt = 20;
    aligned = motionSeen = false;
    detectStep = createStepDetector();
    message = '';
  }

  async function startCamera() {
    const id = ++request;
    find('retry').hidden = true;
    message = '正在開啟後鏡頭…';
    paint();
    try {
      const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (id !== request || !dialog.open) {
        media.getTracks().forEach(track => track.stop());
        return;
      }
      stream = media;
      video.srcObject = stream;
      await video.play();
      if (id !== request) return;
      message = '';
      for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => {
        if (id !== request) return;
        stop();
        message = '相機已中斷，可以重新開啟。';
        find('retry').hidden = false;
        paint();
      });
      paint();
    } catch (error) {
      if (id !== request) return;
      stop();
      message = error.name === 'NotAllowedError'
        ? '請在 Safari 允許此網站使用相機，再重新開啟。'
        : '無法開啟相機。請使用 iPhone Safari 開啟網站後重試。';
      find('retry').hidden = false;
      paint();
    }
  }

  function align() {
    const leg = legs[subleg];
    if (!leg || !stream) return;
    const id = request;
    const { bearing } = walkingPosition(leg, distance);
    aligned = true;
    if (heading === null) pendingBearing = bearing;
    else offset = signedAngle(bearing - heading);
    if (!sensorRequest) {
      sensorRequest = Promise.all([
        sensorAllowed(window.DeviceMotionEvent),
        sensorAllowed(window.DeviceOrientationEvent),
      ]).then(([motion, orientation]) => {
        if (id !== request) return;
        if (motion) window.addEventListener('devicemotion', onMotion);
        if (orientation) window.addEventListener('deviceorientation', onOrientation);
        if (!motion && !orientation) sensorRequest = undefined;
      });
    }
    paint();
  }

  function update(next) {
    const changed = context?.step !== next.step;
    context = next;
    if (changed) {
      legs = walkingLegs(context.step, context.after, network.positions);
      subleg = distance = 0;
      if (pendingBearing !== null) pendingBearing = legs[0]?.segments[0].bearing ?? null;
    }
    if (!dialog.open) return;
    const corner = subleg < legs.length - 1;
    find('floor').textContent = context.here.level_id;
    find('here').textContent = context.here.label;
    find('instruction').textContent = corner ? '沿通道走到下一個轉角' : context.instruction;
    find('detail').textContent = context.detail;
    find('next').hidden = !context.step;
    find('next').textContent = corner ? '到了 · 通道轉角' : '到了 · 下一個地標';
    paint();
  }

  find('close').onclick = () => { stop(); dialog.close(); };
  dialog.addEventListener('close', () => { if (!dialog.open) stop(); });
  window.addEventListener('pagehide', () => {
    if (dialog.open) dialog.close();
    stop();
  });
  find('retry').onclick = startCamera;
  calibrate.onclick = align;
  stepButton.onclick = () => recordStep(true);
  find('next').onclick = () => {
    if (subleg < legs.length - 1) {
      subleg++;
      distance = 0;
      if (pendingBearing !== null) pendingBearing = legs[subleg].segments[0].bearing;
      update(context);
    } else advance();
  };
  return {
    update,
    open() {
      if (!context?.step || dialog.open) return;
      dialog.showModal();
      update(context);
      startCamera();
    },
  };
}
