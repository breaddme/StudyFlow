import { mountGraphViewer } from "./graph.js";
import { generateWithGemini, generateOfflineFromNotes, getSavedApiKey, saveApiKey } from "./generator.js";

const VALID_TABS = new Set(["dashboard", "quiz", "exam", "study", "graph", "mistakes", "materials"]);
const LETTERS = ["A", "B", "C", "D"];

const state = {
  subjects: [],
  activeSubjectId: localStorage.getItem("studyflow.subject") || "",
  study: emptyStudySkeleton(""),
  graphCache: new Map(),
  progress: { subjects: {} },
  tab: "dashboard",
  studySubTab: "formulas",
  quiz: {
    filters: { topicId: "all", difficulty: "all", category: "all", count: "10", shuffle: true },
    session: null,
  },
  exam: {
    filters: { selectedTopics: null, count: 25, minutes: 45 },
    session: null,
  },
  formulas: { topicId: "all", search: "" },
  flashcards: { topicId: "all", mode: "all", index: 0, flipped: false, hintOpen: false },
  materials: { addTab: "topic", importMode: "merge" },
  generator: {
    mode: "ai",
    topicTitle: "",
    questionCount: 15,
    examStyle: "balanced",
    language: "auto",
    notesText: "",
    files: [],
    busy: false,
    preview: null,
    error: "",
    saveMode: "merge",
  },
  graphHandle: null,
};

function emptyStudySkeleton(id) {
  return {
    id: id || "",
    name: id || "",
    code: id ? id.toUpperCase() : "",
    description: "",
    topics: [],
    formulas: [],
    flashcards: [],
    questions: [],
  };
}

// --- Security & Math Helpers ---

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderKatexExpr(expr, displayMode) {
  if (window.katex && typeof window.katex.renderToString === "function") {
    try {
      return window.katex.renderToString(expr, {
        displayMode,
        throwOnError: false,
        strict: false,
      });
    } catch {
      // Fall back to escaped text below
    }
  }
  return displayMode
    ? `<div class="math-fallback"><code>${escapeHtml(expr)}</code></div>`
    : `<code class="math-fallback">${escapeHtml(expr)}</code>`;
}

function renderLatexBlock(rawLatex) {
  const clean = String(rawLatex ?? "")
    .trim()
    .replace(/^\$\$([\s\S]+)\$\$$/, "$1")
    .replace(/^\$([\s\S]+)\$$/, "$1")
    .trim();
  return clean ? renderKatexExpr(clean, true) : `<span class="muted-xs">—</span>`;
}

function formatPlainSegment(str) {
  let escaped = escapeHtml(str).replace(/\n/g, "<br>");
  // Render simple inline **bold** markdown without allowing raw HTML
  escaped = escaped.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  return escaped;
}

function renderMathText(raw) {
  const text = String(raw ?? "");
  if (!text) return "";

  let out = "";
  let buf = "";
  let i = 0;

  const flushPlain = () => {
    if (buf) {
      out += formatPlainSegment(buf);
      buf = "";
    }
  };

  while (i < text.length) {
    // Handle escaped dollar sign \$
    if (text[i] === "\\" && text[i + 1] === "$") {
      buf += "$";
      i += 2;
      continue;
    }

    // Display math $$...$$
    if (text[i] === "$" && text[i + 1] === "$") {
      const closeIdx = text.indexOf("$$", i + 2);
      if (closeIdx !== -1 && text[closeIdx - 1] !== "\\") {
        const inner = text.slice(i + 2, closeIdx).trim();
        if (inner.length > 0) {
          flushPlain();
          out += renderKatexExpr(inner, true);
          i = closeIdx + 2;
          continue;
        }
      }
    }

    // Inline math $...$
    if (text[i] === "$") {
      let closeIdx = -1;
      for (let j = i + 1; j < text.length; j += 1) {
        if (text[j] === "\n") break;
        if (text[j] === "$" && text[j - 1] !== "\\") {
          closeIdx = j;
          break;
        }
      }
      if (closeIdx > i + 1) {
        const inner = text.slice(i + 1, closeIdx);
        const trimmed = inner.trim();
        // Only treat as plain currency if it is strictly a price like "$50 and $100" (no LaTeX/math ops inside)
        const hasMathSignal = /[\\^_{}=+\-*/×÷<>±]|text\{/.test(trimmed);
        const isPlainPriceWithSentence = /^\d+(?:,\d{3})*(?:\.\d{1,2})?\s+[a-z]{2,}/i.test(trimmed) && !hasMathSignal;
        if (trimmed.length > 0 && !isPlainPriceWithSentence) {
          flushPlain();
          out += renderKatexExpr(trimmed, false);
          i = closeIdx + 1;
          continue;
        }
      }
    }

    buf += text[i];
    i += 1;
  }

  flushPlain();
  return out;
}

function formatBytes(bytes) {
  const b = Number(bytes || 0);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDuration(totalSec) {
  const sec = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function slugify(str) {
  return String(str || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 48);
}

// --- Toast & Theme ---

function showToast(message, kind = "info") {
  const region = document.getElementById("toastRegion");
  if (!region) return;
  const el = document.createElement("div");
  el.className = `toast ${kind === "error" ? "error" : kind === "success" ? "success" : ""}`;
  el.textContent = message;
  region.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

function applyTheme(theme) {
  const isDark = theme === "dark";
  if (isDark) {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  localStorage.setItem("studyflow.theme", isDark ? "dark" : "light");
  const icon = document.getElementById("themeIcon");
  const label = document.getElementById("themeLabel");
  if (icon) icon.innerHTML = isDark ? "&#9728;" : "&#9790;";
  if (label) label.textContent = isDark ? "Light" : "Dark";
}

// --- API Layer (with automatic GitHub Pages / static-host localStorage fallback) ---

const STATIC_KEYS = {
  subjects: "studyflow.static.subjects",
  progress: "studyflow.static.progress",
  studyPrefix: "studyflow.static.study.",
  graphPrefix: "studyflow.static.graph.",
};
let staticMode = false;

function readLsJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeLsJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function mergeByIdClient(existing, incoming) {
  const result = (existing || []).filter((x) => x && typeof x === "object");
  const idxMap = new Map();
  result.forEach((item, idx) => {
    if (typeof item.id === "string" && item.id) idxMap.set(item.id, idx);
  });
  for (const item of incoming || []) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.id === "string" && item.id && idxMap.has(item.id)) {
      result[idxMap.get(item.id)] = item;
    } else {
      if (typeof item.id === "string" && item.id) idxMap.set(item.id, result.length);
      result.push(item);
    }
  }
  return result;
}

async function fetchStaticSubjects() {
  const baseRes = await fetch("./subjects.json", { cache: "no-store" });
  const baseList = baseRes.ok ? ((await baseRes.json())?.subjects || []) : [];
  const customList = readLsJson(STATIC_KEYS.subjects, []);
  const byId = new Map();
  for (const s of [...baseList, ...customList]) {
    if (!s || !s.id) continue;
    const savedStudy = readLsJson(STATIC_KEYS.studyPrefix + s.id, null);
    const savedGraph = readLsJson(STATIC_KEYS.graphPrefix + s.id, null);
    const counts = { ...(s.counts || {}) };
    if (savedStudy) {
      counts.topics = (savedStudy.topics || []).length;
      counts.questions = (savedStudy.questions || []).length;
      counts.formulas = (savedStudy.formulas || []).length;
      counts.flashcards = (savedStudy.flashcards || []).length;
    }
    if (savedGraph && Array.isArray(savedGraph.nodes)) {
      counts.graphNodes = savedGraph.nodes.length;
    }
    byId.set(s.id, {
      ...s,
      name: savedStudy?.name || s.name,
      code: savedStudy?.code || s.code,
      description: savedStudy?.description ?? s.description ?? "",
      counts,
      files: Array.isArray(s.files) ? s.files : [],
    });
  }
  return { subjects: Array.from(byId.values()) };
}

async function staticApiDispatch(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const body = options.body ? JSON.parse(options.body) : null;
  const u = new URL(url, window.location.href);
  const path = u.pathname.replace(/^.*?(\/api\/)/, "/api/");

  if (path === "/api/subjects" && method === "GET") {
    return fetchStaticSubjects();
  }
  if (path === "/api/subjects" && method === "POST") {
    const name = String(body?.name || "").trim();
    if (!name) throw new Error("Subject 'name' is required.");
    const id = String(body?.id || slugify(name)).trim();
    if (!/^[a-z0-9_-]{1,48}$/.test(id) || ["app", "graphify-out", "api", "files"].includes(id) || id.startsWith(".") || id.startsWith("_")) {
      throw new Error("Invalid subject id; use 1-48 chars [a-z0-9_-].");
    }
    const current = (await fetchStaticSubjects()).subjects;
    if (current.some((s) => s.id === id)) throw new Error(`Subject '${id}' already exists.`);
    const createdStudy = {
      ...emptyStudySkeleton(id),
      name,
      code: String(body?.code ?? id.toUpperCase()).trim(),
      description: String(body?.description || "").trim(),
    };
    const customList = readLsJson(STATIC_KEYS.subjects, []);
    const summary = {
      id,
      name: createdStudy.name,
      code: createdStudy.code,
      description: createdStudy.description,
      counts: { topics: 0, questions: 0, formulas: 0, flashcards: 0, graphNodes: 0 },
      files: [],
    };
    writeLsJson(STATIC_KEYS.studyPrefix + id, createdStudy);
    writeLsJson(STATIC_KEYS.subjects, [...customList, summary]);
    return summary;
  }

  if (path === "/api/progress") {
    if (method === "GET") return readLsJson(STATIC_KEYS.progress, { subjects: {} });
    if (method === "PUT") {
      writeLsJson(STATIC_KEYS.progress, body || { subjects: {} });
      return { ok: true };
    }
  }

  const m = path.match(/^\/api\/subjects\/([^/]+)\/(study|graph|import)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const action = m[2];
    if (action === "study") {
      if (method === "GET") {
        const ls = readLsJson(STATIC_KEYS.studyPrefix + id, null);
        if (ls) return ls;
        const r = await fetch(`./${encodeURIComponent(id)}/study.json`, { cache: "no-store" });
        if (r.ok) return r.json();
        return emptyStudySkeleton(id);
      }
      if (method === "PUT") {
        writeLsJson(STATIC_KEYS.studyPrefix + id, body);
        return { ok: true, study: body };
      }
    }
    if (action === "import" && method === "POST") {
      const current = await staticApiDispatch(`/api/subjects/${encodeURIComponent(id)}/study`);
      const mode = body?.mode === "replace" ? "replace" : "merge";
      const data = body?.data || {};
      const incomingTopics = Array.isArray(data.topics) ? data.topics : data.topic ? [data.topic] : undefined;
      const updated = mode === "replace"
        ? { ...emptyStudySkeleton(id), name: data.name || current.name, code: data.code ?? current.code, description: data.description ?? current.description }
        : { ...current };
      if (incomingTopics) updated.topics = mode === "replace" ? mergeByIdClient([], incomingTopics) : mergeByIdClient(current.topics, incomingTopics);
      for (const k of ["formulas", "flashcards", "questions"]) {
        if (Array.isArray(data[k])) updated[k] = mode === "replace" ? mergeByIdClient([], data[k]) : mergeByIdClient(current[k], data[k]);
      }
      writeLsJson(STATIC_KEYS.studyPrefix + id, updated);
      return { ok: true, study: updated };
    }
    if (action === "graph") {
      if (method === "GET") {
        const ls = readLsJson(STATIC_KEYS.graphPrefix + id, null);
        if (ls) return ls;
        const r = await fetch(`./${encodeURIComponent(id)}/graph.json`, { cache: "no-store" });
        if (r.ok) return r.json();
        return { nodes: [], links: [] };
      }
      if (method === "PUT") {
        writeLsJson(STATIC_KEYS.graphPrefix + id, body);
        return { ok: true, counts: { nodes: (body?.nodes || []).length } };
      }
    }
  }
  throw new Error("Action requires running local server (python server.py).");
}

function apiUrl(absPath) {
  return absPath.startsWith("/") ? `.${absPath}` : absPath;
}

async function apiJson(url, options = {}) {
  if (staticMode) {
    return staticApiDispatch(url, options);
  }
  let res;
  try {
    res = await fetch(apiUrl(url), {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
  } catch {
    if (url === "/api/subjects" || url === "/api/progress") {
      staticMode = true;
      return staticApiDispatch(url, options);
    }
    throw new Error("Network error contacting backend.");
  }
  const ct = res.headers.get("content-type") || "";
  if (url === "/api/subjects" && (!res.ok || !ct.includes("application/json"))) {
    staticMode = true;
    return staticApiDispatch(url, options);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new Error(body?.error || `Request failed (${res.status})`);
  }
  return body;
}

function activeSubjectSummary() {
  return state.subjects.find((s) => s.id === state.activeSubjectId) || null;
}

function subjectFileMap() {
  const summary = activeSubjectSummary();
  const files = Array.isArray(summary?.files) ? summary.files : [];
  return new Map(files.map((f) => [String(f.name).toLowerCase(), f]));
}

function getTopicById(topicId) {
  return state.study.topics.find((t) => t.id === topicId) || null;
}

function getSubjectProgress(subjectId = state.activeSubjectId) {
  if (!subjectId) {
    return { questionStats: {}, mistakes: {}, flashcards: {}, examHistory: [] };
  }
  if (!state.progress.subjects || typeof state.progress.subjects !== "object") {
    state.progress.subjects = {};
  }
  if (!state.progress.subjects[subjectId]) {
    state.progress.subjects[subjectId] = {
      questionStats: {},
      mistakes: {},
      flashcards: {},
      examHistory: [],
    };
  }
  const sp = state.progress.subjects[subjectId];
  sp.questionStats ||= {};
  sp.mistakes ||= {};
  sp.flashcards ||= {};
  sp.examHistory ||= [];
  return sp;
}

async function persistProgress() {
  try {
    await apiJson("/api/progress", {
      method: "PUT",
      body: JSON.stringify(state.progress),
    });
  } catch (err) {
    showToast(`Failed to save progress: ${err.message}`, "error");
  }
}

function activeMistakeQuestions() {
  const sp = getSubjectProgress();
  return state.study.questions.filter((q) => Boolean(sp.mistakes[q.id]));
}

function recordQuestionAttempt(question, chosenIndex, { isDrill = false } = {}) {
  const sp = getSubjectProgress();
  const isCorrect = Number(chosenIndex) === Number(question.answerIndex);
  const prev = sp.questionStats[question.id] || { attempts: 0, correct: 0 };
  const now = new Date().toISOString();

  sp.questionStats[question.id] = {
    attempts: (prev.attempts || 0) + 1,
    correct: (prev.correct || 0) + (isCorrect ? 1 : 0),
    lastAnswer: Number(chosenIndex),
    lastCorrect: isCorrect,
    lastAt: now,
  };

  let graduated = false;
  if (!isCorrect) {
    const prevM = sp.mistakes[question.id];
    sp.mistakes[question.id] = {
      missCount: (prevM?.missCount || 0) + 1,
      streak: 0,
      lastMissedAt: now,
    };
  } else if (isDrill && sp.mistakes[question.id]) {
    const nextStreak = (sp.mistakes[question.id].streak || 0) + 1;
    if (nextStreak >= 2) {
      delete sp.mistakes[question.id];
      graduated = true;
    } else {
      sp.mistakes[question.id].streak = nextStreak;
    }
  }

  return { isCorrect, graduated };
}

function computeMasteryStats() {
  const questions = state.study.questions || [];
  const sp = getSubjectProgress();
  let masteredCount = 0;
  let totalAttempts = 0;
  let totalCorrect = 0;

  for (const q of questions) {
    const stat = sp.questionStats[q.id];
    if (stat) {
      totalAttempts += stat.attempts || 0;
      totalCorrect += stat.correct || 0;
      if (stat.lastCorrect) masteredCount += 1;
    }
  }

  const totalQ = questions.length;
  const masteryPct = totalQ > 0 ? Math.round((masteredCount / totalQ) * 100) : 0;
  const accuracyPct = totalAttempts > 0 ? Math.round((totalCorrect / totalAttempts) * 100) : 0;
  return { totalQ, masteredCount, masteryPct, totalAttempts, totalCorrect, accuracyPct };
}

function updateHeaderAndBadges() {
  const summary = activeSubjectSummary();
  const code = state.study.code || summary?.code || state.activeSubjectId.toUpperCase() || "—";
  const name = state.study.name || summary?.name || state.activeSubjectId || "No Subject";

  document.getElementById("topSubjectCode").textContent = code;
  document.getElementById("topSubjectName").textContent = name;

  const mini = document.getElementById("subjectMiniMeta");
  if (summary) {
    const c = summary.counts;
    mini.textContent = `${c.topics} topics · ${c.questions} Q · ${c.formulas} formulas · ${c.files ?? summary.files.length} files`;
  } else {
    mini.textContent = "Create or select a subject";
  }

  const stats = computeMasteryStats();
  const pill = document.getElementById("topMasteryPill");
  pill.innerHTML = `Mastery: <strong>${stats.masteryPct}%</strong> &middot; ${stats.masteredCount}/${stats.totalQ} Q`;

  const mistakeCount = activeMistakeQuestions().length;
  const badge = document.getElementById("mistakeBadge");
  badge.textContent = String(mistakeCount);
  badge.hidden = mistakeCount === 0;
}

// --- Data Loading ---

async function refreshSubjectsList() {
  const data = await apiJson("/api/subjects");
  state.subjects = Array.isArray(data?.subjects) ? data.subjects : [];
  renderSubjectSelect();
}

function renderSubjectSelect() {
  const select = document.getElementById("subjectSelect");
  if (!state.subjects.length) {
    select.innerHTML = `<option value="">No subjects found</option>`;
    return;
  }
  select.innerHTML = state.subjects
    .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.code ? `${s.code} — ${s.name}` : s.name)}</option>`)
    .join("");
  if (state.subjects.some((s) => s.id === state.activeSubjectId)) {
    select.value = state.activeSubjectId;
  }
}

async function selectSubject(subjectId) {
  clearExamTimer();
  state.exam.session = null;
  state.quiz.session = null;
  state.exam.filters.selectedTopics = null;
  state.activeSubjectId = subjectId;
  localStorage.setItem("studyflow.subject", subjectId);

  const select = document.getElementById("subjectSelect");
  if (select && select.value !== subjectId) select.value = subjectId;

  if (!subjectId) {
    state.study = emptyStudySkeleton("");
    updateHeaderAndBadges();
    renderCurrentView();
    return;
  }

  try {
    state.study = await apiJson(`/api/subjects/${encodeURIComponent(subjectId)}/study`);
  } catch (err) {
    state.study = emptyStudySkeleton(subjectId);
    showToast(`Could not load study data: ${err.message}`, "error");
  }
  state.flashcards.index = 0;
  state.flashcards.flipped = false;
  state.flashcards.hintOpen = false;
  updateHeaderAndBadges();
  populateDrawerTopicOptions();
  renderFormulaDrawerBody();
  renderCurrentView();
}

// --- Independent Formula Drawer ---

function populateDrawerTopicOptions() {
  const sel = document.getElementById("drawerTopicSelect");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = `<option value="all">All Topics (${state.study.formulas.length})</option>` +
    state.study.topics.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.code || t.id)} — ${escapeHtml(t.title)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

function renderFormulaDrawerBody() {
  const body = document.getElementById("drawerBody");
  if (!body) return;
  const query = (document.getElementById("drawerSearchInput")?.value || "").trim().toLowerCase();
  const topicFilter = document.getElementById("drawerTopicSelect")?.value || "all";

  const items = state.study.formulas.filter((f) => {
    if (topicFilter !== "all" && f.topicId !== topicFilter) return false;
    if (!query) return true;
    const hay = `${f.name} ${f.latex} ${f.variables} ${f.whenToUse} ${f.pitfall}`.toLowerCase();
    return hay.includes(query);
  });

  if (!items.length) {
    body.innerHTML = `<div class="empty-state">No formulas match your filter.</div>`;
    return;
  }

  body.innerHTML = items.map((f) => {
    const topic = getTopicById(f.topicId);
    return `
      <div class="card card-compact formula-card">
        <div class="question-meta">
          <span class="pill pill-primary">${escapeHtml(topic?.code || f.topicId || "Formula")}</span>
          <strong>${escapeHtml(f.name)}</strong>
        </div>
        <div class="formula-math">${renderLatexBlock(f.latex)}</div>
        ${f.variables ? `<p class="formula-detail"><strong>Variables:</strong> ${renderMathText(f.variables)}</p>` : ""}
        ${f.whenToUse ? `<p class="formula-detail"><strong>Use:</strong> ${renderMathText(f.whenToUse)}</p>` : ""}
      </div>
    `;
  }).join("");
}

function openFormulaDrawer() {
  populateDrawerTopicOptions();
  renderFormulaDrawerBody();
  document.getElementById("formulaDrawer").hidden = false;
  document.getElementById("drawerBackdrop").hidden = false;
}

function closeFormulaDrawer() {
  document.getElementById("formulaDrawer").hidden = true;
  document.getElementById("drawerBackdrop").hidden = true;
}

// --- Navigation & Shell ---

function setActiveTab(tab) {
  if (!VALID_TABS.has(tab)) return;
  if (state.tab === "graph" && tab !== "graph" && state.graphHandle) {
    state.graphHandle.destroy();
    state.graphHandle = null;
  }
  state.tab = tab;
  document.querySelectorAll(".nav-item").forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".mbn-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  closeMobileSidebar();
  renderCurrentView();
}

function closeMobileSidebar() {
  document.getElementById("sidebar")?.classList.remove("open");
  const bd = document.getElementById("sidebarBackdrop");
  if (bd) bd.hidden = true;
}

function renderSourceChip(filename, fileMap) {
  if (!filename) return "";
  const base = String(filename).split(/[\\/]/).pop();
  const match = base ? fileMap.get(base.toLowerCase()) : null;
  if (match) {
    return `<a class="file-chip" href="${escapeHtml(match.url)}" target="_blank" rel="noopener">&#128196; ${escapeHtml(match.name)}</a>`;
  }
  return `<span class="pill">${escapeHtml(base || filename)}</span>`;
}

function renderLinkedFormulasHtml(formulaIds) {
  if (!Array.isArray(formulaIds) || !formulaIds.length) return "";
  const found = formulaIds
    .map((fid) => state.study.formulas.find((f) => f.id === fid))
    .filter(Boolean);
  if (!found.length) return "";
  return `
    <details style="margin-top:10px;">
      <summary style="cursor:pointer; font-weight:600; font-size:13.5px;">Linked Formulas (${found.length})</summary>
      <div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">
        ${found.map((f) => `
          <div class="card card-compact formula-card">
            <strong>${escapeHtml(f.name)}</strong>
            <div class="formula-math">${renderLatexBlock(f.latex)}</div>
            ${f.variables ? `<p class="formula-detail"><strong>Variables:</strong> ${renderMathText(f.variables)}</p>` : ""}
            ${f.pitfall ? `<div class="formula-pitfall"><strong>Pitfall:</strong> ${renderMathText(f.pitfall)}</div>` : ""}
          </div>
        `).join("")}
      </div>
    </details>
  `;
}

// --- View 1: Dashboard ---

function renderDashboard(main) {
  if (!state.activeSubjectId) {
    main.innerHTML = `
      <div class="card empty-state">
        <h2>Welcome to StudyFlow</h2>
        <p>Create your first subject using <strong>+ New Subject</strong> in the sidebar to begin.</p>
      </div>
    `;
    return;
  }

  const stats = computeMasteryStats();
  const sp = getSubjectProgress();
  const mistakes = activeMistakeQuestions();
  const fcMastered = state.study.flashcards.filter((fc) => sp.flashcards[fc.id]?.rating === 3).length;
  const fileMap = subjectFileMap();

  const topics = state.study.topics || [];
  const topicCardsHtml = topics.length
    ? topics.map((t) => {
        const tQuestions = state.study.questions.filter((q) => q.topicId === t.id);
        const tFormulas = state.study.formulas.filter((f) => f.topicId === t.id);
        const tCards = state.study.flashcards.filter((fc) => fc.topicId === t.id);
        const tDone = tQuestions.filter((q) => sp.questionStats[q.id]?.lastCorrect).length;
        const accPct = tQuestions.length ? Math.round((tDone / tQuestions.length) * 100) : 0;
        const fillClass = accPct >= 80 ? "good" : accPct >= 45 ? "warn" : "";
        const kps = Array.isArray(t.keyPoints) ? t.keyPoints : [];
        const previewKps = kps.slice(0, 3);
        const extraKps = kps.slice(3);
        const srcFiles = Array.isArray(t.sourceFiles) ? t.sourceFiles : [];

        return `
          <article class="card topic-card">
            <div class="topic-card-head">
              <div>
                <span class="pill pill-primary">${escapeHtml(t.code || t.id)}</span>
                <h3 class="topic-title">${escapeHtml(t.title)}</h3>
              </div>
              <span class="pill ${accPct >= 80 ? "pill-success" : ""}">${accPct}% mastered</span>
            </div>
            <div class="progress-track" aria-label="Topic mastery ${accPct}%">
              <div class="progress-fill ${fillClass}" style="width:${accPct}%"></div>
            </div>
            ${t.summary ? `<p class="muted" style="margin:0; font-size:14px;">${renderMathText(t.summary)}</p>` : ""}
            ${previewKps.length ? `
              <ul class="keypoints-list">
                ${previewKps.map((kp) => `<li>${renderMathText(kp)}</li>`).join("")}
              </ul>
            ` : ""}
            ${extraKps.length ? `
              <details>
                <summary class="muted-xs" style="cursor:pointer; font-weight:600;">Show ${extraKps.length} more key points</summary>
                <ul class="keypoints-list" style="margin-top:6px;">
                  ${extraKps.map((kp) => `<li>${renderMathText(kp)}</li>`).join("")}
                </ul>
              </details>
            ` : ""}
            ${srcFiles.length ? `
              <div class="chip-row">
                ${srcFiles.map((fn) => renderSourceChip(fn, fileMap)).join("")}
              </div>
            ` : ""}
            <div style="margin-top:auto; padding-top:8px; border-top:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; gap:8px;">
              <span class="muted-xs">${tQuestions.length} Q &middot; ${tFormulas.length} Formulas &middot; ${tCards.length} Cards</span>
              <button type="button" class="btn btn-primary btn-sm" data-action="topic-quiz" data-topic-id="${escapeHtml(t.id)}">Start Quiz</button>
            </div>
          </article>
        `;
      }).join("")
    : `
      <div class="card empty-state" style="grid-column:1/-1;">
        <h3 style="margin-top:0;">No topics yet for ${escapeHtml(state.study.name)}</h3>
        <p>Upload source PDFs, import a Study Pack JSON, or add topics and questions manually in Materials &amp; Data.</p>
        <button type="button" class="btn btn-primary" data-action="go-materials">Open Materials &amp; Data</button>
      </div>
    `;

  const history = [...(sp.examHistory || [])].reverse().slice(0, 8);
  const historyHtml = history.length
    ? `<div class="table-list">
        ${history.map((h) => `
          <div class="list-row">
            <div>
              <strong>${escapeHtml(h.label || "Mock Exam")}</strong>
              <p class="muted-xs">${escapeHtml(new Date(h.date).toLocaleString())} &middot; ${formatDuration(h.durationSec || 0)}</p>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="pill ${h.percent >= 80 ? "pill-success" : h.percent >= 60 ? "pill-warning" : "pill-danger"}">
                ${h.correct}/${h.total} (${h.percent}%)
              </span>
            </div>
          </div>
        `).join("")}
      </div>`
    : `<p class="muted" style="margin:0;">No timed mock exams completed yet.</p>`;

  const ringRadius = 38;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringOffset = ringCircumference * (1 - stats.masteryPct / 100);
  const needsStarterBanner = state.study.questions.length === 0;

  main.innerHTML = `
    <section class="hero-banner" aria-label="Course study overview">
      <div>
        <span class="hero-eyebrow">${escapeHtml(state.study.code || state.activeSubjectId.toUpperCase())} &middot; Final Exam Studio</span>
        <h1 class="hero-title">${escapeHtml(state.study.name || state.activeSubjectId)}</h1>
        ${state.study.description ? `<p class="hero-desc">${escapeHtml(state.study.description)}</p>` : `<p class="hero-desc">Build quizzes, flashcards, and timed mock exams from your course materials.</p>`}
        <div class="hero-actions">
          <button type="button" class="btn btn-primary" data-action="go-exam" ${state.study.questions.length === 0 ? "disabled" : ""}>&#9201; Start Mock Exam</button>
          <button type="button" class="btn btn-outline" data-action="go-quiz" ${state.study.questions.length === 0 ? "disabled" : ""}>&#10003; Topic Quiz</button>
          <button type="button" class="btn btn-ghost" data-action="go-materials">&#10022; Auto-Generate Study Pack</button>
        </div>
      </div>

      <div class="mastery-ring-box">
        <div class="mastery-ring" aria-label="${stats.masteryPct}% mastered">
          <svg viewBox="0 0 96 96">
            <circle class="ring-track" cx="48" cy="48" r="${ringRadius}"></circle>
            <circle class="ring-fill ${stats.masteryPct >= 80 ? "good" : ""}" cx="48" cy="48" r="${ringRadius}"
              stroke-dasharray="${ringCircumference.toFixed(2)}"
              stroke-dashoffset="${ringOffset.toFixed(2)}"></circle>
          </svg>
          <div class="mastery-ring-label">
            <span class="mastery-ring-pct">${stats.masteryPct}%</span>
            <span class="mastery-ring-sub">Mastery</span>
          </div>
        </div>
        <div style="text-align:center;">
          <div style="font-weight:700; font-size:13px;">${stats.masteredCount}/${stats.totalQ} Q</div>
          <div class="muted-xs">${topics.length} topics &middot; ${state.study.formulas.length} formulas</div>
        </div>
      </div>
    </section>

    ${needsStarterBanner ? `
      <div class="card generator-card" style="margin-bottom:20px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
        <div>
          <strong style="font-size:16px;">New subject ready! Auto-generate your exam bank in seconds.</strong>
          <p class="muted-xs" style="margin-top:4px;">Drop PDFs/images with a free Gemini key or paste lecture notes for instant offline quiz &amp; mock exam generation.</p>
        </div>
        <button type="button" class="btn btn-primary" data-action="go-materials">Open Auto-Generator &rarr;</button>
      </div>
    ` : ""}

    <section class="stats-grid" aria-label="Study summary">
      <div class="card stat-card">
        <span class="stat-label">Overall Mastery</span>
        <span class="stat-value">${stats.masteryPct}%</span>
        <span class="stat-sub">${stats.masteredCount} of ${stats.totalQ} questions mastered</span>
      </div>
      <div class="card stat-card">
        <span class="stat-label">Attempt Accuracy</span>
        <span class="stat-value">${stats.accuracyPct}%</span>
        <span class="stat-sub">${stats.totalCorrect} / ${stats.totalAttempts} total attempts</span>
      </div>
      <div class="card stat-card">
        <span class="stat-label">Mistake Bank</span>
        <span class="stat-value">${mistakes.length}</span>
        <span class="stat-sub">${mistakes.length ? `<button type="button" class="btn btn-sm btn-ghost" data-action="start-drill" style="padding:0;">Start Mistake Drill &rarr;</button>` : "Zero pending mistakes"}</span>
      </div>
      <div class="card stat-card">
        <span class="stat-label">Flashcards Mastered</span>
        <span class="stat-value">${fcMastered} / ${state.study.flashcards.length}</span>
        <span class="stat-sub">${state.study.formulas.length} formulas in reference</span>
      </div>
    </section>

    <div class="section-head" style="margin-bottom:12px;">
      <h2 class="page-title" style="font-size:24px;">Topics Overview</h2>
    </div>
    <section class="topics-grid">${topicCardsHtml}</section>

    <section class="card">
      <h2 class="page-title" style="font-size:22px; margin-bottom:12px;">Recent Mock Exam History</h2>
      ${historyHtml}
    </section>
  `;

  main.querySelectorAll("[data-action='topic-quiz']").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.quiz.filters.topicId = btn.dataset.topicId;
      state.quiz.session = null;
      setActiveTab("quiz");
      startQuizSession("quiz");
    });
  });
  main.querySelector("[data-action='go-quiz']")?.addEventListener("click", () => setActiveTab("quiz"));
  main.querySelector("[data-action='go-exam']")?.addEventListener("click", () => setActiveTab("exam"));
  main.querySelector("[data-action='go-materials']")?.addEventListener("click", () => setActiveTab("materials"));
  main.querySelector("[data-action='start-drill']")?.addEventListener("click", () => {
    setActiveTab("quiz");
    startQuizSession("drill");
  });
}

// --- View 2: Topic Quiz (+ Mistake Drill) ---

function filteredQuizPool() {
  const f = state.quiz.filters;
  return state.study.questions.filter((q) => {
    if (f.topicId !== "all" && q.topicId !== f.topicId) return false;
    if (f.difficulty !== "all" && q.difficulty !== f.difficulty) return false;
    if (f.category !== "all" && q.category !== f.category) return false;
    return true;
  });
}

function startQuizSession(mode = "quiz", customQuestions = null) {
  let pool = customQuestions
    ? [...customQuestions]
    : mode === "drill"
      ? activeMistakeQuestions()
      : filteredQuizPool();

  if (!pool.length) {
    showToast(mode === "drill" ? "Mistake Bank is empty!" : "No questions match those filters.", "error");
    renderCurrentView();
    return;
  }

  if (state.quiz.filters.shuffle || mode === "drill") {
    pool = shuffleArray(pool);
  }
  if (mode === "quiz" && state.quiz.filters.count !== "all") {
    const n = parseInt(state.quiz.filters.count, 10);
    if (Number.isFinite(n) && n > 0) pool = pool.slice(0, n);
  }

  state.quiz.session = {
    mode,
    questions: pool,
    index: 0,
    answers: {},
    results: {},
    hintOpen: false,
    finished: false,
    graduatedIds: [],
  };
  renderCurrentView();
}

function renderQuiz(main) {
  const session = state.quiz.session;

  if (!session) {
    const f = state.quiz.filters;
    const poolCount = filteredQuizPool().length;
    const mistakeCount = activeMistakeQuestions().length;

    main.innerHTML = `
      <div class="section-head">
        <div>
          <h1 class="page-title">Topic Quiz</h1>
          <p class="page-subtitle">Instant feedback, step-by-step solutions, and automatic Mistake Bank tracking</p>
        </div>
        ${mistakeCount ? `<button type="button" id="launchDrillBtn" class="btn btn-warning">Drill Mistake Bank (${mistakeCount})</button>` : ""}
      </div>

      <div class="card" style="margin-bottom:18px;">
        <div class="filter-bar">
          <div>
            <label for="quizTopicSel" class="field-label">Topic</label>
            <select id="quizTopicSel" class="input-select">
              <option value="all">All Topics</option>
              ${state.study.topics.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.code || t.id)} — ${escapeHtml(t.title)}</option>`).join("")}
            </select>
          </div>
          <div>
            <label for="quizDiffSel" class="field-label">Difficulty</label>
            <select id="quizDiffSel" class="input-select">
              <option value="all">All Difficulties</option>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
          </div>
          <div>
            <label for="quizCatSel" class="field-label">Category</label>
            <select id="quizCatSel" class="input-select">
              <option value="all">All Categories</option>
              <option value="conceptual">Conceptual</option>
              <option value="calculation">Calculation</option>
            </select>
          </div>
          <div>
            <label for="quizCountSel" class="field-label">Questions</label>
            <select id="quizCountSel" class="input-select">
              <option value="5">5 Questions</option>
              <option value="10">10 Questions</option>
              <option value="15">15 Questions</option>
              <option value="20">20 Questions</option>
              <option value="all">All Matching</option>
            </select>
          </div>
        </div>
        <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; margin-top:16px; padding-top:14px; border-top:1px solid var(--border);">
          <label style="display:inline-flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="checkbox" id="quizShuffleChk" ${f.shuffle ? "checked" : ""}>
            <span>Shuffle question order</span>
          </label>
          <div style="display:flex; align-items:center; gap:12px;">
            <span class="muted-xs" id="quizMatchCount">${poolCount} matching questions</span>
            <button type="button" id="startQuizBtn" class="btn btn-primary" ${poolCount === 0 ? "disabled" : ""}>Start Quiz</button>
          </div>
        </div>
      </div>
    `;

    const topicSel = document.getElementById("quizTopicSel");
    const diffSel = document.getElementById("quizDiffSel");
    const catSel = document.getElementById("quizCatSel");
    const countSel = document.getElementById("quizCountSel");
    const shuffleChk = document.getElementById("quizShuffleChk");

    topicSel.value = f.topicId;
    diffSel.value = f.difficulty;
    catSel.value = f.category;
    countSel.value = f.count;

    const updateFilters = () => {
      f.topicId = topicSel.value;
      f.difficulty = diffSel.value;
      f.category = catSel.value;
      f.count = countSel.value;
      f.shuffle = shuffleChk.checked;
      const count = filteredQuizPool().length;
      document.getElementById("quizMatchCount").textContent = `${count} matching questions`;
      document.getElementById("startQuizBtn").disabled = count === 0;
    };

    [topicSel, diffSel, catSel, countSel, shuffleChk].forEach((el) => el.addEventListener("change", updateFilters));
    document.getElementById("startQuizBtn").addEventListener("click", () => startQuizSession("quiz"));
    document.getElementById("launchDrillBtn")?.addEventListener("click", () => startQuizSession("drill"));
    return;
  }

  if (session.finished) {
    const total = session.questions.length;
    const correct = session.questions.filter((q) => session.results[q.id]?.isCorrect).length;
    const pct = total ? Math.round((correct / total) * 100) : 0;
    const missed = session.questions.filter((q) => !session.results[q.id]?.isCorrect);

    main.innerHTML = `
      <div class="card" style="margin-bottom:18px;">
        <div class="section-head" style="margin-bottom:10px;">
          <div>
            <span class="pill pill-primary">${session.mode === "drill" ? "Mistake Drill Complete" : "Quiz Complete"}</span>
            <h1 class="page-title" style="margin-top:6px;">Score: ${correct} / ${total} (${pct}%)</h1>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button type="button" id="quizRetryBtn" class="btn btn-primary">Practice Again</button>
            <button type="button" id="quizBackBtn" class="btn btn-outline">Change Filters</button>
          </div>
        </div>
        ${session.graduatedIds.length ? `<p class="pill pill-success">Graduated ${session.graduatedIds.length} question(s) from Mistake Bank!</p>` : ""}
        ${missed.length ? `
          <div style="margin-top:16px;">
            <h3 style="margin:0 0 10px; font-size:16px;">Missed Questions (${missed.length} recorded in Mistake Bank)</h3>
            <div class="table-list">
              ${missed.map((q) => `
                <div class="list-row" style="align-items:flex-start; flex-direction:column;">
                  <strong>${renderMathText(q.prompt)}</strong>
                  <span class="muted-xs">Correct Answer: ${LETTERS[q.answerIndex]}. ${renderMathText(q.choices?.[q.answerIndex] || "")}</span>
                </div>
              `).join("")}
            </div>
          </div>
        ` : `<p class="muted" style="margin:8px 0 0;">Perfect score on this set!</p>`}
      </div>
    `;
    document.getElementById("quizRetryBtn").addEventListener("click", () => startQuizSession(session.mode));
    document.getElementById("quizBackBtn").addEventListener("click", () => {
      state.quiz.session = null;
      renderCurrentView();
    });
    return;
  }

  const q = session.questions[session.index];
  const topic = getTopicById(q.topicId);
  const chosen = session.answers[q.id];
  const graded = session.results[q.id];
  const isAnswered = chosen !== undefined;
  const fileMap = subjectFileMap();
  const sp = getSubjectProgress();
  const mistakeInfo = sp.mistakes[q.id];

  main.innerHTML = `
    <div class="section-head" style="margin-bottom:12px;">
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <span class="pill ${session.mode === "drill" ? "pill-warning" : "pill-primary"}">
          ${session.mode === "drill" ? "Mistake Drill" : "Topic Quiz"}
        </span>
        <strong>Question ${session.index + 1} of ${session.questions.length}</strong>
        ${session.mode === "drill" && mistakeInfo ? `<span class="pill">Streak ${mistakeInfo.streak || 0}/2 to graduate</span>` : ""}
      </div>
      <button type="button" id="endQuizBtn" class="btn btn-sm btn-outline">Exit Quiz</button>
    </div>

    <div class="progress-track" style="margin-bottom:16px;">
      <div class="progress-fill" style="width:${Math.round(((session.index + (isAnswered ? 1 : 0)) / session.questions.length) * 100)}%"></div>
    </div>

    <div class="card question-card">
      <div class="question-meta">
        <span class="pill pill-primary">${escapeHtml(topic?.code || q.topicId)}</span>
        ${q.difficulty ? `<span class="pill">${escapeHtml(q.difficulty)}</span>` : ""}
        ${q.category ? `<span class="pill">${escapeHtml(q.category)}</span>` : ""}
        ${q.sourceFile ? renderSourceChip(q.sourceFile, fileMap) : ""}
      </div>

      <div class="question-prompt">${renderMathText(q.prompt)}</div>

      ${q.hint ? `
        <div>
          <button type="button" id="toggleHintBtn" class="btn btn-sm btn-ghost">${session.hintOpen ? "Hide Hint" : "Show Hint"}</button>
          ${session.hintOpen ? `<div class="hint-box" style="margin-top:8px;"><strong>Hint:</strong> ${renderMathText(q.hint)}</div>` : ""}
        </div>
      ` : ""}

      <div class="choices-list">
        ${(q.choices || []).map((choice, idx) => {
          let cls = "choice-btn";
          if (isAnswered) {
            if (idx === Number(q.answerIndex)) cls += " correct";
            else if (idx === Number(chosen)) cls += " incorrect";
          }
          return `
            <button type="button" class="${cls}" data-choice-idx="${idx}" ${isAnswered ? "disabled" : ""}>
              <span class="choice-letter">${LETTERS[idx] || idx + 1}</span>
              <span class="choice-text">${renderMathText(choice)}</span>
            </button>
          `;
        }).join("")}
      </div>

      ${isAnswered ? `
        <div class="solution-box ${graded.isCorrect ? "is-correct" : "is-wrong"}">
          <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px;">
            <strong>${graded.isCorrect ? "Correct!" : `Incorrect — Correct answer is ${LETTERS[q.answerIndex]}`}</strong>
            ${graded.graduated ? `<span class="pill pill-success">Graduated from Mistake Bank!</span>` : !graded.isCorrect ? `<span class="pill pill-danger">Added to Mistake Bank</span>` : ""}
          </div>
          ${q.solution ? `<div>${renderMathText(q.solution)}</div>` : ""}
          ${renderLinkedFormulasHtml(q.formulaIds)}
        </div>
        <div style="display:flex; justify-content:flex-end;">
          <button type="button" id="nextQuizBtn" class="btn btn-primary">
            ${session.index + 1 < session.questions.length ? "Next Question &rarr;" : "Finish &amp; See Summary"}
          </button>
        </div>
      ` : ""}
    </div>
  `;

  document.getElementById("endQuizBtn").addEventListener("click", () => {
    state.quiz.session = null;
    renderCurrentView();
  });

  document.getElementById("toggleHintBtn")?.addEventListener("click", () => {
    session.hintOpen = !session.hintOpen;
    renderCurrentView();
  });

  main.querySelectorAll("[data-choice-idx]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (session.answers[q.id] !== undefined) return;
      const idx = parseInt(btn.dataset.choiceIdx, 10);
      session.answers[q.id] = idx;
      const outcome = recordQuestionAttempt(q, idx, { isDrill: session.mode === "drill" });
      session.results[q.id] = outcome;
      if (outcome.graduated) session.graduatedIds.push(q.id);
      updateHeaderAndBadges();
      renderCurrentView();
      await persistProgress();
    });
  });

  document.getElementById("nextQuizBtn")?.addEventListener("click", () => {
    if (session.index + 1 < session.questions.length) {
      session.index += 1;
      session.hintOpen = false;
    } else {
      session.finished = true;
    }
    renderCurrentView();
  });
}

// --- View 3: Timed Mock Exam ---

function clearExamTimer() {
  if (state.exam.session?.timerId) {
    clearInterval(state.exam.session.timerId);
    state.exam.session.timerId = null;
  }
}

function getExamSelectedTopics() {
  const allIds = state.study.topics.map((t) => t.id);
  if (!state.exam.filters.selectedTopics) {
    state.exam.filters.selectedTopics = new Set(allIds);
  }
  return state.exam.filters.selectedTopics;
}

function filteredExamPool() {
  const sel = getExamSelectedTopics();
  if (!state.study.topics.length) return [...state.study.questions];
  return state.study.questions.filter((q) => sel.has(q.topicId) || !q.topicId);
}

function startTimedExam(count, minutes, label) {
  clearExamTimer();
  const pool = shuffleArray(filteredExamPool());
  if (!pool.length) {
    showToast("Select at least one topic with questions to start an exam.", "error");
    return;
  }
  const actualCount = count === "all" ? pool.length : Math.min(pool.length, Math.max(1, Number(count)));
  const selectedQuestions = pool.slice(0, actualCount);
  const totalSec = Math.max(60, Math.round(Number(minutes) * 60));

  const session = {
    label: label || `${actualCount}Q / ${minutes}m`,
    totalSec,
    remainingSec: totalSec,
    timerId: null,
    questions: selectedQuestions,
    index: 0,
    answers: {},
    flagged: new Set(),
    submitted: false,
    result: null,
    reviewFilter: "all",
  };

  session.timerId = setInterval(() => {
    if (!state.exam.session || state.exam.session !== session || session.submitted) return;
    session.remainingSec = Math.max(0, session.remainingSec - 1);
    const timerEl = document.getElementById("examTimerDisplay");
    if (timerEl) {
      timerEl.textContent = formatDuration(session.remainingSec);
      timerEl.classList.toggle("warn", session.remainingSec <= 300 && session.remainingSec > 60);
      timerEl.classList.toggle("danger", session.remainingSec <= 60);
    }
    if (session.remainingSec <= 0) {
      showToast("Time is up! Exam auto-submitted.", "info");
      submitTimedExam(true);
    }
  }, 1000);

  state.exam.session = session;
  renderCurrentView();
}

async function submitTimedExam(autoSubmitted = false) {
  const session = state.exam.session;
  if (!session || session.submitted) return;
  clearExamTimer();
  session.submitted = true;

  let correct = 0;
  const topicBreakdown = {};
  const missedQuestions = [];

  for (const q of session.questions) {
    const tId = q.topicId || "general";
    topicBreakdown[tId] ||= { correct: 0, total: 0 };
    topicBreakdown[tId].total += 1;

    const chosen = session.answers[q.id];
    const isCorrect = chosen !== undefined && Number(chosen) === Number(q.answerIndex);
    if (isCorrect) {
      correct += 1;
      topicBreakdown[tId].correct += 1;
    } else {
      missedQuestions.push(q);
    }

    if (chosen !== undefined) {
      recordQuestionAttempt(q, chosen, { isDrill: false });
    } else {
      // Unanswered in exam counts as missed in Mistake Bank
      const sp = getSubjectProgress();
      const prevM = sp.mistakes[q.id];
      sp.mistakes[q.id] = {
        missCount: (prevM?.missCount || 0) + 1,
        streak: 0,
        lastMissedAt: new Date().toISOString(),
      };
    }
  }

  const total = session.questions.length;
  const percent = total ? Math.round((correct / total) * 100) : 0;
  const durationSec = Math.max(1, session.totalSec - session.remainingSec);

  const sp = getSubjectProgress();
  sp.examHistory.push({
    id: `exam-${Date.now()}`,
    date: new Date().toISOString(),
    label: session.label,
    total,
    correct,
    percent,
    durationSec,
    autoSubmitted,
    topicBreakdown,
  });

  session.result = {
    correct,
    total,
    percent,
    durationSec,
    topicBreakdown,
    missedCount: missedQuestions.length,
    syncedToMistakes: true,
  };

  updateHeaderAndBadges();
  renderCurrentView();
  await persistProgress();
}

function renderExam(main) {
  const session = state.exam.session;

  if (!session) {
    const selected = getExamSelectedTopics();
    const poolSize = filteredExamPool().length;
    const fullCount = Math.min(60, Math.max(1, poolSize));

    main.innerHTML = `
      <div class="section-head">
        <div>
          <h1 class="page-title">Timed Mock Exam</h1>
          <p class="page-subtitle">Simulate exam pressure with a live countdown, question palette, and slide-over formula reference</p>
        </div>
      </div>

      <div class="card" style="margin-bottom:18px;">
        <h2 style="margin:0 0 12px; font-size:16px;">Quick Presets</h2>
        <div style="display:flex; flex-wrap:wrap; gap:10px; margin-bottom:20px;">
          <button type="button" class="btn btn-outline" data-preset="15,20,Quick 15Q / 20m" ${poolSize === 0 ? "disabled" : ""}>Quick 15Q / 20m</button>
          <button type="button" class="btn btn-outline" data-preset="25,45,Standard 25Q / 45m" ${poolSize === 0 ? "disabled" : ""}>Standard 25Q / 45m</button>
          <button type="button" class="btn btn-primary" data-preset="${fullCount},90,Full Final (${poolSize < 60 ? `All ${poolSize}Q` : "60Q"} / 90m)" ${poolSize === 0 ? "disabled" : ""}>
            Full Final (${poolSize < 60 ? `All ${poolSize}Q` : "60Q"} / 90m)
          </button>
        </div>

        <h3 style="margin:0 0 10px; font-size:15px;">Topic Coverage &amp; Custom Setup</h3>
        ${state.study.topics.length ? `
          <div class="chip-row" style="margin-bottom:14px;">
            ${state.study.topics.map((t) => `
              <label class="file-chip" style="cursor:pointer;">
                <input type="checkbox" class="exam-topic-chk" value="${escapeHtml(t.id)}" ${selected.has(t.id) ? "checked" : ""}>
                <span>${escapeHtml(t.code || t.id)} · ${escapeHtml(t.title)}</span>
              </label>
            `).join("")}
          </div>
        ` : ""}

        <div class="filter-bar">
          <div>
            <label for="examCustomCount" class="field-label">Question Count (Available: <span id="examAvailCount">${poolSize}</span>)</label>
            <input id="examCustomCount" type="number" min="1" max="${Math.max(1, poolSize)}" value="${Math.min(state.study.questions.length || 25, state.exam.filters.count)}" class="input">
          </div>
          <div>
            <label for="examCustomMins" class="field-label">Duration (minutes)</label>
            <input id="examCustomMins" type="number" min="1" max="240" value="${state.exam.filters.minutes}" class="input">
          </div>
          <div>
            <button type="button" id="startCustomExamBtn" class="btn btn-primary" ${poolSize === 0 ? "disabled" : ""} style="width:100%;">Start Custom Exam</button>
          </div>
        </div>
      </div>
    `;

    main.querySelectorAll(".exam-topic-chk").forEach((chk) => {
      chk.addEventListener("change", () => {
        if (chk.checked) selected.add(chk.value);
        else selected.delete(chk.value);
        const avail = filteredExamPool().length;
        document.getElementById("examAvailCount").textContent = String(avail);
        main.querySelectorAll("[data-preset], #startCustomExamBtn").forEach((b) => {
          b.disabled = avail === 0;
        });
      });
    });

    main.querySelectorAll("[data-preset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const [cnt, mins, ...rest] = btn.dataset.preset.split(",");
        startTimedExam(Number(cnt), Number(mins), rest.join(","));
      });
    });

    document.getElementById("startCustomExamBtn").addEventListener("click", () => {
      const cnt = Math.max(1, parseInt(document.getElementById("examCustomCount").value, 10) || 15);
      const mins = Math.max(1, parseInt(document.getElementById("examCustomMins").value, 10) || 20);
      state.exam.filters.count = cnt;
      state.exam.filters.minutes = mins;
      startTimedExam(cnt, mins, `Custom ${Math.min(cnt, filteredExamPool().length)}Q / ${mins}m`);
    });
    return;
  }

  // Graded Exam Summary View
  if (session.submitted && session.result) {
    const r = session.result;
    const reviewItems = session.questions
      .map((q, idx) => ({ q, idx, chosen: session.answers[q.id], correct: Number(session.answers[q.id]) === Number(q.answerIndex) }))
      .filter((item) => session.reviewFilter === "all" || !item.correct);

    main.innerHTML = `
      <div class="card" style="margin-bottom:18px;">
        <div class="section-head">
          <div>
            <span class="pill pill-primary">${escapeHtml(session.label)}</span>
            <h1 class="page-title" style="margin-top:6px;">Final Score: ${r.correct} / ${r.total} (${r.percent}%)</h1>
            <p class="page-subtitle">Time taken: ${formatDuration(r.durationSec)}</p>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            ${r.missedCount ? `<button type="button" id="syncMistakesBtn" class="btn btn-warning">${r.syncedToMistakes ? `Synced ${r.missedCount} Missed to Mistake Bank ✓` : `Add ${r.missedCount} Missed to Mistake Bank`}</button>` : ""}
            <button type="button" id="newExamBtn" class="btn btn-primary">New Mock Exam</button>
          </div>
        </div>

        <h3 style="margin:8px 0 12px; font-size:16px;">Topic Breakdown</h3>
        <div style="display:flex; flex-direction:column; gap:10px;">
          ${Object.entries(r.topicBreakdown).map(([tId, info]) => {
            const t = getTopicById(tId);
            const pct = info.total ? Math.round((info.correct / info.total) * 100) : 0;
            const cls = pct >= 80 ? "good" : pct >= 50 ? "warn" : "";
            return `
              <div>
                <div style="display:flex; justify-content:space-between; font-size:13.5px; margin-bottom:4px;">
                  <strong>${escapeHtml(t ? `${t.code} — ${t.title}` : tId)}</strong>
                  <span>${info.correct}/${info.total} (${pct}%)</span>
                </div>
                <div class="progress-track"><div class="progress-fill ${cls}" style="width:${pct}%"></div></div>
              </div>
            `;
          }).join("")}
        </div>
      </div>

      <div class="section-head" style="margin-bottom:12px;">
        <h2 style="margin:0; font-size:18px;">Full Answer Review</h2>
        <div class="subtabs">
          <button type="button" class="subtab-btn ${session.reviewFilter === "all" ? "active" : ""}" data-rev-filter="all">All (${session.questions.length})</button>
          <button type="button" class="subtab-btn ${session.reviewFilter === "missed" ? "active" : ""}" data-rev-filter="missed">Missed (${r.missedCount})</button>
        </div>
      </div>

      <div style="display:flex; flex-direction:column; gap:14px;">
        ${reviewItems.length ? reviewItems.map(({ q, idx, chosen, correct }) => {
          const t = getTopicById(q.topicId);
          return `
            <div class="card question-card">
              <div class="question-meta">
                <strong>Q${idx + 1}</strong>
                <span class="pill pill-primary">${escapeHtml(t?.code || q.topicId)}</span>
                <span class="pill ${correct ? "pill-success" : "pill-danger"}">${correct ? "Correct" : chosen === undefined ? "Unanswered" : "Incorrect"}</span>
              </div>
              <div class="question-prompt">${renderMathText(q.prompt)}</div>
              <div class="choices-list">
                ${(q.choices || []).map((c, ci) => {
                  let cls = "choice-btn";
                  if (ci === Number(q.answerIndex)) cls += " correct";
                  else if (ci === Number(chosen)) cls += " incorrect";
                  return `
                    <div class="${cls}" style="cursor:default;">
                      <span class="choice-letter">${LETTERS[ci]}</span>
                      <span class="choice-text">${renderMathText(c)}</span>
                    </div>
                  `;
                }).join("")}
              </div>
              <div class="solution-box ${correct ? "is-correct" : "is-wrong"}">
                ${q.solution ? renderMathText(q.solution) : `<span class="muted-xs">No solution text provided.</span>`}
                ${renderLinkedFormulasHtml(q.formulaIds)}
              </div>
            </div>
          `;
        }).join("") : `<div class="card empty-state">Zero missed questions!</div>`}
      </div>
    `;

    main.querySelectorAll("[data-rev-filter]").forEach((b) => {
      b.addEventListener("click", () => {
        session.reviewFilter = b.dataset.revFilter;
        renderCurrentView();
      });
    });
    document.getElementById("syncMistakesBtn")?.addEventListener("click", () => {
      setActiveTab("mistakes");
    });
    document.getElementById("newExamBtn").addEventListener("click", () => {
      state.exam.session = null;
      renderCurrentView();
    });
    return;
  }

  // Active Exam View
  const q = session.questions[session.index];
  const topic = getTopicById(q.topicId);
  const chosen = session.answers[q.id];
  const answeredCount = Object.keys(session.answers).length;
  const isFlagged = session.flagged.has(q.id);

  main.innerHTML = `
    <div class="exam-bar">
      <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
        <span id="examTimerDisplay" class="exam-timer ${session.remainingSec <= 60 ? "danger" : session.remainingSec <= 300 ? "warn" : ""}">${formatDuration(session.remainingSec)}</span>
        <div>
          <strong style="font-size:14px;">${escapeHtml(session.label)}</strong>
          <div class="muted-xs">Answered ${answeredCount} of ${session.questions.length}</div>
        </div>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button type="button" id="openDrawerBtn" class="btn btn-outline btn-sm">Formula Sheet</button>
        <button type="button" id="toggleFlagBtn" class="btn btn-sm ${isFlagged ? "btn-warning" : "btn-outline"}">
          ${isFlagged ? "&#9873; Flagged" : "&#9872; Flag"}
        </button>
        <button type="button" id="submitExamBtn" class="btn btn-primary btn-sm">Submit Exam</button>
      </div>
    </div>

    <div class="exam-layout">
      <div class="card question-card">
        <div class="question-meta">
          <strong>Question ${session.index + 1} of ${session.questions.length}</strong>
          <span class="pill pill-primary">${escapeHtml(topic?.code || q.topicId)}</span>
          ${q.difficulty ? `<span class="pill">${escapeHtml(q.difficulty)}</span>` : ""}
          ${isFlagged ? `<span class="pill pill-warning">Flagged for review</span>` : ""}
        </div>

        <div class="question-prompt">${renderMathText(q.prompt)}</div>

        <div class="choices-list">
          ${(q.choices || []).map((choice, idx) => `
            <button type="button" class="choice-btn ${chosen === idx ? "selected" : ""}" data-exam-choice="${idx}">
              <span class="choice-letter">${LETTERS[idx] || idx + 1}</span>
              <span class="choice-text">${renderMathText(choice)}</span>
            </button>
          `).join("")}
        </div>

        <div style="display:flex; justify-content:space-between; gap:10px; padding-top:8px; border-top:1px solid var(--border);">
          <button type="button" id="examPrevBtn" class="btn btn-outline" ${session.index === 0 ? "disabled" : ""}>&larr; Previous</button>
          <button type="button" id="examNextBtn" class="btn btn-primary">
            ${session.index + 1 < session.questions.length ? "Next &rarr;" : "Review / Submit"}
          </button>
        </div>
      </div>

      <aside class="card card-compact">
        <strong style="font-size:14px;">Question Palette</strong>
        <div class="palette-grid">
          ${session.questions.map((pq, i) => {
            const cls = [
              "palette-btn",
              i === session.index ? "current" : "",
              session.answers[pq.id] !== undefined ? "answered" : "",
              session.flagged.has(pq.id) ? "flagged" : "",
            ].filter(Boolean).join(" ");
            return `<button type="button" class="${cls}" data-palette-idx="${i}">${i + 1}</button>`;
          }).join("")}
        </div>
        <div class="muted-xs" style="margin-top:12px; display:flex; flex-direction:column; gap:3px;">
          <span>Purple = Answered</span>
          <span>Orange dot = Flagged</span>
        </div>
      </aside>
    </div>
  `;

  document.getElementById("openDrawerBtn").addEventListener("click", openFormulaDrawer);
  document.getElementById("toggleFlagBtn").addEventListener("click", () => {
    if (session.flagged.has(q.id)) session.flagged.delete(q.id);
    else session.flagged.add(q.id);
    renderCurrentView();
  });
  document.getElementById("submitExamBtn").addEventListener("click", () => {
    const unanswered = session.questions.length - Object.keys(session.answers).length;
    if (unanswered > 0 && !confirm(`You have ${unanswered} unanswered question(s). Submit exam now?`)) {
      return;
    }
    submitTimedExam(false);
  });

  main.querySelectorAll("[data-exam-choice]").forEach((btn) => {
    btn.addEventListener("click", () => {
      session.answers[q.id] = parseInt(btn.dataset.examChoice, 10);
      renderCurrentView();
    });
  });

  document.getElementById("examPrevBtn").addEventListener("click", () => {
    if (session.index > 0) {
      session.index -= 1;
      renderCurrentView();
    }
  });
  document.getElementById("examNextBtn").addEventListener("click", () => {
    if (session.index + 1 < session.questions.length) {
      session.index += 1;
      renderCurrentView();
    } else {
      document.getElementById("submitExamBtn").click();
    }
  });
  main.querySelectorAll("[data-palette-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      session.index = parseInt(btn.dataset.paletteIdx, 10);
      renderCurrentView();
    });
  });
}

// --- View 4: Formulas & Flashcards ---

function filteredFormulas() {
  const q = state.formulas.search.trim().toLowerCase();
  const topicId = state.formulas.topicId;
  return state.study.formulas.filter((f) => {
    if (topicId !== "all" && f.topicId !== topicId) return false;
    if (!q) return true;
    const hay = `${f.name} ${f.latex} ${f.variables} ${f.whenToUse} ${f.pitfall}`.toLowerCase();
    return hay.includes(q);
  });
}

function filteredFlashcards() {
  const sp = getSubjectProgress();
  return state.study.flashcards.filter((fc) => {
    if (state.flashcards.topicId !== "all" && fc.topicId !== state.flashcards.topicId) return false;
    if (state.flashcards.mode === "review") {
      return sp.flashcards[fc.id]?.rating !== 3;
    }
    return true;
  });
}

function renderStudyView(main) {
  const sub = state.studySubTab;
  const headerHtml = `
    <div class="section-head no-print">
      <div>
        <h1 class="page-title">Formulas &amp; Flashcards</h1>
        <p class="page-subtitle">Printable formula crib sheet and active-recall 3D flashcards</p>
      </div>
      <div class="subtabs">
        <button type="button" class="subtab-btn ${sub === "formulas" ? "active" : ""}" data-subtab="formulas">Formula Sheet (${state.study.formulas.length})</button>
        <button type="button" class="subtab-btn ${sub === "flashcards" ? "active" : ""}" data-subtab="flashcards">Flashcards (${state.study.flashcards.length})</button>
      </div>
    </div>
  `;

  if (sub === "formulas") {
    const items = filteredFormulas();
    main.innerHTML = `
      ${headerHtml}
      <div class="card card-compact no-print" style="margin-bottom:16px;">
        <div class="filter-bar">
          <div>
            <label for="formulaSearch" class="field-label">Search</label>
            <input id="formulaSearch" class="input" type="search" value="${escapeHtml(state.formulas.search)}" placeholder="Name, variable, pitfall…">
          </div>
          <div>
            <label for="formulaTopicSel" class="field-label">Topic</label>
            <select id="formulaTopicSel" class="input-select">
              <option value="all">All Topics</option>
              ${state.study.topics.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.code || t.id)} — ${escapeHtml(t.title)}</option>`).join("")}
            </select>
          </div>
          <div style="display:flex; justify-content:flex-end;">
            <button type="button" id="printFormulasBtn" class="btn btn-outline">Print Formula Sheet</button>
          </div>
        </div>
      </div>

      <div id="formulaGridMount" class="formula-grid">
        ${renderFormulaCardsHtml(items)}
      </div>
    `;

    document.getElementById("formulaTopicSel").value = state.formulas.topicId;
    document.getElementById("formulaSearch").addEventListener("input", (e) => {
      state.formulas.search = e.target.value;
      document.getElementById("formulaGridMount").innerHTML = renderFormulaCardsHtml(filteredFormulas());
    });
    document.getElementById("formulaTopicSel").addEventListener("change", (e) => {
      state.formulas.topicId = e.target.value;
      document.getElementById("formulaGridMount").innerHTML = renderFormulaCardsHtml(filteredFormulas());
    });
    document.getElementById("printFormulasBtn").addEventListener("click", () => window.print());
  } else {
    const deck = filteredFlashcards();
    if (state.flashcards.index >= deck.length) state.flashcards.index = 0;
    const fc = deck[state.flashcards.index] || null;
    const sp = getSubjectProgress();
    const rating = fc ? sp.flashcards[fc.id]?.rating : null;
    const ratingLabels = { 1: ["Again / Hard", "pill-danger"], 2: ["Good", "pill-warning"], 3: ["Mastered", "pill-success"] };
    const topic = fc ? getTopicById(fc.topicId) : null;

    main.innerHTML = `
      ${headerHtml}
      <div class="card card-compact" style="margin-bottom:18px;">
        <div class="filter-bar">
          <div>
            <label for="fcTopicSel" class="field-label">Topic</label>
            <select id="fcTopicSel" class="input-select">
              <option value="all">All Topics</option>
              ${state.study.topics.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.code || t.id)} — ${escapeHtml(t.title)}</option>`).join("")}
            </select>
          </div>
          <div>
            <label for="fcModeSel" class="field-label">Deck Mode</label>
            <select id="fcModeSel" class="input-select">
              <option value="all">All Cards</option>
              <option value="review">Need Review (Not Mastered)</option>
            </select>
          </div>
          <div style="display:flex; justify-content:flex-end; align-items:end;">
            <span class="muted-xs">${deck.length} cards in deck · Space flip · 1/2/3 rate · &larr;/&rarr; nav</span>
          </div>
        </div>
      </div>

      ${fc ? `
        <div class="flashcard-wrap">
          <div class="flashcard-scene">
            <div id="flashcardCard" class="flashcard-card ${state.flashcards.flipped ? "is-flipped" : ""}" tabindex="0" role="button" aria-label="Flashcard, press Space or click to flip">
              <div class="flashcard-face flashcard-front">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                  <span class="pill pill-primary">${escapeHtml(topic?.code || fc.topicId)}</span>
                  ${rating && ratingLabels[rating] ? `<span class="pill ${ratingLabels[rating][1]}">${ratingLabels[rating][0]}</span>` : `<span class="pill">Unrated</span>`}
                </div>
                <div class="flashcard-body">${renderMathText(fc.front)}</div>
                <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                  ${fc.hint ? `<button type="button" id="fcHintBtn" class="btn btn-sm btn-ghost">${state.flashcards.hintOpen ? "Hide Hint" : "Show Hint"}</button>` : `<span></span>`}
                  <span class="muted-xs">Click or press Space to flip</span>
                </div>
                ${state.flashcards.hintOpen && fc.hint ? `<div class="hint-box" style="margin-top:8px;">${renderMathText(fc.hint)}</div>` : ""}
              </div>

              <div class="flashcard-face flashcard-back">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <span class="pill pill-primary">${escapeHtml(topic?.code || fc.topicId)} &middot; Answer</span>
                  <span class="muted-xs">Press Space to flip back</span>
                </div>
                <div class="flashcard-body">${renderMathText(fc.back)}</div>
                <div class="muted-xs" style="text-align:center;">Rate confidence below (1, 2, or 3)</div>
              </div>
            </div>
          </div>

          <div class="flashcard-controls">
            <div style="display:flex; align-items:center; gap:8px;">
              <button type="button" id="fcPrevBtn" class="btn btn-outline btn-sm">&larr; Prev</button>
              <span class="pill">${state.flashcards.index + 1} / ${deck.length}</span>
              <button type="button" id="fcNextBtn" class="btn btn-outline btn-sm">Next &rarr;</button>
            </div>
            <div style="display:flex; gap:8px; flex-wrap:wrap;">
              <button type="button" class="btn btn-sm btn-danger" data-fc-rate="1">1 · Again / Hard</button>
              <button type="button" class="btn btn-sm btn-warning" data-fc-rate="2">2 · Good</button>
              <button type="button" class="btn btn-sm btn-success" data-fc-rate="3">3 · Mastered</button>
            </div>
          </div>
        </div>
      ` : `<div class="card empty-state">${state.flashcards.mode === "review" ? "All flashcards in this filter are mastered!" : "No flashcards available yet."}</div>`}
    `;

    document.getElementById("fcTopicSel").value = state.flashcards.topicId;
    document.getElementById("fcModeSel").value = state.flashcards.mode;
    document.getElementById("fcTopicSel").addEventListener("change", (e) => {
      state.flashcards.topicId = e.target.value;
      state.flashcards.index = 0;
      state.flashcards.flipped = false;
      state.flashcards.hintOpen = false;
      renderCurrentView();
    });
    document.getElementById("fcModeSel").addEventListener("change", (e) => {
      state.flashcards.mode = e.target.value;
      state.flashcards.index = 0;
      state.flashcards.flipped = false;
      state.flashcards.hintOpen = false;
      renderCurrentView();
    });

    const cardEl = document.getElementById("flashcardCard");
    cardEl?.addEventListener("click", (e) => {
      if (e.target.closest("#fcHintBtn")) return;
      state.flashcards.flipped = !state.flashcards.flipped;
      cardEl.classList.toggle("is-flipped", state.flashcards.flipped);
    });
    document.getElementById("fcHintBtn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      state.flashcards.hintOpen = !state.flashcards.hintOpen;
      renderCurrentView();
    });
    document.getElementById("fcPrevBtn")?.addEventListener("click", () => stepFlashcard(-1, deck.length));
    document.getElementById("fcNextBtn")?.addEventListener("click", () => stepFlashcard(1, deck.length));
    main.querySelectorAll("[data-fc-rate]").forEach((btn) => {
      btn.addEventListener("click", () => rateFlashcard(fc, parseInt(btn.dataset.fcRate, 10), deck.length));
    });
  }

  main.querySelectorAll("[data-subtab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.studySubTab = btn.dataset.subtab;
      renderCurrentView();
    });
  });
}

function renderFormulaCardsHtml(items) {
  if (!items.length) {
    return `<div class="card empty-state" style="grid-column:1/-1;">No formulas match your filter.</div>`;
  }
  return items.map((f) => {
    const topic = getTopicById(f.topicId);
    return `
      <article class="card formula-card">
        <div class="question-meta">
          <span class="pill pill-primary">${escapeHtml(topic?.code || f.topicId || "Formula")}</span>
          <strong style="font-size:16px;">${escapeHtml(f.name)}</strong>
        </div>
        <div class="formula-math">${renderLatexBlock(f.latex)}</div>
        ${f.variables ? `<p class="formula-detail"><strong>Variables:</strong> ${renderMathText(f.variables)}</p>` : ""}
        ${f.whenToUse ? `<p class="formula-detail"><strong>When to use:</strong> ${renderMathText(f.whenToUse)}</p>` : ""}
        ${f.pitfall ? `<div class="formula-pitfall"><strong>Exam Pitfall:</strong> ${renderMathText(f.pitfall)}</div>` : ""}
      </article>
    `;
  }).join("");
}

function stepFlashcard(delta, len) {
  if (!len) return;
  state.flashcards.index = (state.flashcards.index + delta + len) % len;
  state.flashcards.flipped = false;
  state.flashcards.hintOpen = false;
  renderCurrentView();
}

async function rateFlashcard(fc, rating, len) {
  if (!fc) return;
  const sp = getSubjectProgress();
  const prev = sp.flashcards[fc.id] || { reviews: 0 };
  sp.flashcards[fc.id] = {
    rating,
    reviews: (prev.reviews || 0) + 1,
    lastAt: new Date().toISOString(),
  };
  if (state.flashcards.mode === "review" && rating === 3) {
    state.flashcards.index = Math.min(state.flashcards.index, Math.max(0, len - 2));
  } else {
    state.flashcards.index = len ? (state.flashcards.index + 1) % len : 0;
  }
  state.flashcards.flipped = false;
  state.flashcards.hintOpen = false;
  renderCurrentView();
  await persistProgress();
}

// --- View 5: Concept Graph ---

async function renderGraphView(main) {
  if (!state.activeSubjectId) {
    main.innerHTML = `<div class="card empty-state">Select a subject first.</div>`;
    return;
  }

  main.innerHTML = `<div class="card empty-state">Loading Graphify knowledge graph…</div>`;
  let graphData = state.graphCache.get(state.activeSubjectId);
  if (!graphData) {
    try {
      graphData = await apiJson(`/api/subjects/${encodeURIComponent(state.activeSubjectId)}/graph`);
      state.graphCache.set(state.activeSubjectId, graphData);
    } catch (err) {
      main.innerHTML = `<div class="card empty-state">Error loading graph: ${escapeHtml(err.message)}</div>`;
      return;
    }
  }

  if (state.tab !== "graph") return;

  const nodes = Array.isArray(graphData?.nodes) ? graphData.nodes : [];
  const edges = Array.isArray(graphData?.links)
    ? graphData.links
    : Array.isArray(graphData?.edges)
      ? graphData.edges
      : [];

  const commSet = new Set(nodes.map((n) => n.community).filter((c) => c !== undefined && c !== null));
  const degreeMap = new Map(nodes.map((n) => [String(n.id), 0]));
  edges.forEach((e) => {
    const s = typeof e.source === "object" && e.source !== null ? String(e.source.id) : String(e.source);
    const t = typeof e.target === "object" && e.target !== null ? String(e.target.id) : String(e.target);
    if (degreeMap.has(s)) degreeMap.set(s, degreeMap.get(s) + 1);
    if (degreeMap.has(t)) degreeMap.set(t, degreeMap.get(t) + 1);
  });
  const topGods = [...nodes]
    .sort((a, b) => (degreeMap.get(String(b.id)) || 0) - (degreeMap.get(String(a.id)) || 0))
    .slice(0, 5);

  main.innerHTML = `
    <div class="section-head" style="margin-bottom:14px;">
      <div>
        <h1 class="page-title">Concept Graph</h1>
        <p class="page-subtitle">${nodes.length} nodes &middot; ${edges.length} edges &middot; ${commSet.size} communities</p>
      </div>
      <div style="display:flex; gap:8px; align-items:center;">
        <label class="btn btn-outline btn-sm" style="cursor:pointer;">
          Upload / Update graph.json
          <input type="file" id="quickGraphUpload" accept=".json,application/json" hidden>
        </label>
      </div>
    </div>

    ${topGods.length ? `
      <div class="chip-row" style="margin-bottom:14px; align-items:center;">
        <span class="muted-xs" style="font-weight:700;">Top God Nodes:</span>
        ${topGods.map((g) => `
          <button type="button" class="file-chip" data-god-id="${escapeHtml(g.id)}" style="cursor:pointer;">
            ${escapeHtml(g.label || g.id)} (${degreeMap.get(String(g.id)) || 0})
          </button>
        `).join("")}
      </div>
    ` : ""}

    <div id="graphMount"></div>
  `;

  document.getElementById("quickGraphUpload").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadGraphJsonFile(file);
  });

  if (!nodes.length) {
    document.getElementById("graphMount").innerHTML = `
      <div class="card empty-state">
        <h3 style="margin-top:0;">No graph.json for this subject yet</h3>
        <p>Import a Graphify <code>graph.json</code> (NetworkX node-link JSON) using the upload button above or in Materials &amp; Data.</p>
      </div>
    `;
    return;
  }

  const mount = document.getElementById("graphMount");
  const summary = activeSubjectSummary();
  if (state.graphHandle) state.graphHandle.destroy();
  state.graphHandle = mountGraphViewer(mount, graphData, {
    subjectFiles: summary?.files || [],
    topics: state.study.topics || [],
    onPracticeTopic: (topicId) => {
      state.quiz.filters.topicId = topicId;
      state.quiz.session = null;
      setActiveTab("quiz");
      startQuizSession("quiz");
    },
  });

  main.querySelectorAll("[data-god-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.graphHandle?.selectNode(btn.dataset.godId);
    });
  });
}

// --- View 6: Mistake Bank ---

function renderMistakeBank(main) {
  const sp = getSubjectProgress();
  const mistakes = activeMistakeQuestions();

  main.innerHTML = `
    <div class="section-head">
      <div>
        <h1 class="page-title">Mistake Bank</h1>
        <p class="page-subtitle">Answer a missed question correctly 2 times in a row during Mistake Drill to graduate it</p>
      </div>
      <button type="button" id="startAllDrillBtn" class="btn btn-warning" ${mistakes.length === 0 ? "disabled" : ""}>
        Start Mistake Drill (${mistakes.length})
      </button>
    </div>

    ${mistakes.length ? `
      <div class="table-list">
        ${mistakes.map((q) => {
          const info = sp.mistakes[q.id];
          const topic = getTopicById(q.topicId);
          return `
            <div class="card card-compact">
              <div class="question-meta" style="margin-bottom:8px;">
                <span class="pill pill-primary">${escapeHtml(topic?.code || q.topicId)}</span>
                ${q.difficulty ? `<span class="pill">${escapeHtml(q.difficulty)}</span>` : ""}
                <span class="pill pill-danger">Missed ${info.missCount || 1}&times;</span>
                <span class="pill pill-warning">Streak ${info.streak || 0}/2</span>
              </div>
              <div style="margin-bottom:10px;">${renderMathText(q.prompt)}</div>
              <div style="display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end;">
                <button type="button" class="btn btn-sm btn-outline" data-drill-one="${escapeHtml(q.id)}">Drill Question</button>
                <button type="button" class="btn btn-sm btn-success" data-graduate="${escapeHtml(q.id)}">Mark Mastered</button>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    ` : `
      <div class="card empty-state">
        <h3 style="margin-top:0;">Mistake Bank is empty</h3>
        <p>Missed questions from Topic Quiz or Timed Mock Exam are automatically saved here for focused review.</p>
      </div>
    `}
  `;

  document.getElementById("startAllDrillBtn").addEventListener("click", () => {
    setActiveTab("quiz");
    startQuizSession("drill");
  });

  main.querySelectorAll("[data-drill-one]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const q = state.study.questions.find((item) => item.id === btn.dataset.drillOne);
      if (!q) return;
      setActiveTab("quiz");
      startQuizSession("drill", [q]);
    });
  });

  main.querySelectorAll("[data-graduate]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      delete sp.mistakes[btn.dataset.graduate];
      updateHeaderAndBadges();
      renderCurrentView();
      await persistProgress();
      showToast("Marked as mastered and removed from Mistake Bank.", "success");
    });
  });
}

// --- View 7: Materials & Data ---

async function uploadMaterialFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length || !state.activeSubjectId) return;
  if (staticMode) {
    let importedJson = 0;
    for (const file of files) {
      if (file.name.toLowerCase().endsWith(".json")) {
        try {
          const parsed = JSON.parse(await file.text());
          if (Array.isArray(parsed?.nodes)) {
            await uploadGraphJsonFile(file);
          } else {
            await importStudyJsonFile(file, "merge");
          }
          importedJson += 1;
        } catch (err) {
          showToast(`${file.name}: ${err.message}`, "error");
        }
      } else {
        showToast(`${file.name}: Static GitHub Pages mode saves JSON/content in browser storage. Add PDFs/images via the Git repo or local server.py.`, "info");
      }
    }
    if (importedJson > 0) showToast(`Imported ${importedJson} JSON file(s) into browser storage.`, "success");
    return;
  }
  let uploaded = 0;
  for (const file of files) {
    try {
      const url = `./api/subjects/${encodeURIComponent(state.activeSubjectId)}/upload?filename=${encodeURIComponent(file.name)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Upload failed (${res.status})`);
      uploaded += 1;
    } catch (err) {
      showToast(`${file.name}: ${err.message}`, "error");
    }
  }
  if (uploaded > 0) {
    await refreshSubjectsList();
    updateHeaderAndBadges();
    renderCurrentView();
    showToast(`Uploaded ${uploaded} file(s).`, "success");
  }
}

async function importStudyJsonFile(file, mode) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    await apiJson(`/api/subjects/${encodeURIComponent(state.activeSubjectId)}/import`, {
      method: "POST",
      body: JSON.stringify({ mode, data: parsed }),
    });
    await refreshSubjectsList();
    state.study = await apiJson(`/api/subjects/${encodeURIComponent(state.activeSubjectId)}/study`);
    updateHeaderAndBadges();
    renderCurrentView();
    showToast(`Imported study data (${mode} mode).`, "success");
  } catch (err) {
    showToast(`Study import failed: ${err.message}`, "error");
  }
}

async function uploadGraphJsonFile(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const res = await apiJson(`/api/subjects/${encodeURIComponent(state.activeSubjectId)}/graph`, {
      method: "PUT",
      body: JSON.stringify(parsed),
    });
    state.graphCache.delete(state.activeSubjectId);
    await refreshSubjectsList();
    updateHeaderAndBadges();
    renderCurrentView();
    showToast(`Saved graph.json (${res.counts?.nodes ?? 0} nodes).`, "success");
  } catch (err) {
    showToast(`Graph import failed: ${err.message}`, "error");
  }
}

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function saveUpdatedStudy(updatedStudy, toastMsg) {
  await apiJson(`/api/subjects/${encodeURIComponent(state.activeSubjectId)}/study`, {
    method: "PUT",
    body: JSON.stringify(updatedStudy),
  });
  state.study = updatedStudy;
  await refreshSubjectsList();
  updateHeaderAndBadges();
  populateDrawerTopicOptions();
  renderCurrentView();
  showToast(toastMsg, "success");
}

function renderAddContentForm() {
  const tab = state.materials.addTab;
  const topicOptions = state.study.topics
    .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.code || t.id)} — ${escapeHtml(t.title)}</option>`)
    .join("");

  if (tab === "topic") {
    return `
      <form id="addTopicForm" class="form-grid">
        <div class="form-row-2">
          <div class="form-field">
            <label class="field-label" for="addTopicTitle">Topic Title *</label>
            <input id="addTopicTitle" class="input" required placeholder="e.g. Thermodynamics">
          </div>
          <div class="form-field">
            <label class="field-label" for="addTopicCode">Code</label>
            <input id="addTopicCode" class="input" placeholder="e.g. EP11">
          </div>
        </div>
        <div class="form-row-2">
          <div class="form-field">
            <label class="field-label" for="addTopicId">Topic ID (auto if blank)</label>
            <input id="addTopicId" class="input" placeholder="e.g. ep11">
          </div>
          <div class="form-field">
            <label class="field-label" for="addTopicFiles">Source Files (comma-separated)</label>
            <input id="addTopicFiles" class="input" placeholder="lecture1.pdf, notes.md">
          </div>
        </div>
        <div class="form-field">
          <label class="field-label" for="addTopicSummary">Summary</label>
          <textarea id="addTopicSummary" class="textarea" rows="2"></textarea>
        </div>
        <div class="form-field">
          <label class="field-label" for="addTopicPoints">Key Points (one per line)</label>
          <textarea id="addTopicPoints" class="textarea" rows="3"></textarea>
        </div>
        <div><button type="submit" class="btn btn-primary">Add Topic</button></div>
      </form>
    `;
  }

  if (tab === "question") {
    return `
      <form id="addQuestionForm" class="form-grid">
        <div class="form-row-2">
          <div class="form-field">
            <label class="field-label" for="addQTopic">Topic ID *</label>
            ${topicOptions ? `<select id="addQTopic" class="input-select">${topicOptions}</select>` : `<input id="addQTopic" class="input" required placeholder="e.g. ep1">`}
          </div>
          <div class="form-field">
            <label class="field-label" for="addQSource">Source File</label>
            <input id="addQSource" class="input" placeholder="optional PDF filename">
          </div>
        </div>
        <div class="form-row-2">
          <div class="form-field">
            <label class="field-label" for="addQDiff">Difficulty</label>
            <select id="addQDiff" class="input-select">
              <option value="easy">Easy</option>
              <option value="medium" selected>Medium</option>
              <option value="hard">Hard</option>
            </select>
          </div>
          <div class="form-field">
            <label class="field-label" for="addQCat">Category</label>
            <select id="addQCat" class="input-select">
              <option value="conceptual">Conceptual</option>
              <option value="calculation">Calculation</option>
            </select>
          </div>
        </div>
        <div class="form-field">
          <label class="field-label" for="addQPrompt">Question Prompt (supports $math$) *</label>
          <textarea id="addQPrompt" class="textarea" rows="2" required></textarea>
        </div>
        <div class="form-row-2">
          <div class="form-field"><label class="field-label" for="addQC0">Choice A *</label><input id="addQC0" class="input" required></div>
          <div class="form-field"><label class="field-label" for="addQC1">Choice B *</label><input id="addQC1" class="input" required></div>
          <div class="form-field"><label class="field-label" for="addQC2">Choice C *</label><input id="addQC2" class="input" required></div>
          <div class="form-field"><label class="field-label" for="addQC3">Choice D *</label><input id="addQC3" class="input" required></div>
        </div>
        <div class="form-row-2">
          <div class="form-field">
            <label class="field-label" for="addQAns">Correct Choice *</label>
            <select id="addQAns" class="input-select">
              <option value="0">A</option>
              <option value="1">B</option>
              <option value="2">C</option>
              <option value="3">D</option>
            </select>
          </div>
          <div class="form-field">
            <label class="field-label" for="addQFormulas">Formula IDs (comma-separated)</label>
            <input id="addQFormulas" class="input" placeholder="e.g. f-ep7-01">
          </div>
        </div>
        <div class="form-field">
          <label class="field-label" for="addQHint">Hint</label>
          <input id="addQHint" class="input">
        </div>
        <div class="form-field">
          <label class="field-label" for="addQSol">Worked Solution (supports $math$)</label>
          <textarea id="addQSol" class="textarea" rows="2"></textarea>
        </div>
        <div><button type="submit" class="btn btn-primary">Add Question</button></div>
      </form>
    `;
  }

  if (tab === "formula") {
    return `
      <form id="addFormulaForm" class="form-grid">
        <div class="form-row-2">
          <div class="form-field">
            <label class="field-label" for="addFTopic">Topic ID *</label>
            ${topicOptions ? `<select id="addFTopic" class="input-select">${topicOptions}</select>` : `<input id="addFTopic" class="input" required placeholder="e.g. ep1">`}
          </div>
          <div class="form-field">
            <label class="field-label" for="addFName">Formula Name *</label>
            <input id="addFName" class="input" required placeholder="e.g. Ideal Gas Law">
          </div>
        </div>
        <div class="form-field">
          <label class="field-label" for="addFLatex">LaTeX Expression (no outer $) *</label>
          <input id="addFLatex" class="input" required placeholder="PV = nRT">
        </div>
        <div class="form-field">
          <label class="field-label" for="addFVars">Variables &amp; Units</label>
          <input id="addFVars" class="input" placeholder="P: pressure (Pa), V: volume (m^3)...">
        </div>
        <div class="form-row-2">
          <div class="form-field">
            <label class="field-label" for="addFUse">When to Use</label>
            <input id="addFUse" class="input">
          </div>
          <div class="form-field">
            <label class="field-label" for="addFPitfall">Exam Pitfall</label>
            <input id="addFPitfall" class="input">
          </div>
        </div>
        <div><button type="submit" class="btn btn-primary">Add Formula</button></div>
      </form>
    `;
  }

  return `
    <form id="addFlashcardForm" class="form-grid">
      <div class="form-field">
        <label class="field-label" for="addFcTopic">Topic ID *</label>
        ${topicOptions ? `<select id="addFcTopic" class="input-select">${topicOptions}</select>` : `<input id="addFcTopic" class="input" required placeholder="e.g. ep1">`}
      </div>
      <div class="form-field">
        <label class="field-label" for="addFcFront">Front Prompt (supports $math$) *</label>
        <textarea id="addFcFront" class="textarea" rows="2" required></textarea>
      </div>
      <div class="form-field">
        <label class="field-label" for="addFcBack">Back Answer (supports $math$) *</label>
        <textarea id="addFcBack" class="textarea" rows="2" required></textarea>
      </div>
      <div class="form-field">
        <label class="field-label" for="addFcHint">Memory Hint</label>
        <input id="addFcHint" class="input">
      </div>
      <div><button type="submit" class="btn btn-primary">Add Flashcard</button></div>
    </form>
  `;
}

function renderGeneratorSection() {
  const g = state.generator;
  const savedKey = getSavedApiKey();
  const isAi = g.mode === "ai";
  const fileChips = g.files.map((f, idx) => `
    <span class="file-chip">
      ${escapeHtml(f.name)} (${formatBytes(f.size)})
      <button type="button" data-gen-remove-file="${idx}" aria-label="Remove file" style="border:none;background:transparent;cursor:pointer;padding:0 2px;font-weight:700;">&times;</button>
    </span>
  `).join("");

  const previewHtml = g.preview ? `
    <div class="gen-preview-box" id="genPreviewBox">
      <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px;">
        <div>
          <span class="pill pill-primary">${escapeHtml(g.preview.engine)}</span>
          <strong style="margin-left:6px; font-size:15px;">${escapeHtml(g.preview.topic.title)}</strong>
        </div>
        <div class="chip-row">
          <span class="pill pill-success">${g.preview.questions.length} MCQs</span>
          <span class="pill">${g.preview.formulas.length} Formulas</span>
          <span class="pill">${g.preview.flashcards.length} Flashcards</span>
        </div>
      </div>
      ${g.preview.questions[0] ? `
        <div class="card card-compact" style="background:var(--surface);">
          <div class="muted-xs" style="margin-bottom:4px;">Sample Generated Question:</div>
          <div>${renderMathText(g.preview.questions[0].prompt)}</div>
        </div>
      ` : ""}
      <div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px;">
        <select id="genSaveModeSel" class="input-select" style="max-width:170px;">
          <option value="merge" ${g.saveMode === "merge" ? "selected" : ""}>Merge into Subject</option>
          <option value="replace" ${g.saveMode === "replace" ? "selected" : ""}>Replace Subject Data</option>
        </select>
        <button type="button" id="genSaveOnlyBtn" class="btn btn-outline">Save to Subject</button>
        <button type="button" id="genSaveQuizBtn" class="btn btn-primary">Save &amp; Start Topic Quiz</button>
        <button type="button" id="genSaveExamBtn" class="btn btn-success">Save &amp; Start Mock Exam</button>
      </div>
    </div>
  ` : "";

  return `
    <section class="card generator-card" id="autoGeneratorCard">
      <div class="gen-header">
        <div>
          <span class="pill pill-primary" style="margin-bottom:6px;">&#10022; Auto Quiz &amp; Mock Generator</span>
          <h2 class="page-title" style="font-size:24px;">Generate Study Pack from Notes or PDFs</h2>
          <p class="muted-xs" style="margin-top:4px;">Automatically create a new topic, MCQs, timed mock exam pool, formulas, and flashcards for ${escapeHtml(state.study.name)}.</p>
        </div>
        <div class="subtabs" role="tablist" aria-label="Generator engine">
          <button type="button" class="subtab-btn ${isAi ? "active" : ""}" data-gen-mode="ai">AI (Gemini)</button>
          <button type="button" class="subtab-btn ${!isAi ? "active" : ""}" data-gen-mode="offline">Offline Note Parser</button>
        </div>
      </div>

      ${isAi ? `
        <div class="gen-key-bar">
          <div style="flex:1; min-width:220px;">
            <label for="genApiKeyInput" class="field-label">Gemini API Key (saved only in your browser)</label>
            <input id="genApiKeyInput" type="password" class="input" value="${escapeHtml(savedKey)}" placeholder="Paste AIza... key from Google AI Studio">
          </div>
          <div style="display:flex; gap:8px; align-items:flex-end; padding-top:18px;">
            <button type="button" id="genSaveKeyBtn" class="btn btn-outline btn-sm">Save Key</button>
            <a class="btn btn-ghost btn-sm" href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Get Free Key &nearr;</a>
          </div>
        </div>
      ` : `
        <div class="gen-key-bar">
          <span class="muted-xs"><strong>Offline Smart Parser:</strong> No API key needed. Best with Markdown headings (<code># Topic</code>), <code>Term: Definition</code> bullets, <code>Q:/A:</code> pairs, or equations (<code>$...$</code>).</span>
        </div>
      `}

      <div class="gen-controls-grid">
        <div>
          <label for="genTopicTitle" class="field-label">Topic / Chapter Title (optional)</label>
          <input id="genTopicTitle" class="input" value="${escapeHtml(g.topicTitle)}" placeholder="Auto-detect from material">
        </div>
        <div>
          <label for="genQuestionCount" class="field-label">Questions to Generate</label>
          <select id="genQuestionCount" class="input-select">
            ${[10, 15, 20, 30].map((n) => `<option value="${n}" ${Number(g.questionCount) === n ? "selected" : ""}>${n} Questions</option>`).join("")}
          </select>
        </div>
        <div>
          <label for="genStyleSel" class="field-label">Question Focus</label>
          <select id="genStyleSel" class="input-select">
            <option value="balanced" ${g.examStyle === "balanced" ? "selected" : ""}>Balanced Mix</option>
            <option value="conceptual" ${g.examStyle === "conceptual" ? "selected" : ""}>Conceptual Focus</option>
            <option value="calculation" ${g.examStyle === "calculation" ? "selected" : ""}>Calculation Heavy</option>
          </select>
        </div>
        <div>
          <label for="genLangSel" class="field-label">Language</label>
          <select id="genLangSel" class="input-select">
            <option value="auto" ${g.language === "auto" ? "selected" : ""}>Match Material</option>
            <option value="english" ${g.language === "english" ? "selected" : ""}>English</option>
            <option value="thai" ${g.language === "thai" ? "selected" : ""}>Thai</option>
          </select>
        </div>
      </div>

      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:12px; margin-bottom:14px;">
        <div>
          <label class="field-label">Source Files (${isAi ? ".pdf, images, .md, .txt" : ".md, .txt"})</label>
          <div id="genDropzone" class="dropzone" tabindex="0" role="button" style="padding:16px;">
            <strong>Attach PDFs, slides, or notes</strong>
            <p class="muted-xs" style="margin-top:4px;">${isAi ? "AI reads image-based PDFs directly" : "Text / Markdown files"}</p>
            <input type="file" id="genFileInput" multiple accept="${isAi ? ".pdf,.md,.txt,.png,.jpg,.jpeg,.webp" : ".md,.txt"}" hidden>
          </div>
          ${g.files.length ? `<div class="chip-row" style="margin-top:8px;">${fileChips}</div>` : ""}
        </div>

        <div>
          <label for="genNotesTextarea" class="field-label">Or Paste Lecture Notes / Outline</label>
          <textarea id="genNotesTextarea" class="textarea" rows="5" placeholder="# Chapter 1: Enzyme Kinetics&#10;- Michaelis-Menten Equation: $v = \\frac{V_{max}[S]}{K_m + [S]}$&#10;- Competitive Inhibition: Inhibitor binds active site, increasing apparent $K_m$...">${escapeHtml(g.notesText)}</textarea>
        </div>
      </div>

      ${g.error ? `<p class="form-error" style="margin-bottom:10px;">${escapeHtml(g.error)}</p>` : ""}

      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <button type="button" id="genRunBtn" class="btn btn-primary" ${g.busy ? "disabled" : ""}>
          ${g.busy ? "Generating Study Pack…" : "Generate Study Pack"}
        </button>
        ${g.preview ? `<button type="button" id="genDiscardBtn" class="btn btn-ghost btn-sm">Clear Preview</button>` : ""}
      </div>

      ${previewHtml}
    </section>
  `;
}

async function applyGeneratedPack(launchTarget = "stay") {
  const pack = state.generator.preview;
  if (!pack || !state.activeSubjectId) return;
  const mode = state.generator.saveMode || "merge";
  const payload = {
    name: state.study.name,
    code: state.study.code,
    description: state.study.description,
    topics: [pack.topic],
    formulas: pack.formulas,
    flashcards: pack.flashcards,
    questions: pack.questions,
  };
  await apiJson(`/api/subjects/${encodeURIComponent(state.activeSubjectId)}/import`, {
    method: "POST",
    body: JSON.stringify({ mode, data: payload }),
  });
  await refreshSubjectsList();
  state.study = await apiJson(`/api/subjects/${encodeURIComponent(state.activeSubjectId)}/study`);
  state.generator.preview = null;
  state.generator.error = "";
  updateHeaderAndBadges();
  populateDrawerTopicOptions();
  showToast(`Saved ${pack.questions.length} questions, ${pack.formulas.length} formulas, ${pack.flashcards.length} flashcards!`, "success");

  if (launchTarget === "quiz") {
    state.quiz.filters.topicId = pack.topic.id;
    state.quiz.session = null;
    setActiveTab("quiz");
    startQuizSession("quiz");
    return;
  }
  if (launchTarget === "exam") {
    const qList = state.study.questions.filter((q) => q.topicId === pack.topic.id);
    const pool = qList.length ? qList : state.study.questions;
    const count = Math.min(25, pool.length);
    const mins = Math.max(10, Math.round(count * 1.5));
    state.exam.filters.selectedTopics = new Set([pack.topic.id]);
    setActiveTab("exam");
    startTimedExam(count, mins, `${state.study.code || state.study.name} — ${pack.topic.title}`);
    return;
  }
  renderCurrentView();
}

function renderMaterials(main) {
  if (!state.activeSubjectId) {
    main.innerHTML = `<div class="card empty-state">Create or select a subject first.</div>`;
    return;
  }

  const summary = activeSubjectSummary();
  const files = summary?.files || [];

  main.innerHTML = `
    <div class="section-head">
      <div>
        <h1 class="page-title">Generate &amp; Data</h1>
        <p class="page-subtitle">Auto-generate quizzes &amp; mock exams, upload PDFs, import packs, or add items for ${escapeHtml(state.study.name)}</p>
      </div>
      <button type="button" id="matNewSubjBtn" class="btn btn-outline">+ New Subject</button>
    </div>

    ${renderGeneratorSection()}

    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(340px, 1fr)); gap:16px; margin-bottom:20px;">
      <section class="card">
        <h2 style="margin:0 0 10px; font-size:17px;">Upload Study Materials</h2>
        <div id="fileDropzone" class="dropzone" tabindex="0" role="button" aria-label="Drop files here or click to upload">
          <strong>Drop files here or click to browse</strong>
          <p class="muted-xs" style="margin-top:4px;">Supports .pdf, .md, .txt, .json, .png, .jpg, .jpeg, .webp (max 50 MB local)</p>
          <input type="file" id="materialFileInput" multiple accept=".pdf,.md,.txt,.json,.png,.jpg,.jpeg,.webp" hidden>
        </div>

        <h3 style="margin:16px 0 8px; font-size:15px;">Subject Files (${files.length})</h3>
        ${files.length ? `
          <div class="table-list">
            ${files.map((f) => `
              <div class="list-row">
                <div style="min-width:0; flex:1;">
                  <a href="${escapeHtml(f.url)}" target="_blank" rel="noopener" style="font-weight:600; word-break:break-all;">${escapeHtml(f.name)}</a>
                  <div class="muted-xs">${escapeHtml(f.ext || "file")} &middot; ${formatBytes(f.size)}</div>
                </div>
                <div style="display:flex; gap:6px;">
                  <a class="btn btn-sm btn-outline" href="${escapeHtml(f.url)}" target="_blank" rel="noopener">Open</a>
                  <button type="button" class="btn btn-sm btn-danger" data-del-file="${escapeHtml(f.name)}">Delete</button>
                </div>
              </div>
            `).join("")}
          </div>
        ` : `<p class="muted-xs">No files uploaded to this subject yet.</p>`}
      </section>

      <section class="card">
        <h2 style="margin:0 0 10px; font-size:17px;">Import &amp; Export JSON</h2>
        <div style="display:flex; flex-direction:column; gap:14px;">
          <div>
            <label for="importModeSel" class="field-label">Study Pack Import Mode</label>
            <div style="display:flex; gap:8px; flex-wrap:wrap;">
              <select id="importModeSel" class="input-select" style="max-width:170px;">
                <option value="merge">Merge by ID</option>
                <option value="replace">Replace All</option>
              </select>
              <label class="btn btn-primary" style="cursor:pointer;">
                Import Study Pack JSON
                <input type="file" id="importStudyInput" accept=".json,application/json" hidden>
              </label>
            </div>
          </div>

          <div style="padding-top:12px; border-top:1px solid var(--border); display:flex; flex-wrap:wrap; gap:8px;">
            <label class="btn btn-outline" style="cursor:pointer;">
              Import Graphify graph.json
              <input type="file" id="importGraphInput" accept=".json,application/json" hidden>
            </label>
            <button type="button" id="exportStudyBtn" class="btn btn-outline">Export study.json</button>
            <button type="button" id="downloadTemplateBtn" class="btn btn-ghost">Download Blank Template JSON</button>
          </div>
        </div>
      </section>
    </div>

    <section class="card">
      <div class="section-head" style="margin-bottom:14px;">
        <h2 style="margin:0; font-size:17px;">Add Content Manually</h2>
        <div class="subtabs">
          <button type="button" class="subtab-btn ${state.materials.addTab === "topic" ? "active" : ""}" data-add-tab="topic">Topic</button>
          <button type="button" class="subtab-btn ${state.materials.addTab === "question" ? "active" : ""}" data-add-tab="question">Question</button>
          <button type="button" class="subtab-btn ${state.materials.addTab === "formula" ? "active" : ""}" data-add-tab="formula">Formula</button>
          <button type="button" class="subtab-btn ${state.materials.addTab === "flashcard" ? "active" : ""}" data-add-tab="flashcard">Flashcard</button>
        </div>
      </div>
      ${renderAddContentForm()}
    </section>
  `;

  // Auto-Generator listeners
  main.querySelectorAll("[data-gen-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.generator.mode = btn.dataset.genMode;
      state.generator.error = "";
      renderCurrentView();
    });
  });

  document.getElementById("genSaveKeyBtn")?.addEventListener("click", () => {
    const val = document.getElementById("genApiKeyInput")?.value || "";
    saveApiKey(val);
    showToast(val.trim() ? "Gemini API key saved in this browser." : "Cleared Gemini API key.", "success");
  });

  document.getElementById("genTopicTitle")?.addEventListener("input", (e) => { state.generator.topicTitle = e.target.value; });
  document.getElementById("genQuestionCount")?.addEventListener("change", (e) => { state.generator.questionCount = parseInt(e.target.value, 10) || 15; });
  document.getElementById("genStyleSel")?.addEventListener("change", (e) => { state.generator.examStyle = e.target.value; });
  document.getElementById("genLangSel")?.addEventListener("change", (e) => { state.generator.language = e.target.value; });
  document.getElementById("genNotesTextarea")?.addEventListener("input", (e) => { state.generator.notesText = e.target.value; });

  const genDrop = document.getElementById("genDropzone");
  const genFileIn = document.getElementById("genFileInput");
  genDrop?.addEventListener("click", () => genFileIn.click());
  genDrop?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      genFileIn.click();
    }
  });
  genDrop?.addEventListener("dragover", (e) => { e.preventDefault(); genDrop.classList.add("dragover"); });
  genDrop?.addEventListener("dragleave", () => genDrop.classList.remove("dragover"));
  genDrop?.addEventListener("drop", (e) => {
    e.preventDefault();
    genDrop.classList.remove("dragover");
    state.generator.files = [...state.generator.files, ...Array.from(e.dataTransfer?.files || [])];
    renderCurrentView();
  });
  genFileIn?.addEventListener("change", () => {
    state.generator.files = [...state.generator.files, ...Array.from(genFileIn.files || [])];
    renderCurrentView();
  });
  main.querySelectorAll("[data-gen-remove-file]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.genRemoveFile, 10);
      state.generator.files.splice(idx, 1);
      renderCurrentView();
    });
  });

  document.getElementById("genDiscardBtn")?.addEventListener("click", () => {
    state.generator.preview = null;
    state.generator.error = "";
    renderCurrentView();
  });

  document.getElementById("genRunBtn")?.addEventListener("click", async () => {
    state.generator.busy = true;
    state.generator.error = "";
    const keyVal = document.getElementById("genApiKeyInput")?.value || getSavedApiKey();
    if (state.generator.mode === "ai" && keyVal.trim()) saveApiKey(keyVal);
    renderCurrentView();
    try {
      const pack = state.generator.mode === "ai"
        ? await generateWithGemini({
            apiKey: keyVal,
            files: state.generator.files,
            notesText: state.generator.notesText,
            subjectName: state.study.name || state.activeSubjectId,
            topicTitle: state.generator.topicTitle,
            questionCount: state.generator.questionCount,
            examStyle: state.generator.examStyle,
            language: state.generator.language,
          })
        : await generateOfflineFromNotes({
            files: state.generator.files,
            notesText: state.generator.notesText,
            subjectName: state.study.name || state.activeSubjectId,
            topicTitle: state.generator.topicTitle,
            questionCount: state.generator.questionCount,
          });
      state.generator.preview = pack;
      showToast(`Generated ${pack.questions.length} MCQs and ${pack.flashcards.length} flashcards!`, "success");
    } catch (err) {
      state.generator.error = err.message;
      showToast(err.message, "error");
    } finally {
      state.generator.busy = false;
      renderCurrentView();
    }
  });

  document.getElementById("genSaveModeSel")?.addEventListener("change", (e) => { state.generator.saveMode = e.target.value; });
  document.getElementById("genSaveOnlyBtn")?.addEventListener("click", () => applyGeneratedPack("stay"));
  document.getElementById("genSaveQuizBtn")?.addEventListener("click", () => applyGeneratedPack("quiz"));
  document.getElementById("genSaveExamBtn")?.addEventListener("click", () => applyGeneratedPack("exam"));

  document.getElementById("matNewSubjBtn").addEventListener("click", openNewSubjectDialog);

  const dropzone = document.getElementById("fileDropzone");
  const fileInput = document.getElementById("materialFileInput");
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    uploadMaterialFiles(e.dataTransfer?.files);
  });
  fileInput.addEventListener("change", () => uploadMaterialFiles(fileInput.files));

  main.querySelectorAll("[data-del-file]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const filename = btn.dataset.delFile;
      if (!confirm(`Delete '${filename}' permanently?`)) return;
      try {
        await apiJson(`/api/subjects/${encodeURIComponent(state.activeSubjectId)}/files/${encodeURIComponent(filename)}`, {
          method: "DELETE",
        });
        await refreshSubjectsList();
        updateHeaderAndBadges();
        renderCurrentView();
        showToast(`Deleted ${filename}.`, "success");
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  });

  const modeSel = document.getElementById("importModeSel");
  modeSel.value = state.materials.importMode;
  modeSel.addEventListener("change", () => { state.materials.importMode = modeSel.value; });

  document.getElementById("importStudyInput").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) importStudyJsonFile(file, state.materials.importMode);
  });
  document.getElementById("importGraphInput").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) uploadGraphJsonFile(file);
  });
  document.getElementById("exportStudyBtn").addEventListener("click", () => {
    downloadJson(`${state.activeSubjectId}-study.json`, state.study);
  });
  document.getElementById("downloadTemplateBtn").addEventListener("click", () => {
    downloadJson("study-template.json", {
      id: state.activeSubjectId || "subject-slug",
      name: "Course Name",
      code: "COURSE101",
      description: "Course overview",
      topics: [{ id: "topic-1", code: "CH1", title: "Chapter 1", summary: "...", sourceFiles: [], keyPoints: ["Key point 1"] }],
      formulas: [{ id: "f-01", topicId: "topic-1", name: "Formula Name", latex: "E = mc^2", variables: "E: energy (J)", whenToUse: "...", pitfall: "..." }],
      flashcards: [{ id: "fc-01", topicId: "topic-1", front: "Prompt", back: "Answer", hint: "Cue" }],
      questions: [{ id: "q-01", topicId: "topic-1", type: "mcq", difficulty: "medium", category: "conceptual", sourceFile: "", prompt: "Question?", choices: ["A", "B", "C", "D"], answerIndex: 0, hint: "...", solution: "...", formulaIds: ["f-01"] }],
    });
  });

  main.querySelectorAll("[data-add-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.materials.addTab = btn.dataset.addTab;
      renderCurrentView();
    });
  });

  // Inline Create Handlers
  document.getElementById("addTopicForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = document.getElementById("addTopicTitle").value.trim();
    const code = document.getElementById("addTopicCode").value.trim() || title.slice(0, 8).toUpperCase();
    const id = slugify(document.getElementById("addTopicId").value || code || title) || `topic-${Date.now()}`;
    const sourceFiles = document.getElementById("addTopicFiles").value.split(",").map((s) => s.trim()).filter(Boolean);
    const summaryText = document.getElementById("addTopicSummary").value.trim();
    const keyPoints = document.getElementById("addTopicPoints").value.split("\n").map((s) => s.trim()).filter(Boolean);

    const next = structuredClone(state.study);
    next.topics.push({ id, code, title, summary: summaryText, sourceFiles, keyPoints });
    await saveUpdatedStudy(next, `Added topic '${title}'.`);
  });

  document.getElementById("addQuestionForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const topicId = document.getElementById("addQTopic").value.trim();
    const next = structuredClone(state.study);
    next.questions.push({
      id: `q-${topicId || "custom"}-${Date.now()}`,
      topicId,
      type: "mcq",
      difficulty: document.getElementById("addQDiff").value,
      category: document.getElementById("addQCat").value,
      sourceFile: document.getElementById("addQSource").value.trim(),
      prompt: document.getElementById("addQPrompt").value.trim(),
      choices: [
        document.getElementById("addQC0").value.trim(),
        document.getElementById("addQC1").value.trim(),
        document.getElementById("addQC2").value.trim(),
        document.getElementById("addQC3").value.trim(),
      ],
      answerIndex: parseInt(document.getElementById("addQAns").value, 10),
      hint: document.getElementById("addQHint").value.trim(),
      solution: document.getElementById("addQSol").value.trim(),
      formulaIds: document.getElementById("addQFormulas").value.split(",").map((s) => s.trim()).filter(Boolean),
    });
    await saveUpdatedStudy(next, "Added question.");
  });

  document.getElementById("addFormulaForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const topicId = document.getElementById("addFTopic").value.trim();
    const next = structuredClone(state.study);
    next.formulas.push({
      id: `f-${topicId || "custom"}-${Date.now()}`,
      topicId,
      name: document.getElementById("addFName").value.trim(),
      latex: document.getElementById("addFLatex").value.trim(),
      variables: document.getElementById("addFVars").value.trim(),
      whenToUse: document.getElementById("addFUse").value.trim(),
      pitfall: document.getElementById("addFPitfall").value.trim(),
    });
    await saveUpdatedStudy(next, "Added formula.");
  });

  document.getElementById("addFlashcardForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const topicId = document.getElementById("addFcTopic").value.trim();
    const next = structuredClone(state.study);
    next.flashcards.push({
      id: `fc-${topicId || "custom"}-${Date.now()}`,
      topicId,
      front: document.getElementById("addFcFront").value.trim(),
      back: document.getElementById("addFcBack").value.trim(),
      hint: document.getElementById("addFcHint").value.trim(),
    });
    await saveUpdatedStudy(next, "Added flashcard.");
  });
}

// --- New Subject Dialog ---

function openNewSubjectDialog() {
  const dlg = document.getElementById("newSubjectDialog");
  document.getElementById("newSubjectForm").reset();
  document.getElementById("newSubjError").hidden = true;
  dlg.showModal();
}

// --- Render Dispatcher ---

function renderCurrentView() {
  const main = document.getElementById("mainContent");
  if (!main) return;
  switch (state.tab) {
    case "dashboard": renderDashboard(main); break;
    case "quiz": renderQuiz(main); break;
    case "exam": renderExam(main); break;
    case "study": renderStudyView(main); break;
    case "graph": renderGraphView(main); break;
    case "mistakes": renderMistakeBank(main); break;
    case "materials": renderMaterials(main); break;
    default: renderDashboard(main);
  }
}

// --- Bootstrapping & Global Listeners ---

async function boot() {
  applyTheme(localStorage.getItem("studyflow.theme") || "light");

  document.getElementById("themeToggleBtn").addEventListener("click", () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    applyTheme(isDark ? "light" : "dark");
  });

  document.getElementById("openSidebarBtn").addEventListener("click", () => {
    document.getElementById("sidebar").classList.add("open");
    document.getElementById("sidebarBackdrop").hidden = false;
  });
  document.getElementById("closeSidebarBtn").addEventListener("click", closeMobileSidebar);
  document.getElementById("sidebarBackdrop").addEventListener("click", closeMobileSidebar);

  document.querySelectorAll(".nav-item[data-tab], .mbn-item[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  });

  document.getElementById("subjectSelect").addEventListener("change", (e) => {
    if (e.target.value) selectSubject(e.target.value);
  });

  document.getElementById("closeDrawerBtn").addEventListener("click", closeFormulaDrawer);
  document.getElementById("drawerBackdrop").addEventListener("click", closeFormulaDrawer);
  document.getElementById("drawerSearchInput").addEventListener("input", renderFormulaDrawerBody);
  document.getElementById("drawerTopicSelect").addEventListener("change", renderFormulaDrawerBody);

  // New Subject Modal
  const dlg = document.getElementById("newSubjectDialog");
  const nameIn = document.getElementById("newSubjName");
  const idIn = document.getElementById("newSubjId");
  let idTouched = false;

  document.getElementById("openNewSubjectBtn").addEventListener("click", () => {
    idTouched = false;
    openNewSubjectDialog();
  });
  idIn.addEventListener("input", () => { idTouched = idIn.value.trim().length > 0; });
  nameIn.addEventListener("input", () => {
    if (!idTouched) idIn.placeholder = slugify(nameIn.value) || "auto-generated";
  });
  document.getElementById("cancelNewSubjectBtn").addEventListener("click", () => dlg.close());
  document.getElementById("cancelNewSubjectX").addEventListener("click", () => dlg.close());

  document.getElementById("newSubjectForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("newSubjError");
    errEl.hidden = true;
    const payload = {
      name: nameIn.value.trim(),
      code: document.getElementById("newSubjCode").value.trim(),
      description: document.getElementById("newSubjDesc").value.trim(),
    };
    if (idIn.value.trim()) payload.id = idIn.value.trim();

    try {
      const created = await apiJson("/api/subjects", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      dlg.close();
      state.generator.preview = null;
      state.generator.error = "";
      state.generator.topicTitle = "";
      await refreshSubjectsList();
      await selectSubject(created.id);
      setActiveTab("materials");
      showToast(`Created subject '${created.name}'. Paste notes or drop PDFs to auto-generate quizzes!`, "success");
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  // Global keyboard shortcuts (Flashcards + Escape for drawer)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!document.getElementById("formulaDrawer").hidden) closeFormulaDrawer();
      return;
    }
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || dlg.open) return;
    if (state.tab !== "study" || state.studySubTab !== "flashcards") return;

    const deck = filteredFlashcards();
    if (!deck.length) return;
    const fc = deck[state.flashcards.index];

    if (e.code === "Space") {
      e.preventDefault();
      state.flashcards.flipped = !state.flashcards.flipped;
      document.getElementById("flashcardCard")?.classList.toggle("is-flipped", state.flashcards.flipped);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      stepFlashcard(-1, deck.length);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      stepFlashcard(1, deck.length);
    } else if (e.key === "1" || e.key === "2" || e.key === "3") {
      e.preventDefault();
      rateFlashcard(fc, parseInt(e.key, 10), deck.length);
    }
  });

  // Load initial data (discover subjects first so static GitHub Pages mode activates before progress read)
  try {
    await refreshSubjectsList();
    const progressData = await apiJson("/api/progress").catch(() => ({ subjects: {} }));
    state.progress = progressData && typeof progressData.subjects === "object"
      ? progressData
      : { subjects: {} };

    const validIds = new Set(state.subjects.map((s) => s.id));
    const initialId = validIds.has(state.activeSubjectId)
      ? state.activeSubjectId
      : (validIds.has("physic") ? "physic" : (state.subjects[0]?.id || ""));

    await selectSubject(initialId);
  } catch (err) {
    document.getElementById("mainContent").innerHTML = `
      <div class="card empty-state">Failed to connect to StudyFlow backend: ${escapeHtml(err.message)}</div>
    `;
  }

  // Re-render math if deferred KaTeX finishes loading slightly after initial render
  window.addEventListener("load", () => {
    if (window.katex && state.tab !== "graph") {
      renderCurrentView();
      renderFormulaDrawerBody();
    }
  });
}

boot();
