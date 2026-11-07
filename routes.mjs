const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export const modes = {
  walk: '沿通道步行', elevator: '搭電梯', stairs: '走樓梯',
  escalator: '搭手扶梯', fare_gate: '通過閘門',
};

export function buildNetwork(data) {
  const nodes = new Map(data.nodes.map(node => [node.id, node]));
  const levels = new Map(data.levels.map(level => [level.id, level]));
  const facilities = new Map(data.facilities.map(facility => [facility.id, facility]));
  const adjacency = new Map(data.nodes.map(node => [node.id, []]));
  const positions = new Map(data.nodes.map(node => [node.id, node.position?.uv]));
  for (const edge of data.edges) {
    const from = nodes.get(edge.from_node);
    const to = nodes.get(edge.to_node);
    // A G marker borrows its landing's XY for display only.
    if (from.level_id === 'G' && !positions.get(from.id)) positions.set(from.id, to.position?.uv);
    if (to.level_id === 'G' && !positions.get(to.id)) positions.set(to.id, from.position?.uv);
    if (!edge.routing_enabled) continue;
    const floors = Math.abs(levels.get(from.level_id).order - levels.get(to.level_id).order);
    const cost = [Number(edge.mode === 'fare_gate'), floors, 1];
    adjacency.get(from.id).push({ from, to, edge, cost });
    if (edge.direction === 'both') adjacency.get(to.id).push({ from: to, to: from, edge, cost });
  }
  return { nodes, levels, facilities, adjacency, positions };
}

export function findRoute(network, start, end, { strict = false, elevatorsOnly = false } = {}) {
  if (!network.nodes.has(start) || !network.nodes.has(end)) return null;
  const pending = new Set([start]);
  const costs = new Map([[start, [0, 0, 0]]]);
  const previous = new Map();
  while (pending.size) {
    const current = [...pending].sort((a, b) => compare(costs.get(a), costs.get(b)) || (a < b ? -1 : 1))[0];
    if (current === end) {
      const steps = [];
      for (let id = end; id !== start;) {
        const step = previous.get(id);
        steps.unshift(step);
        id = step.from.id;
      }
      return { steps, cost: costs.get(end) };
    }
    pending.delete(current);
    for (const step of network.adjacency.get(current)) {
      if (strict && step.edge.status === 'inferred') continue;
      if (elevatorsOnly && ['stairs', 'escalator'].includes(step.edge.mode)) continue;
      const cost = costs.get(current).map((value, index) => value + step.cost[index]);
      const prior = costs.get(step.to.id);
      if (prior && compare(cost, prior) >= 0) continue;
      pending.add(step.to.id);
      costs.set(step.to.id, cost);
      previous.set(step.to.id, step);
    }
  }
  return null;
}
