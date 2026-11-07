import { buildNetwork, findRoute, modes } from './routes.mjs';
import { createScene } from './scene.mjs';
import { createAR } from './ar-camera.mjs';
import { mapDistance } from './ar-route.mjs';

const $ = id => document.getElementById(id);

async function init() {
  const response = await fetch(new URL('./station.json', import.meta.url));
  if (!response.ok) throw new Error('無法讀取 station.json');
  const data = await response.json();
  const network = buildNetwork(data);
  const start = $('start');
  const end = $('end');
  const status = $('status');
  const current = $('current');
  let route = null;
  let cursor = 0;
  let floor = 'all';
  let top = false;
  let picking = null;

  for (const [select, placeholder] of [[start, '選擇你所在的地標'], [end, '選擇要去的地標']]) {
    select.add(new Option(placeholder, ''));
    for (const level of data.levels) {
      const group = document.createElement('optgroup');
      group.label = level.id + ' · ' + level.label;
      for (const node of data.nodes.filter(node => node.level_id === level.id)) {
        group.append(new Option(node.label, node.id));
      }
      select.append(group);
    }
  }

  const scene = createScene($('scene'), data, network, node => {
    $(picking).value = node.id;
    picking = null;
    plan();
  });

  const miniMap = createScene($('ar-map'), data, network);
  const miniMapSpan = 56 / mapDistance([0, 0], [1, 0]);
  let miniMapCenter;
  let miniMapFloor;
  const ar = createAR($('ar'), network, () => advance(1), (heading, position) => {
    const node = route?.steps[cursor - 1]?.to || network.nodes.get(start.value);
    if (!node) return;
    const uv = position || network.positions.get(node.id);
    if (!uv) return;
    if (miniMapFloor !== node.level_id || !miniMapCenter) {
      miniMapFloor = node.level_id;
      miniMapCenter = uv;
    }
    const fromCenter = mapDistance(miniMapCenter, uv);
    if (fromCenter > 16) {
      miniMapCenter = uv.map((value, axis) => value + (miniMapCenter[axis] - value) * 16 / fromCenter);
    }
    miniMap.update({
      floor: node.level_id, top: true, compact: true, heading,
      viewCenter: miniMapCenter, viewSpan: miniMapSpan, currentUV: uv,
      current: node, end: network.nodes.get(end.value), steps: route?.steps, step: cursor,
    });
  });
  $('open-ar').addEventListener('click', ar.open);

  const floorButtons = new Map();
  for (const [id, name] of [['all', '所有樓層'], ...data.levels.map(level => [level.id, level.id])]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = name;
    button.title = network.levels.get(id)?.label || '顯示完整跨樓層路線';
    button.addEventListener('click', () => {
      floor = id;
      if (id === 'all') top = false;
      scene.resetZoom();
      updateMap();
    });
    floorButtons.set(id, button);
    $('floors').append(button);
  }

  function updateMap() {
    const node = route?.steps[cursor - 1]?.to || network.nodes.get(start.value);
    const displayedFloor = top && floor === 'all' ? node?.level_id || 'B1' : floor;
    for (const [id, button] of floorButtons) button.setAttribute('aria-pressed', id === displayedFloor);
    $('view').setAttribute('aria-pressed', top);
    $('view').textContent = top ? '切回立體' : '俯視';
    $('pick-start').setAttribute('aria-pressed', picking === 'start');
    $('pick-end').setAttribute('aria-pressed', picking === 'end');
    $('scene').parentElement.classList.toggle('picking', Boolean(picking));
    $('map-hint').textContent = picking
      ? '點選地標圓點 · 太密時可切換樓層'
      : top ? '俯視 · 可切換樓層' : '拖曳旋轉地圖';
    scene.update({ floor, top, picking, current: node, end: network.nodes.get(end.value), steps: route?.steps, step: cursor });
  }

  function describe({ from, to, edge }) {
    if (edge.mode === 'fare_gate') {
      if (to.paid_area === 'paid') return '通過閘門進站';
      if (from.paid_area === 'paid') return '通過閘門出站';
    }
    return modes[edge.mode] || edge.mode;
  }

  function details(step) {
    const { from, to, edge } = step;
    const result = [];
    if (from.level_id !== to.level_id) {
      result.push(from.level_id + ' → ' + to.level_id);
      const lower = Math.min(network.levels.get(from.level_id).order, network.levels.get(to.level_id).order);
      const upper = Math.max(network.levels.get(from.level_id).order, network.levels.get(to.level_id).order);
      const skipped = data.levels.filter(level => level.order > lower && level.order < upper).map(level => level.id);
      if (skipped.length) result.push('此路段未設 ' + skipped.join('、') + ' 停靠點');
    }
    if (edge.facility_id) result.push(network.facilities.get(edge.facility_id)?.label || edge.facility_id);
    if (edge.status === 'inferred') result.push('推定路段，請現場核對');
    return result.join(' · ');
  }

  function updateGuide() {
    const steps = route?.steps || [];
    const here = steps[cursor - 1]?.to || network.nodes.get(start.value);
    const next = steps[cursor];
    $('open-ar').disabled = !next;
    ar.update({ here, step: next, after: steps[cursor + 1],
      instruction: next ? describe(next) + ' → ' + next.to.label : '已到達目的地',
      detail: next ? details(next) : '' });
    $('progress').hidden = steps.length === 0;
    $('all-steps').hidden = steps.length === 0;
    $('back').disabled = cursor === 0;
    $('next').disabled = !next;
    current.hidden = !here;
    current.replaceChildren();
    if (here) {
      const location = document.createElement('small');
      location.textContent = '目前 · ' + here.level_id + ' ' + here.label;
      const action = document.createElement('strong');
      action.textContent = next ? describe(next) + ' → ' + next.to.label : route ? '已到達目的地' : '請選擇可連通的目的地';
      current.append(location, action);
      if (next) {
        const note = document.createElement('small');
        note.textContent = details(next);
        if (next.edge.status === 'inferred') note.className = 'step-warning';
        current.append(note);
      }
    }
    const list = $('steps');
    list.replaceChildren();
    for (const [index, step] of steps.entries()) {
      const li = document.createElement('li');
      if (index === cursor) li.setAttribute('aria-current', 'step');
      li.textContent = describe(step) + ' → ' + step.to.label;
      const note = details(step);
      if (note) {
        const small = document.createElement('span');
        small.className = step.edge.status === 'inferred' ? 'step-note step-warning' : 'step-note';
        small.textContent = note;
        li.append(small);
      }
      list.append(li);
    }
    if (!start.value || !end.value) {
      status.textContent = '請選擇目前位置與目的地。';
    } else if (!route) {
      status.textContent = '這組路線在目前資料與條件下沒有連通。可更換地標或檢查路線條件。';
    } else {
      const levels = [network.nodes.get(start.value).level_id];
      for (const { to } of steps) if (to.level_id !== levels.at(-1)) levels.push(to.level_id);
      const inferred = steps.filter(step => step.edge.status === 'inferred').length;
      status.textContent = levels.join(' → ') + ' · ' + cursor + ' / ' + steps.length + ' 段'
        + (inferred ? ' · 含 ' + inferred + ' 段推定連線' : '');
    }
  }

  function plan() {
    cursor = 0;
    picking = null;
    route = findRoute(network, start.value, end.value, { strict: $('strict').checked, elevatorsOnly: $('lift').checked });
    updateGuide();
    updateMap();
  }

  for (const id of ['start', 'end', 'strict', 'lift']) $(id).addEventListener('change', plan);
  for (const id of ['start', 'end']) $('pick-' + id).addEventListener('click', () => {
    picking = picking === id ? null : id;
    updateMap();
    if (picking) $('map-title').scrollIntoView({ block: 'nearest' });
  });
  function advance(change) {
    if (!route || cursor + change < 0 || cursor + change > route.steps.length) return;
    const from = route.steps[cursor - 1]?.to || network.nodes.get(start.value);
    cursor += change;
    const to = route.steps[cursor - 1]?.to || network.nodes.get(start.value);
    if (floor === from.level_id) floor = to.level_id;
    updateGuide();
    updateMap();
  }
  for (const [id, change] of [['back', -1], ['next', 1]]) $(id).addEventListener('click', () => advance(change));
  $('view').addEventListener('click', () => {
    top = !top;
    scene.resetZoom();
    updateMap();
  });
  $('zoom-in').addEventListener('click', () => scene.zoom(1.25));
  $('zoom-out').addEventListener('click', () => scene.zoom(.8));
  plan();
}

init().catch(error => {
  $('status').textContent = '路網載入失敗。請用本機網頁伺服器開啟專案，再重新整理。';
  console.error(error);
});
