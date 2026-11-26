# StudyFlow

Zero-dependency study workspace built with Python 3.11 stdlib (`ThreadingHTTPServer`) and vanilla ES modules + Canvas + KaTeX.

## Running Locally or on GitHub Pages

### Local Server (supports full PDF/file uploads on disk)

1. Ensure Python 3.11+ is installed.
2. Start the local server from this directory:

   ```bash
   python server.py
   ```

   Optional custom port:

   ```bash
   PORT=9000 python server.py
   ```

3. Open **http://127.0.0.1:8765** in your browser. Press `Ctrl+C` in the terminal to stop cleanly.

### GitHub Pages (24/7 phone & laptop access)

1. Push this repo (`https://github.com/breaddme/StudyFlow`) to GitHub (`main` branch).
2. In your GitHub repo, open **Settings → Pages → Build and deployment** and set **Source: Deploy from a branch**, **Branch: `main` / `/ (root)`**.
3. Open **https://breaddme.github.io/StudyFlow/** on your phone or computer — the app automatically detects static hosting, reads `subjects.json` + `<subject>/study.json` + `<subject>/graph.json`, and saves your progress, Mistake Bank, flashcards, custom subjects, and imported JSON study packs in `localStorage`.

## Features

- **Auto-Discovered Subjects**: Each folder directly under the project root (excluding `app`, `graphify-out`, `__pycache__`, `node_modules`, and `.*`/`_*` directories) appears automatically in the Subject Switcher.
- **Dashboard**: Overall mastery, attempt accuracy, topic cards with progress bars, key points, clickable source PDFs, and mock exam history.
- **Topic Quiz**: Filter by topic, difficulty, category, and question count with hints, instant answer checking, worked solutions, and expandable linked formulas.
- **Timed Mock Exam**: Quick presets (`15Q / 20m`, `25Q / 45m`, `Full Final`) or custom coverage, live countdown with auto-submit at `00:00`, question palette, flag-for-review, and a slide-over Formula Sheet Drawer that opens without interrupting the timer.
- **Formulas & Flashcards**:
  - Searchable, topic-filtered **Formula Sheet** with KaTeX rendering and print stylesheet (`Ctrl+P` / Print button).
  - **Active-Recall Flashcards** with 3D flip animation, hints, confidence ratings (`1` Hard, `2` Good, `3` Mastered), and keyboard shortcuts (`Space` flip, `1`/`2`/`3` rate, `←`/`→` navigate).
- **Concept Graph**: Interactive pure-Canvas viewer for Graphify `graph.json` (`nodes` + `links`/`edges`) featuring bounded force-directed layout, God Node rings, community filtering, search, pan/zoom/node-drag, clickable source PDFs, and one-click topic quiz launch.
- **Mistake Bank**: Automatically captures missed questions; answer a question correctly **2 consecutive times** in Mistake Drill (or click *Mark Mastered*) to graduate it.
- **Materials & Data**: Create new subjects, upload study files (`.pdf`, `.md`, `.txt`, `.json`, `.png`, `.jpg`, `.jpeg`, `.webp` up to 50 MB), import/export `study.json` (merge by ID or replace), upload `graph.json`, download a blank template, or add topics/questions/formulas/flashcards inline.

## Adding New Subjects

- **Via UI**: Click **+ New Subject** in the sidebar, enter a name/code/description, and upload PDFs or import a study pack JSON in **Materials & Data**.
- **Via Filesystem**: Create a folder with a lowercase slug (`[a-z0-9_-]{1,48}`, e.g. `calculus2/`), drop your PDFs inside, and optionally add `study.json` and `graph.json`. Reload the browser to see it immediately.

## Progress Persistence

Your quiz stats, mistake bank, flashcard confidence ratings, and mock exam history are stored locally in `progress.json` in the project root.
