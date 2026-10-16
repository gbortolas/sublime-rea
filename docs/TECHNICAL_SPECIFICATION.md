# TECHNICAL SPECIFICATION: Clean-Room Reverse Engineering & High-Performance Text Editor Architecture

## 1. Project Overview & Meta Information
- **Project Name:** Arcane / High-Performance Electron Text Editor Core
- **Repository / Reference Tooling:** REA (Reverse Engineering Agent)
  - **GitHub URL:** https://github.com/morluto/rea
- **Scope:** Academic Research & Clean-Room Architectural Re-implementation
- **Target Analysis Binary:** Sublime Text Executable (C/C++ Native Binary)
- **Target Implementation Stack:** Electron (TypeScript / Node.js) + WebGPU/Canvas + Worker Threads

---

## 2. System Architecture & Methodology

### 2.1 Clean-Room Reverse Engineering Workflow

[Sublime Text Binary]
│
▼
[Ghidra (Headless)] ◄─── (MCP Protocol) ───► [REA Agent / PyCharm Local AI]
│
▼
[Abstract Technical Spec]
│
▼
[Electron + TypeScript Core Code]


1. **Isolation Layer:** The AI agent uses REA via Model Context Protocol (MCP) to query Ghidra for control flow graphs, call graphs, and decompiled C pseudocode.
2. **Abstraction Layer:** Extract high-level structural patterns, data structures, and thread interaction logic without copying raw assembly or hex bytes.
3. **Re-implementation Layer:** Rebuild the equivalent capabilities from scratch using modern Web & Node.js primitives.

---

## 3. Core Engine Components & Technical Requirements

### 3.1 Text Buffer Data Structure (Memory Layer)
- **Objective:** Evaluate native memory management vs. JavaScript V8 Engine constraints.
- **Investigation Focus (Sublime):**
  - Verify use of **Piece Table**, **Gap Buffer**, or **Rope** for $O(1)$ / $O(\log N)$ text mutation and line indexing.
  - Undo/Redo history stack memory footprint optimization.
- **Electron / TS Target Spec:**
  - Implement a zero-copy or minimal-copy **Piece Table** or **Rope** data structure in TypeScript.
  - Offload buffer operations and large string mutations to **Node.js Worker Threads** (`worker_threads`) to keep the main V8 event loop completely unblocked.

### 3.2 Threading & Concurrency Model
- **Sublime Model:**
  - Main Thread: OS Event Loop, Window management, immediate UI rendering.
  - Background Threads: File I/O, regex searching, syntax highlighting tree parsing, workspace indexing.
- **Electron Target Architecture:**
  - **Main Process (Node.js):** Window lifecycle, native menus, OS level file system bridge.
  - **Renderer Process (Chromium):** UI presentation layer.
  - **Worker Threads / Web Workers:** Off-main-thread syntax tokenization, diffing, and buffer tree recalculations.

### 3.3 UI Rendering Pipeline
- **Sublime Model:** Direct GPU drawing loop (OpenGL/DirectX/Skia) bypassing traditional OS widget toolkits.
- **Electron Target Architecture:**
  - Avoid heavy HTML/DOM nodes per line/character (prevents DOM layout thrashing and high garbage collection overhead).
  - Use **HTML5 Canvas 2D API** or **WebGPU** for viewport rendering.
  - Virtualized scrolling mechanism: render strictly the visible window (lines $K$ to $K + N$).

### 3.4 Extension & IPC Bridge
- **Sublime Model:** C++ Core driving embedded Python interpreter runtime.
- **Electron Target Architecture:**
  - Node.js IPC / Worker communication protocol for extension isolation.
  - Expose a strongly typed API (TypeScript Interfaces) for plugin hooks.

### 3.5 Implementation Status (evidence, updated 2026-10-16)

Maps the §3.1–§3.4 targets onto delivered Phase 1 evidence. Labelling follows the repo convention:
`[OBSERVADO]` / `[INFERIDO]` / `[DESCONHECIDO]`.

- **§3.1 Text Buffer** — ✅ evidenced in [`analysis/buffer-structure.md`](analysis/buffer-structure.md):
  a `TextBuffer` facade over an internal segmented / piece-table-like store `[INFERIDO]` (≈2.4 KB
  facade, `0x108`-byte anonymous internal object); edges applied as delta commands
  (`insert_command`/`…_delete_command`); undo grouped (*glue*/*soft*); **no** named Gap Buffer or Rope.
- **§3.2 Threading & Concurrency** — ✅ evidenced in [`analysis/concurrency.md`](analysis/concurrency.md):
  a single **GTK3/GLib** main thread (`gtk_main`); an own POSIX thread factory (`pthread_create`,
  2 MiB stack, `prctl(PR_SET_NAME)`); an N-thread **I/O pool** (`io_worker`) plus an on-demand pool
  capped at 2 (`file_read_thread`); results marshalled back to the main thread via
  `px_main_thread_scheduler`.
- **§3.3 UI Rendering Pipeline** — 🟡 **correction to the model**: the toolkit is **GTK3/GLib**
  (NEEDED: `libglib-2.0`, `libgobject-2.0`, `libGL`, `libX11`; strings `gtk_main` / `g_idle_add` /
  `g_source_add_unix_fd`; **zero** Qt), i.e. **not** "bypassing traditional OS widget toolkits" as the
  original bullet states. Rendering is likely **Skia/GPU** via `libGL` — pending **P1.4**.
- **§3.4 Extension & IPC Bridge** — 🟡 transport evidenced
  ([`analysis/api-python.md`](analysis/api-python.md), [`analysis/ipc-plugin-host.md`](analysis/ipc-plugin-host.md)):
  the Python host is a **separate process** (`posix_spawn`/`execvp` + POSIX shm + semaphores), **not** a
  thread. Opcodes/framing still open (**P1.3**).
- **Phase 2 (P2.1) — abstract spec** — ✅ delivered in [`architecture/`](architecture/) (README + 6
  docs, **61 `DEC-*` decisions**): every §3.1–§3.4 target is translated into an Electron/TypeScript
  decision with the evidence IDs that support it, plus explicitly marked divergences. The transport is
  now fully evidenced (framing `[uint32 len]` + numeric dispatch) in
  [`analysis/ipc-protocol.md`](analysis/ipc-protocol.md).

Living index → [`BACKLOG.md`](BACKLOG.md); session protocol → [`../AGENTS.md`](../AGENTS.md).

---

## 4. Setup & Integration Instructions for REA Server

### 4.1 Environment Check
Verify native decompiler and REA server status:
```bash
npx rea-agents@latest setup
rea readiness


4.2 Agent Prompting Guidelines
When instructing the local AI agent during analysis sessions:

Never ask for full code pastes of decompiled routines.

Ask for structural explanations: e.g., "Use REA to trace functions handling file buffer allocations in Sublime Text and explain the memory layout abstractly."

Convert insights to TypeScript contracts: Translate C/C++ struct findings into TypeScript interfaces or class designs for the Electron engine.

5. Compliance & Clean-Room Boundaries
No Direct Copying: No decompiled C/C++ code snippets may be included in the target Electron repository.

Functional Equivalence: The target implementation should mirror architectural efficiency and high-level design concepts while using idiomatic TypeScript / Node.js idioms.