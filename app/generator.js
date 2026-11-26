/**
 * Auto-generator for StudyFlow study packs (topics, formulas, flashcards, MCQs).
 * Supports Gemini API (PDFs, images, text notes) + zero-dependency Offline Smart Note Parser.
 */

const GEMINI_KEY_STORAGE = "studyflow.geminiKey";
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash"];
const MAX_AI_FILE_BYTES = 15 * 1024 * 1024; // 15 MB inlineData ceiling

export function getSavedApiKey() {
  try {
    return localStorage.getItem(GEMINI_KEY_STORAGE) || "";
  } catch {
    return "";
  }
}

export function saveApiKey(key) {
  try {
    const clean = String(key || "").trim();
    if (clean) {
      localStorage.setItem(GEMINI_KEY_STORAGE, clean);
    } else {
      localStorage.removeItem(GEMINI_KEY_STORAGE);
    }
  } catch {
    // Ignore storage restriction
  }
}

function slugifyId(str) {
  return String(str || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 40) || `topic-${Date.now().toString(36)}`;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function inferMimeType(file) {
  if (file.type) return file.type;
  const lower = (file.name || "").toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "text/plain";
}

function isTextFile(file) {
  const lower = (file.name || "").toLowerCase();
  return (
    lower.endsWith(".md") ||
    lower.endsWith(".txt") ||
    lower.endsWith(".csv") ||
    lower.endsWith(".json") ||
    (file.type && file.type.startsWith("text/"))
  );
}

function isMediaOrPdf(file) {
  const mime = inferMimeType(file);
  return mime === "application/pdf" || mime.startsWith("image/");
}

function normalizeGeneratedPack(raw, fallbackTitle, sourceFiles, engine) {
  const stamp = Date.now().toString(36);
  const rawTopic = raw?.topic && typeof raw.topic === "object"
    ? raw.topic
    : Array.isArray(raw?.topics) && raw.topics[0]
      ? raw.topics[0]
      : {};

  const title = String(rawTopic.title || fallbackTitle || "Generated Study Module").trim();
  const topicId = slugifyId(rawTopic.id || title) + `-${stamp.slice(-4)}`;
  const code = String(rawTopic.code || title.slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, "") || "MOD").trim();

  const topic = {
    id: topicId,
    code,
    title,
    summary: String(rawTopic.summary || `Auto-generated study module for ${title}.`).trim(),
    sourceFiles: Array.isArray(rawTopic.sourceFiles) && rawTopic.sourceFiles.length
      ? rawTopic.sourceFiles.map((s) => String(s))
      : sourceFiles,
    keyPoints: Array.isArray(rawTopic.keyPoints)
      ? rawTopic.keyPoints.map((k) => String(k).trim()).filter(Boolean)
      : [],
  };

  const seenF = new Set();
  const formulas = (Array.isArray(raw?.formulas) ? raw.formulas : [])
    .filter((f) => f && (f.latex || f.name))
    .map((f, idx) => {
      let id = String(f.id || `f-${topicId}-${idx + 1}`).trim();
      if (seenF.has(id)) id = `${id}-${stamp}-${idx}`;
      seenF.add(id);
      return {
        id,
        topicId,
        name: String(f.name || `Formula ${idx + 1}`).trim(),
        latex: String(f.latex || "").trim().replace(/^\$\$?|\$\$?$/g, ""),
        variables: String(f.variables || "").trim(),
        whenToUse: String(f.whenToUse || "").trim(),
        pitfall: String(f.pitfall || "").trim(),
      };
    });

  const seenFc = new Set();
  const flashcards = (Array.isArray(raw?.flashcards) ? raw.flashcards : [])
    .filter((fc) => fc && fc.front && fc.back)
    .map((fc, idx) => {
      let id = String(fc.id || `fc-${topicId}-${idx + 1}`).trim();
      if (seenFc.has(id)) id = `${id}-${stamp}-${idx}`;
      seenFc.add(id);
      return {
        id,
        topicId,
        front: String(fc.front).trim(),
        back: String(fc.back).trim(),
        hint: String(fc.hint || "").trim(),
      };
    });

  const seenQ = new Set();
  const validDiff = new Set(["easy", "medium", "hard"]);
  const validCat = new Set(["conceptual", "calculation"]);
  const questions = (Array.isArray(raw?.questions) ? raw.questions : [])
    .filter((q) => q && q.prompt && Array.isArray(q.choices) && q.choices.length >= 2)
    .map((q, idx) => {
      let id = String(q.id || `q-${topicId}-${idx + 1}`).trim();
      if (seenQ.has(id)) id = `${id}-${stamp}-${idx}`;
      seenQ.add(id);
      const choices = q.choices.slice(0, 4).map((c) => String(c).trim());
      while (choices.length < 4) choices.push("None of the above");
      const rawAns = Number.parseInt(q.answerIndex, 10);
      const answerIndex = Number.isFinite(rawAns) && rawAns >= 0 && rawAns < 4 ? rawAns : 0;
      const diff = validDiff.has(String(q.difficulty || "").toLowerCase())
        ? String(q.difficulty).toLowerCase()
        : "medium";
      const cat = validCat.has(String(q.category || "").toLowerCase())
        ? String(q.category).toLowerCase()
        : "conceptual";

      return {
        id,
        topicId,
        type: "mcq",
        difficulty: diff,
        category: cat,
        sourceFile: String(q.sourceFile || sourceFiles[0] || "").trim(),
        prompt: String(q.prompt).trim(),
        choices,
        answerIndex,
        hint: String(q.hint || "Review the core definition and equations for this topic.").trim(),
        solution: String(q.solution || `The correct option is **${choices[answerIndex]}**.`).trim(),
        formulaIds: Array.isArray(q.formulaIds)
          ? q.formulaIds.filter((fid) => seenF.has(String(fid)))
          : [],
      };
    });

  return { topic, formulas, flashcards, questions, engine };
}

function buildGeminiPrompt({ subjectName, topicTitle, questionCount, examStyle, language, sourceNames }) {
  const langRule = language === "thai"
    ? "Write all titles, prompts, choices, hints, solutions, and flashcards in natural Thai (keep standard scientific symbols and LaTeX equations in $...$)."
    : language === "english"
      ? "Write everything in clear academic English."
      : "Match the primary language of the provided study material (English or Thai).";

  const styleRule = examStyle === "conceptual"
    ? "Focus ~75% on conceptual understanding, principles, comparisons, and pitfalls, and ~25% on calculations."
    : examStyle === "calculation"
      ? "Focus ~75% on multi-step quantitative/calculation exam problems (verify every numerical computation carefully) and ~25% on conceptual questions."
      : "Provide a balanced mix (~50% conceptual, ~50% calculation/application) across easy, medium, and hard difficulty.";

  return `You are an expert university exam tutor creating final-exam prep materials for the course "${subjectName}".
Analyze the attached files and/or lecture notes carefully and return ONLY valid JSON matching the exact schema below.

Target Topic: ${topicTitle ? `"${topicTitle}"` : "Infer a concise chapter/topic title from the material"}
Source Files: ${sourceNames.length ? sourceNames.join(", ") : "User lecture notes"}
Target Questions: ${questionCount} high-yield 4-choice MCQs
Style: ${styleRule}
Language: ${langRule}

Math & Formatting Rules:
- Wrap inline math in $...$ (e.g. $F = ma$, $1\\text{ Pa}$). Never leave bare LaTeX commands outside $...$.
- In formulas[].latex, put pure LaTeX WITHOUT outer $ delimiters.
- Double-check ALL arithmetic in solutions so answerIndex (0..3) matches the exact verified choice.
- Also generate 5-12 key formulas (if the subject has equations/laws) and 8-15 active-recall flashcards.

Exact JSON Schema:
{
  "topic": {
    "id": "short-slug",
    "code": "CH1",
    "title": "Chapter Title",
    "summary": "2-3 sentence exam-focused summary",
    "sourceFiles": ${JSON.stringify(sourceNames)},
    "keyPoints": ["bullet 1", "bullet 2"]
  },
  "formulas": [
    {
      "id": "f-1",
      "name": "Formula Name",
      "latex": "E = mc^2",
      "variables": "$E$: energy ($\\text{J}$), $m$: mass ($\\text{kg}$)",
      "whenToUse": "When to apply this law",
      "pitfall": "Common exam mistake"
    }
  ],
  "flashcards": [
    {
      "id": "fc-1",
      "front": "Question or concept prompt",
      "back": "Concise accurate answer",
      "hint": "Memory cue"
    }
  ],
  "questions": [
    {
      "id": "q-1",
      "difficulty": "easy|medium|hard",
      "category": "conceptual|calculation",
      "sourceFile": "${sourceNames[0] || ""}",
      "prompt": "Exam question stem",
      "choices": ["Choice A", "Choice B", "Choice C", "Choice D"],
      "answerIndex": 0,
      "hint": "Helpful hint without spoiling answer",
      "solution": "Step-by-step worked solution",
      "formulaIds": ["f-1"]
    }
  ]
}`;
}

export async function generateWithGemini({
  apiKey,
  files = [],
  notesText = "",
  subjectName = "New Subject",
  topicTitle = "",
  questionCount = 15,
  examStyle = "balanced",
  language = "auto",
}) {
  const cleanKey = String(apiKey || "").trim();
  if (!cleanKey) {
    throw new Error("Enter your Gemini API key (or switch to Offline Note Parser).");
  }
  const cleanNotes = String(notesText || "").trim();
  if (!files.length && !cleanNotes) {
    throw new Error("Upload at least one file (PDF, image, Markdown, text) or paste lecture notes.");
  }

  const parts = [];
  const sourceNames = [];

  for (const file of files) {
    sourceNames.push(file.name);
    if (isTextFile(file)) {
      const txt = await file.text();
      parts.push({ text: `\n--- File: ${file.name} ---\n${txt.slice(0, 120000)}\n` });
    } else if (isMediaOrPdf(file)) {
      if (file.size > MAX_AI_FILE_BYTES) {
        throw new Error(`'${file.name}' is ${(file.size / (1024 * 1024)).toFixed(1)} MB; max for browser Gemini upload is 15 MB.`);
      }
      const buf = await file.arrayBuffer();
      parts.push({
        inlineData: {
          mimeType: inferMimeType(file),
          data: arrayBufferToBase64(buf),
        },
      });
    }
  }

  if (cleanNotes) {
    parts.push({ text: `\n--- Lecture Notes ---\n${cleanNotes.slice(0, 120000)}\n` });
  }

  parts.push({
    text: buildGeminiPrompt({
      subjectName,
      topicTitle,
      questionCount: Math.max(5, Math.min(35, Number(questionCount) || 15)),
      examStyle,
      language,
      sourceNames,
    }),
  });

  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cleanKey)}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.35,
        },
      }),
    });

    if (res.status === 404) {
      lastErr = new Error(`Model ${model} unavailable.`);
      continue;
    }

    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = payload?.error?.message || `Gemini API error (${res.status})`;
      throw new Error(msg);
    }

    const rawText = payload?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join("\n")
      .trim();
    if (!rawText) {
      throw new Error("Gemini returned an empty response. Try adding more clear notes or smaller PDFs.");
    }

    const cleanedJson = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleanedJson);
    } catch {
      throw new Error("Could not parse structured JSON from Gemini output. Please retry.");
    }

    const pack = normalizeGeneratedPack(parsed, topicTitle || subjectName, sourceNames, `gemini (${model})`);
    if (!pack.questions.length) {
      throw new Error("Gemini output contained 0 valid questions. Try providing more source material.");
    }
    return pack;
  }

  throw lastErr || new Error("Gemini API request failed.");
}

// --- Offline Smart Note Parser (zero external dependencies) ---

function pickDistractors(correctText, pool, fallbackLabel) {
  const unique = [];
  const normCorrect = correctText.toLowerCase();
  for (const candidate of pool) {
    const c = String(candidate || "").trim();
    if (!c || c.toLowerCase() === normCorrect) continue;
    if (!unique.some((u) => u.toLowerCase() === c.toLowerCase())) {
      unique.push(c);
    }
    if (unique.length >= 3) break;
  }
  const genericFallbacks = [
    `It remains invariant regardless of ${fallbackLabel || "system conditions"}.`,
    "It applies only in an ideal vacuum at absolute zero.",
    "It is inversely proportional to the squared input parameter.",
    "None of the other relationships hold under standard conditions.",
  ];
  for (const g of genericFallbacks) {
    if (unique.length >= 3) break;
    if (g.toLowerCase() !== normCorrect && !unique.includes(g)) {
      unique.push(g);
    }
  }
  return unique.slice(0, 3);
}

function deterministicShuffleChoices(correct, distractors, seedIdx) {
  const items = [
    { text: correct, isCorrect: true },
    ...distractors.slice(0, 3).map((d) => ({ text: d, isCorrect: false })),
  ];
  const shift = seedIdx % items.length;
  const rotated = [...items.slice(shift), ...items.slice(0, shift)];
  const answerIndex = rotated.findIndex((x) => x.isCorrect);
  return {
    choices: rotated.map((x) => x.text),
    answerIndex: answerIndex >= 0 ? answerIndex : 0,
  };
}

export async function generateOfflineFromNotes({
  files = [],
  notesText = "",
  subjectName = "New Subject",
  topicTitle = "",
  questionCount = 15,
}) {
  const chunks = [];
  const sourceNames = [];
  let sawBinaryPdf = false;

  for (const file of files) {
    sourceNames.push(file.name);
    if (isTextFile(file)) {
      chunks.push(await file.text());
    } else if ((file.name || "").toLowerCase().endsWith(".pdf") || (file.type || "").startsWith("image/")) {
      sawBinaryPdf = true;
    }
  }

  if (String(notesText || "").trim()) {
    chunks.push(String(notesText).trim());
  }

  const combined = chunks.join("\n\n").trim();
  if (!combined) {
    if (sawBinaryPdf) {
      throw new Error("Offline Parser reads .md/.txt or pasted text notes. Switch to 'AI Generator (Gemini)' above to generate directly from PDFs/images.");
    }
    throw new Error("Paste lecture notes or upload a .md/.txt file first.");
  }

  const lines = combined.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const headings = [];
  const keyPoints = [];
  const termPairs = [];
  const qaPairs = [];
  const formulaItems = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Headings
    const hMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (hMatch) {
      headings.push(hMatch[1].trim());
      continue;
    }

    // Q: / A: blocks
    const qMatch = line.match(/^(?:Q|Question)\s*[:\-]\s*(.+)$/i);
    if (qMatch && lines[i + 1]) {
      const aMatch = lines[i + 1].match(/^(?:A|Answer)\s*[:\-]\s*(.+)$/i);
      if (aMatch) {
        qaPairs.push({ q: qMatch[1].trim(), a: aMatch[1].trim() });
        i += 1;
        continue;
      }
    }

    const cleanBullet = line.replace(/^[-*•\d.)]+\s+/, "");

    // Term: Definition or **Term** - Definition
    const tdMatch = cleanBullet.match(/^\*{0,2}([^:*]{2,60}?)\*{0,2}\s*(?::|—|–|\s-\s)\s*(.{8,260})$/);
    if (tdMatch && !/^https?$/i.test(tdMatch[1].trim())) {
      const term = tdMatch[1].trim();
      const def = tdMatch[2].trim();
      termPairs.push({ term, def });
      keyPoints.push(cleanBullet);
      // Extract inline equation if present inside definition
      const mathHit = def.match(/\$([^$\n]{3,80})\$/);
      if (mathHit) {
        formulaItems.push({ name: term, latex: mathHit[1].trim(), context: def });
      } else if (/^[A-Za-z_\\][A-Za-z0-9_()\s+\-*/^\\]{0,28}=\s*[^=]{2,45}$/.test(def)) {
        formulaItems.push({ name: term, latex: def.replace(/\$/g, ""), context: `${term}: ${def}` });
      }
      continue;
    }

    // Standalone equation line (e.g. `Formula: ...` or `$...$` or `PV = nRT`)
    const standaloneMath = cleanBullet.match(/^\$\$(.+)\$\$$/) || cleanBullet.match(/^\$(.+)\$$/);
    if (standaloneMath) {
      formulaItems.push({
        name: headings[headings.length - 1] || `Equation ${formulaItems.length + 1}`,
        latex: standaloneMath[1].trim(),
        context: cleanBullet,
      });
      continue;
    }

    if (cleanBullet.length >= 16) {
      keyPoints.push(cleanBullet);
    }
  }

  const inferredTitle = topicTitle.trim() || headings[0] || subjectName || "Study Notes";
  const flashcards = [];
  const questions = [];

  // Build flashcards from Q/A and Term/Def
  for (const qa of qaPairs) {
    flashcards.push({ front: qa.q, back: qa.a, hint: inferredTitle });
  }
  for (const tp of termPairs) {
    flashcards.push({ front: `Define / explain: **${tp.term}**`, back: tp.def, hint: `Key concept in ${inferredTitle}` });
  }
  if (!flashcards.length) {
    keyPoints.slice(0, 10).forEach((kp, idx) => {
      flashcards.push({
        front: `Key takeaway #${idx + 1} in ${inferredTitle}?`,
        back: kp,
        hint: headings[0] || inferredTitle,
      });
    });
  }

  // Build formulas
  const formulas = formulaItems.slice(0, 14).map((f, idx) => ({
    id: `f-off-${idx + 1}`,
    name: f.name,
    latex: f.latex,
    variables: f.context,
    whenToUse: `Extracted from ${inferredTitle}`,
    pitfall: "Check units and sign conventions before substituting values.",
  }));

  const targetQ = Math.max(4, Math.min(30, Number(questionCount) || 15));
  const defPool = termPairs.map((t) => t.def);
  const termPool = termPairs.map((t) => t.term);
  const ansPool = qaPairs.map((x) => x.a);
  const formulaPool = formulas.map((f) => `$${f.latex}$`);

  // 1) Q/A MCQs
  qaPairs.forEach((qa, idx) => {
    if (questions.length >= targetQ) return;
    const dist = pickDistractors(qa.a, [...ansPool, ...defPool], qa.q);
    const { choices, answerIndex } = deterministicShuffleChoices(qa.a, dist, idx);
    questions.push({
      difficulty: "medium",
      category: "conceptual",
      prompt: qa.q,
      choices,
      answerIndex,
      hint: `Recall core notes from ${inferredTitle}.`,
      solution: `From your notes: **${qa.a}**.`,
    });
  });

  // 2) Term -> Definition MCQs
  termPairs.forEach((tp, idx) => {
    if (questions.length >= targetQ) return;
    const dist = pickDistractors(tp.def, defPool, tp.term);
    const { choices, answerIndex } = deterministicShuffleChoices(tp.def, dist, idx + 1);
    questions.push({
      difficulty: "easy",
      category: "conceptual",
      prompt: `Which statement best describes **${tp.term}**?`,
      choices,
      answerIndex,
      hint: `Think about how ${tp.term} operates within ${inferredTitle}.`,
      solution: `**${tp.term}**: ${tp.def}`,
    });
  });

  // 3) Reverse Definition -> Term MCQs
  if (termPairs.length >= 2) {
    termPairs.forEach((tp, idx) => {
      if (questions.length >= targetQ) return;
      const dist = pickDistractors(tp.term, termPool, inferredTitle);
      const { choices, answerIndex } = deterministicShuffleChoices(tp.term, dist, idx + 2);
      questions.push({
        difficulty: "medium",
        category: "conceptual",
        prompt: `Which concept corresponds to the following description: "${tp.def}"?`,
        choices,
        answerIndex,
        hint: `Starts with "${tp.term.slice(0, 2)}…"`,
        solution: `The matching term is **${tp.term}**: ${tp.def}`,
      });
    });
  }

  // 4) Formula MCQs
  formulas.forEach((f, idx) => {
    if (questions.length >= targetQ) return;
    const correctExpr = `$${f.latex}$`;
    const dist = pickDistractors(correctExpr, formulaPool, f.name);
    const { choices, answerIndex } = deterministicShuffleChoices(correctExpr, dist, idx + 3);
    questions.push({
      difficulty: "medium",
      category: "calculation",
      prompt: `Which equation correctly represents **${f.name}**?`,
      choices,
      answerIndex,
      hint: `Check the variables in ${f.name}.`,
      solution: `**${f.name}** is given by $${f.latex}$.`,
      formulaIds: [f.id],
    });
  });

  // 5) Cloze / Concept Key-Point MCQs to fill up to targetQ
  const rawSentences = combined
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[-*•#\d.)\s]+/, "").trim())
    .filter((s) => s.length >= 30 && s.length <= 200);

  const wordCandidates = Array.from(
    new Set(
      combined
        .replace(/\$[^$]*\$/g, " ")
        .match(/\b[A-Za-z][A-Za-z0-9-]{4,18}\b/g) || []
    )
  ).filter((w) => !/^(about|which|there|their|where|these|those|while|under|using|between|because|through)$/i.test(w));

  for (let i = 0; i < rawSentences.length && questions.length < targetQ; i += 1) {
    const sent = rawSentences[i];
    const words = (sent.match(/\b[A-Za-z][A-Za-z0-9-]{4,18}\b/g) || [])
      .filter((w) => !/^(about|which|there|their|where|these|those|while|under|using|between)$/i.test(w));
    if (!words.length) continue;
    const targetWord = words[Math.floor(words.length / 2)];
    const blanked = sent.replace(new RegExp(`\\b${targetWord}\\b`), "______");
    if (blanked === sent) continue;
    const dist = pickDistractors(targetWord, wordCandidates, inferredTitle);
    const { choices, answerIndex } = deterministicShuffleChoices(targetWord, dist, i);
    questions.push({
      difficulty: "hard",
      category: "conceptual",
      prompt: `Complete the statement from ${inferredTitle}: "${blanked}"`,
      choices,
      answerIndex,
      hint: `Term length is ${targetWord.length} letters.`,
      solution: `The missing term is **${targetWord}**: "${sent}"`,
    });
  }

  if (!questions.length) {
    throw new Error("Your notes were too short to parse into questions. Paste at least a few sentences, bullet points, or `Term: Definition` lines.");
  }

  return normalizeGeneratedPack(
    {
      topic: {
        title: inferredTitle,
        summary: `Parsed from ${sourceNames.length ? sourceNames.join(", ") : "study notes"} (${questions.length} auto-generated questions, ${formulas.length} formulas, ${flashcards.length} flashcards).`,
        sourceFiles: sourceNames,
        keyPoints: keyPoints.slice(0, 12),
      },
      formulas,
      flashcards,
      questions,
    },
    inferredTitle,
    sourceNames,
    "offline"
  );
}
