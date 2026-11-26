/**
 * Pure Canvas + DOM Concept Graph viewer for Graphify NetworkX node_link_data.
 * Zero external libraries; bounded force layout settles and pauses automatically.
 */

const PALETTE = [
  "#4f46e5", "#059669", "#d97706", "#dc2626",
  "#0284c7", "#7c3aed", "#db2777", "#0d9488",
  "#ea580c", "#65a30d", "#2563eb", "#9333ea",
];

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function basenameOf(filePath) {
  if (!filePath) return "";
  const parts = String(filePath).split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function endpointId(ep) {
  return typeof ep === "object" && ep !== null ? String(ep.id ?? "") : String(ep ?? "");
}

function matchNodeToTopic(node, topics) {
  if (!Array.isArray(topics) || !topics.length || !node) return null;
  const srcBase = basenameOf(node.source_file).toLowerCase();
  const hay = [
    node.id,
    node.label,
    node.community_name,
    srcBase,
  ].filter(Boolean).join(" ").toLowerCase();

  for (const topic of topics) {
    if (!topic || !topic.id) continue;
    const files = Array.isArray(topic.sourceFiles) ? topic.sourceFiles : [];
    if (srcBase && files.some((f) => basenameOf(f).toLowerCase() === srcBase)) {
      return topic;
    }
    const idToken = String(topic.id).toLowerCase();
    const codeToken = String(topic.code || "").toLowerCase();
    const reId = new RegExp(`(^|[^a-z0-9])${idToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
    if (reId.test(hay)) return topic;
    if (codeToken && hay.includes(codeToken)) return topic;
  }
  return null;
}

function getThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  return {
    bg: cs.getPropertyValue("--bg").trim() || (dark ? "#0b1120" : "#f8fafc"),
    text: cs.getPropertyValue("--text").trim() || (dark ? "#f1f5f9" : "#0f172a"),
    muted: cs.getPropertyValue("--text-muted").trim() || (dark ? "#94a3b8" : "#475569"),
    surface: cs.getPropertyValue("--surface").trim() || (dark ? "#111827" : "#ffffff"),
    border: cs.getPropertyValue("--border-strong").trim() || (dark ? "#37475e" : "#cbd5e1"),
    primary: cs.getPropertyValue("--primary").trim() || "#4f46e5",
    dark,
  };
}

export function mountGraphViewer(container, graphData, options = {}) {
  const rawNodes = Array.isArray(graphData?.nodes) ? graphData.nodes : [];
  const rawLinks = Array.isArray(graphData?.links)
    ? graphData.links
    : Array.isArray(graphData?.edges)
      ? graphData.edges
      : [];

  if (!rawNodes.length) {
    container.innerHTML = `<div class="card empty-state">No concept graph nodes loaded for this subject yet.</div>`;
    return { destroy() {}, selectNode() {} };
  }

  const subjectFiles = Array.isArray(options.subjectFiles) ? options.subjectFiles : [];
  const fileByName = new Map(subjectFiles.map((f) => [String(f.name).toLowerCase(), f]));
  const topics = Array.isArray(options.topics) ? options.topics : [];

  // Normalize nodes & degree calculation
  const nodeMap = new Map();
  const communityList = [];
  const communitySet = new Set();

  rawNodes.forEach((n, idx) => {
    const id = String(n.id ?? idx);
    const commKey = n.community !== undefined && n.community !== null ? String(n.community) : "unclustered";
    if (!communitySet.has(commKey)) {
      communitySet.add(commKey);
      communityList.push({
        key: commKey,
        label: n.community_name ? `${commKey}: ${n.community_name}` : `Community ${commKey}`,
        count: 0,
      });
    }
    nodeMap.set(id, {
      ...n,
      id,
      label: String(n.label || id),
      commKey,
      degree: 0,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      radius: 8,
      isGod: false,
      color: PALETTE[0],
    });
  });

  const edges = [];
  const adj = new Map();
  for (const id of nodeMap.keys()) adj.set(id, []);

  rawLinks.forEach((lnk) => {
    const s = endpointId(lnk.source);
    const t = endpointId(lnk.target);
    if (!nodeMap.has(s) || !nodeMap.has(t) || s === t) return;
    const edge = {
      source: s,
      target: t,
      relation: String(lnk.relation || "related"),
      confidence: String(lnk.confidence || "EXTRACTED").toUpperCase(),
      confidence_score: Number(lnk.confidence_score ?? 1),
      weight: Number(lnk.weight ?? 1),
    };
    edges.push(edge);
    nodeMap.get(s).degree += 1;
    nodeMap.get(t).degree += 1;
    adj.get(s).push({ neighborId: t, edge });
    adj.get(t).push({ neighborId: s, edge });
  });

  const nodes = Array.from(nodeMap.values());
  const commIndex = new Map(communityList.map((c, i) => [c.key, i]));
  nodes.forEach((node) => {
    const ci = commIndex.get(node.commKey) ?? 0;
    communityList[ci].count += 1;
    node.color = PALETTE[ci % PALETTE.length];
    node.radius = Math.min(24, 7 + Math.sqrt(node.degree) * 3.1);
  });

  // Identify top God Nodes (top 6 by degree when degree >= 2)
  const byDegree = [...nodes].sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));
  const godCount = Math.min(6, Math.max(1, Math.floor(nodes.length * 0.12)));
  byDegree.slice(0, godCount).forEach((n) => {
    if (n.degree >= 2 || nodes.length <= 10) n.isGod = true;
  });

  // Deterministic seeded initial positions grouped around community angles
  const totalComms = Math.max(1, communityList.length);
  const spreadRadius = Math.max(160, Math.sqrt(nodes.length) * 42);
  nodes.forEach((node) => {
    const rand = mulberry32(hashString(node.id));
    const ci = commIndex.get(node.commKey) ?? 0;
    const baseAngle = (ci / totalComms) * Math.PI * 2;
    const angle = baseAngle + (rand() - 0.5) * (Math.PI * 1.1 / totalComms + 0.6);
    const dist = (0.25 + rand() * 0.75) * spreadRadius;
    node.x = Math.cos(angle) * dist;
    node.y = Math.sin(angle) * dist;
  });

  // Build DOM
  const commOptionsHtml = communityList
    .sort((a, b) => b.count - a.count)
    .map((c) => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.label)} (${c.count})</option>`)
    .join("");

  container.innerHTML = `
    <div class="graph-shell">
      <div class="graph-stage">
        <div class="graph-toolbar">
          <input type="search" class="input" data-role="search" placeholder="Search node, concept, PDF…" style="max-width:220px">
          <select class="input-select" data-role="community" style="max-width:220px">
            <option value="">All Communities (${nodes.length})</option>
            ${commOptionsHtml}
          </select>
          <div style="margin-left:auto; display:flex; gap:6px;">
            <button type="button" class="btn btn-sm btn-outline" data-role="zoom-out" title="Zoom out">&minus;</button>
            <button type="button" class="btn btn-sm btn-outline" data-role="zoom-in" title="Zoom in">+</button>
            <button type="button" class="btn btn-sm btn-outline" data-role="reset">Reset View</button>
          </div>
        </div>
        <div class="graph-canvas-wrap">
          <canvas class="graph-canvas" data-role="canvas"></canvas>
          <div class="graph-legend">
            <span>&#9679; Ring = God Node</span>
            <span>&mdash; Extracted</span>
            <span>&#8943; Inferred</span>
          </div>
        </div>
      </div>
      <aside class="card graph-inspector" data-role="inspector"></aside>
    </div>
  `;

  const canvas = container.querySelector('[data-role="canvas"]');
  const wrap = canvas.parentElement;
  const searchEl = container.querySelector('[data-role="search"]');
  const commEl = container.querySelector('[data-role="community"]');
  const inspectorEl = container.querySelector('[data-role="inspector"]');
  const ctx = canvas.getContext("2d");

  let width = 640;
  let height = 480;
  let dpr = window.devicePixelRatio || 1;
  let scale = 1;
  let panX = 0;
  let panY = 0;

  let selectedId = options.initialSelectedId && nodeMap.has(options.initialSelectedId)
    ? options.initialSelectedId
    : (byDegree[0]?.id || null);
  let hoveredId = null;
  let communityFilter = "";
  let searchQuery = "";

  let dragMode = null; // "pan" | "node"
  let dragNode = null;
  let dragMoved = false;
  let lastPtrX = 0;
  let lastPtrY = 0;

  // Bounded simulation state
  let alpha = 1.0;
  let rafId = 0;
  let destroyed = false;

  function matchesFilter(node) {
    if (communityFilter && node.commKey !== communityFilter) return false;
    if (searchQuery) {
      const q = searchQuery;
      const hay = `${node.label} ${node.id} ${node.file_type || ""} ${basenameOf(node.source_file)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - width / 2 - panX) / scale,
      y: (sy - height / 2 - panY) / scale,
    };
  }

  function worldToScreen(wx, wy) {
    return {
      x: wx * scale + width / 2 + panX,
      y: wy * scale + height / 2 + panY,
    };
  }

  function findNodeAt(sx, sy) {
    const w = screenToWorld(sx, sy);
    let best = null;
    let bestDistSq = Infinity;
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const n = nodes[i];
      if (!matchesFilter(n)) continue;
      const hitR = n.radius + 5 / scale;
      const dx = w.x - n.x;
      const dy = w.y - n.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= hitR * hitR && d2 < bestDistSq) {
        best = n;
        bestDistSq = d2;
      }
    }
    return best;
  }

  function stepSimulation() {
    // ponytail: O(n^2) pairwise repulsion; fast up to ~600 nodes, swap for Barnes-Hut if >1000.
    const nCount = nodes.length;
    const repulsion = Math.min(2200, 650 + nCount * 14);
    const springLen = 78;
    const springK = 0.045;
    const gravity = 0.018;
    const damping = 0.82;
    const maxStep = 18;

    for (let i = 0; i < nCount; i += 1) {
      const a = nodes[i];
      for (let j = i + 1; j < nCount; j += 1) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 25) {
          dx = 1.5;
          dy = -1.5;
          d2 = 25;
        }
        const f = (repulsion * alpha) / d2;
        const invD = 1 / Math.sqrt(d2);
        const fx = dx * invD * f;
        const fy = dy * invD * f;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    for (let i = 0; i < edges.length; i += 1) {
      const e = edges[i];
      const a = nodeMap.get(e.source);
      const b = nodeMap.get(e.target);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const force = (dist - springLen) * springK * alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    let totalSpeed = 0;
    for (let i = 0; i < nCount; i += 1) {
      const n = nodes[i];
      if (dragMode === "node" && dragNode === n) {
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx = (n.vx - n.x * gravity * alpha) * damping;
      n.vy = (n.vy - n.y * gravity * alpha) * damping;
      const spd = Math.hypot(n.vx, n.vy);
      if (spd > maxStep) {
        n.vx = (n.vx / spd) * maxStep;
        n.vy = (n.vy / spd) * maxStep;
      }
      n.x += n.vx;
      n.y += n.vy;
      totalSpeed += Math.min(spd, maxStep);
    }

    alpha *= 0.985;
    return alpha > 0.018 && totalSpeed / Math.max(1, nCount) > 0.04;
  }

  function draw() {
    if (destroyed) return;
    const theme = getThemeColors();
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, width, height);

    ctx.translate(width / 2 + panX, height / 2 + panY);
    ctx.scale(scale, scale);

    const activeNeighbors = new Set();
    if (selectedId && adj.has(selectedId)) {
      activeNeighbors.add(selectedId);
      adj.get(selectedId).forEach((item) => activeNeighbors.add(item.neighborId));
    }

    // Draw edges
    for (let i = 0; i < edges.length; i += 1) {
      const e = edges[i];
      const a = nodeMap.get(e.source);
      const b = nodeMap.get(e.target);
      const aVis = matchesFilter(a);
      const bVis = matchesFilter(b);
      if (!aVis && !bVis) continue;

      const isIncident = selectedId && (e.source === selectedId || e.target === selectedId);
      let edgeAlpha = aVis && bVis ? 0.35 : 0.1;
      if (selectedId) edgeAlpha = isIncident ? 0.88 : 0.08;

      ctx.save();
      ctx.beginPath();
      if (e.confidence === "INFERRED") {
        ctx.setLineDash([5 / scale, 4 / scale]);
      } else if (e.confidence === "AMBIGUOUS") {
        ctx.setLineDash([2 / scale, 4 / scale]);
      } else {
        ctx.setLineDash([]);
      }
      ctx.lineWidth = (isIncident ? 2.1 : 1.1) / scale;
      ctx.strokeStyle = isIncident ? theme.primary : theme.border;
      ctx.globalAlpha = edgeAlpha;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }

    // Draw nodes
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i];
      const visible = matchesFilter(n);
      const isSelected = n.id === selectedId;
      const isHovered = n.id === hoveredId;
      const isNeighbor = activeNeighbors.has(n.id);

      let nodeAlpha = visible ? 1.0 : 0.12;
      if (visible && selectedId && !isSelected && !isNeighbor) {
        nodeAlpha = 0.25;
      }

      ctx.save();
      ctx.globalAlpha = nodeAlpha;

      // God node outer halo
      if (n.isGod || isSelected) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius + 4 / scale, 0, Math.PI * 2);
        ctx.strokeStyle = isSelected ? theme.text : n.color;
        ctx.lineWidth = (isSelected ? 2.5 : 1.6) / scale;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = n.color;
      ctx.fill();

      ctx.lineWidth = (isSelected || isHovered ? 2.2 : 1.2) / scale;
      ctx.strokeStyle = theme.surface;
      ctx.stroke();
      ctx.restore();
    }

    // Draw labels on top
    const fontSize = Math.max(10, Math.min(13, 11.5 / Math.sqrt(scale)));
    ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i];
      const visible = matchesFilter(n);
      if (!visible) continue;
      const isSelected = n.id === selectedId;
      const isHovered = n.id === hoveredId;
      const isNeighbor = selectedId && activeNeighbors.has(n.id);
      const showLabel = isSelected || isHovered || (n.isGod && !selectedId) || (scale > 1.45 && (isNeighbor || Boolean(searchQuery))) || (Boolean(searchQuery) && nodes.filter(matchesFilter).length <= 14);
      if (!showLabel) continue;

      const label = n.label.length > 34 ? `${n.label.slice(0, 32)}…` : n.label;
      const ly = n.y + n.radius + 4 / scale;
      ctx.save();
      ctx.lineWidth = 3 / scale;
      ctx.strokeStyle = theme.bg;
      ctx.strokeText(label, n.x, ly);
      ctx.fillStyle = isSelected || isHovered ? theme.text : theme.muted;
      ctx.fillText(label, n.x, ly);
      ctx.restore();
    }

    ctx.restore();
  }

  function renderInspector() {
    const node = selectedId ? nodeMap.get(selectedId) : null;
    if (!node) {
      inspectorEl.innerHTML = `<p class="muted">Click any node in the graph to inspect its connections and source material.</p>`;
      return;
    }

    const srcBase = basenameOf(node.source_file);
    const matchedFile = srcBase ? fileByName.get(srcBase.toLowerCase()) : null;
    const topicMatch = matchNodeToTopic(node, topics);
    const neighbors = (adj.get(node.id) || [])
      .map(({ neighborId, edge }) => ({ neighbor: nodeMap.get(neighborId), edge }))
      .filter((x) => x.neighbor)
      .sort((a, b) => b.neighbor.degree - a.neighbor.degree);

    const fileHtml = matchedFile
      ? `<a class="file-chip" href="${escapeHtml(matchedFile.url)}" target="_blank" rel="noopener">&#128196; ${escapeHtml(matchedFile.name)}</a>`
      : srcBase
        ? `<span class="pill">${escapeHtml(srcBase)}</span>`
        : `<span class="muted-xs">No source file</span>`;

    const commText = node.community_name
      ? `${node.commKey} (${node.community_name})`
      : `Community ${node.commKey}`;

    inspectorEl.innerHTML = `
      <div>
        <div class="chip-row" style="margin-bottom:6px;">
          <span class="pill pill-primary">${escapeHtml(node.file_type || "concept")}</span>
          <span class="pill">${escapeHtml(commText)}</span>
          ${node.isGod ? `<span class="pill pill-warning">God Node</span>` : ""}
        </div>
        <h3 style="margin:0; font-size:16px;">${escapeHtml(node.label)}</h3>
        <p class="muted-xs" style="margin-top:4px; word-break:break-all;">${escapeHtml(node.id)} &middot; Degree ${node.degree}</p>
      </div>
      <div>
        <div class="field-label">Source Material</div>
        ${fileHtml}
      </div>
      ${topicMatch && typeof options.onPracticeTopic === "function" ? `
        <div>
          <button type="button" class="btn btn-primary btn-sm" data-action="practice-topic" data-topic-id="${escapeHtml(topicMatch.id)}" style="width:100%;">
            Practice ${escapeHtml(topicMatch.code || topicMatch.title)} Quiz
          </button>
        </div>
      ` : ""}
      <div>
        <div class="field-label">Connected Concepts (${neighbors.length})</div>
        <div class="neighbor-list">
          ${neighbors.length ? neighbors.map(({ neighbor, edge }) => `
            <button type="button" class="neighbor-btn" data-jump-id="${escapeHtml(neighbor.id)}">
              <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(neighbor.label)}</span>
              <span class="pill">${escapeHtml(edge.relation.replace(/_/g, " "))}</span>
            </button>
          `).join("") : `<p class="muted-xs">Isolated node</p>`}
        </div>
      </div>
    `;
  }

  function tickLoop() {
    if (destroyed) return;
    const keepGoing = stepSimulation();
    draw();
    if (keepGoing) {
      rafId = requestAnimationFrame(tickLoop);
    } else {
      rafId = 0;
    }
  }

  function wakeSimulation(newAlpha = 0.3) {
    alpha = Math.max(alpha, newAlpha);
    if (!rafId && !destroyed) {
      rafId = requestAnimationFrame(tickLoop);
    }
  }

  function fitView() {
    if (!nodes.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    nodes.forEach((n) => {
      if (!matchesFilter(n)) return;
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    });
    if (!Number.isFinite(minX)) {
      scale = 1;
      panX = 0;
      panY = 0;
      draw();
      return;
    }
    const spanX = Math.max(120, maxX - minX + 100);
    const spanY = Math.max(120, maxY - minY + 100);
    scale = Math.max(0.25, Math.min(1.6, Math.min(width / spanX, height / spanY) * 0.9));
    panX = -((minX + maxX) / 2) * scale;
    panY = -((minY + maxY) / 2) * scale;
    draw();
  }

  function selectNode(nodeId, center = false) {
    if (!nodeMap.has(nodeId)) return;
    selectedId = nodeId;
    if (center) {
      const n = nodeMap.get(nodeId);
      panX = -n.x * scale;
      panY = -n.y * scale;
    }
    renderInspector();
    draw();
  }

  function resizeCanvas() {
    const rect = wrap.getBoundingClientRect();
    width = Math.max(300, Math.floor(rect.width));
    height = Math.max(420, Math.floor(rect.height));
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    draw();
  }

  // Event Handlers
  const onPointerDown = (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    lastPtrX = sx;
    lastPtrY = sy;
    dragMoved = false;

    const hit = findNodeAt(sx, sy);
    if (hit) {
      dragMode = "node";
      dragNode = hit;
    } else {
      dragMode = "pan";
      dragNode = null;
    }
    canvas.classList.add("dragging");
    canvas.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (dragMode === "node" && dragNode) {
      if (Math.hypot(sx - lastPtrX, sy - lastPtrY) > 2) dragMoved = true;
      const w = screenToWorld(sx, sy);
      dragNode.x = w.x;
      dragNode.y = w.y;
      lastPtrX = sx;
      lastPtrY = sy;
      wakeSimulation(0.18);
      draw();
      return;
    }

    if (dragMode === "pan") {
      const dx = sx - lastPtrX;
      const dy = sy - lastPtrY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved = true;
      panX += dx;
      panY += dy;
      lastPtrX = sx;
      lastPtrY = sy;
      draw();
      return;
    }

    const hit = findNodeAt(sx, sy);
    const nextHover = hit ? hit.id : null;
    if (nextHover !== hoveredId) {
      hoveredId = nextHover;
      canvas.style.cursor = hoveredId ? "pointer" : "grab";
      draw();
    }
  };

  const onPointerUp = (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (!dragMoved) {
      const hit = findNodeAt(sx, sy);
      if (hit) {
        selectNode(hit.id, false);
      }
    }
    dragMode = null;
    dragNode = null;
    canvas.classList.remove("dragging");
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  };

  const onWheel = (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const before = screenToWorld(sx, sy);
    const factor = e.deltaY < 0 ? 1.14 : 0.88;
    scale = Math.max(0.2, Math.min(4.0, scale * factor));
    const after = worldToScreen(before.x, before.y);
    panX += sx - after.x;
    panY += sy - after.y;
    draw();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  searchEl.addEventListener("input", () => {
    searchQuery = searchEl.value.trim().toLowerCase();
    draw();
  });

  searchEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const firstMatch = nodes.find((n) => matchesFilter(n));
      if (firstMatch) selectNode(firstMatch.id, true);
    }
  });

  commEl.addEventListener("change", () => {
    communityFilter = commEl.value;
    fitView();
  });

  container.querySelector('[data-role="zoom-in"]').addEventListener("click", () => {
    scale = Math.min(4.0, scale * 1.22);
    draw();
  });
  container.querySelector('[data-role="zoom-out"]').addEventListener("click", () => {
    scale = Math.max(0.2, scale / 1.22);
    draw();
  });
  container.querySelector('[data-role="reset"]').addEventListener("click", () => {
    searchEl.value = "";
    searchQuery = "";
    commEl.value = "";
    communityFilter = "";
    fitView();
  });

  inspectorEl.addEventListener("click", (e) => {
    const jumpBtn = e.target.closest("[data-jump-id]");
    if (jumpBtn) {
      selectNode(jumpBtn.dataset.jumpId, true);
      return;
    }
    const practiceBtn = e.target.closest("[data-action='practice-topic']");
    if (practiceBtn && typeof options.onPracticeTopic === "function") {
      options.onPracticeTopic(practiceBtn.dataset.topicId);
    }
  });

  const resizeObserver = new ResizeObserver(() => resizeCanvas());
  resizeObserver.observe(wrap);

  const themeObserver = new MutationObserver(() => draw());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // Initial sizing + settle initial simulation steps before first draw
  resizeCanvas();
  for (let i = 0; i < 60; i += 1) stepSimulation();
  fitView();
  renderInspector();
  wakeSimulation(0.85);

  return {
    selectNode: (id) => selectNode(id, true),
    destroy() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      themeObserver.disconnect();
    },
  };
}
