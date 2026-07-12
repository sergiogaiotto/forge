---
name: frontend-html-a11y
description: >-
  Robustness and accessibility playbook for generated client-side web UI — plain
  HTML, CSS, JavaScript, Tailwind, and single-page apps. Use whenever the user asks
  for a web page, an HTML/JS interface, a form, a todo/notes app, DOM manipulation,
  localStorage/sessionStorage, or any browser front-end. Covers accessible labels
  (aria), aria-live regions, keyboard focus preservation, safe localStorage, input
  validation, empty states, and XSS-safe rendering.
license: Apache-2.0
metadata:
  author: claro-data-platform
  version: "1.0"
---

# Frontend HTML/JS — robustness & accessibility

Generated client-side UI (a todo app, a form, a small SPA) tends to look right in a
happy-path demo yet break for real users: `localStorage` may hold corrupted or
non-array data, a full innerHTML re-render destroys keyboard focus, inputs ship with
no accessible label, and a live counter is invisible to a screen reader. This skill
encodes a senior front-end playbook so the generated HTML/JS is robust and accessible
by default — not just visually correct.

## When to use

Use this skill when generating or reviewing **client-side** web UI: an HTML page, a
form, a todo/notes app, a Tailwind interface, DOM manipulation code, or anything that
reads/writes `localStorage`. It does **not** apply to server-side data work (pandas,
SQL, scraping) — HTML emitted by a data report is out of scope.

## Rules (apply all that fit)

### 1. localStorage is untrusted input (read + write)
Parse in `try/catch` and validate the shape before use; treat any failure as empty.
Wrap every write too — `setItem` throws on quota-full and in private mode.

```js
// ❌ crashes if the stored value is not valid JSON or not an array
const todos = JSON.parse(localStorage.getItem("todos"));
todos.forEach(render); // TypeError when null / object / string

// ✅ defensive load + guarded save
function loadTodos() {
  try {
    const raw = localStorage.getItem("todos");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : []; // shape guard
  } catch {
    return []; // corrupted / unavailable → empty state
  }
}
function saveTodos(todos) {
  try {
    localStorage.setItem("todos", JSON.stringify(todos));
  } catch {
    /* quota exceeded / private mode: degrade silently, keep the app usable */
  }
}
```

### 2. Every form control needs an accessible label
`<label for>` bound by id, or `aria-label`/`aria-labelledby`. A `placeholder` is **not**
a label. Icon-only buttons need `aria-label`.

```html
<!-- ❌ no label; screen reader announces "edit text, blank" -->
<input type="text" placeholder="New task" />
<button>🗑️</button>

<!-- ✅ -->
<label for="new-task">New task</label>
<input id="new-task" type="text" maxlength="200" />
<button aria-label="Delete task">🗑️</button>
```

### 3. Announce dynamic changes with a live region
A counter, status line, or toast that updates on its own must live in
`aria-live="polite"` (or `role="status"`), otherwise assistive tech never hears it.

```html
<p id="count" role="status" aria-live="polite">3 tasks left</p>
```

### 4. Preserve focus across re-renders
Do **not** rebuild a whole list with `container.innerHTML = ""` on every change — it
destroys keyboard focus and is slow. Update the specific node; if a full re-render is
unavoidable, save and restore focus.

```js
// ❌ focus is lost the moment the list re-renders
list.innerHTML = "";
todos.forEach(t => list.append(renderRow(t)));

// ✅ granular update, or restore focus after a full render
const activeId = document.activeElement?.id;
renderList(todos);
if (activeId) document.getElementById(activeId)?.focus();
```

### 5. Validate input and show an empty state
`maxlength` + `trim()`, ignore empty submissions, and render an explicit empty-state
instead of a blank container.

```js
const value = input.value.trim();
if (!value) return;                 // ignore empty
todos.push({ id: crypto.randomUUID(), text: value.slice(0, 200) });
list.replaceChildren(
  todos.length ? renderRows(todos) : emptyState("No tasks yet — add one above.")
);
```

### 6. Render user text XSS-safe
Never interpolate user input into `innerHTML`. Use `textContent` or `createElement`.

```js
// ❌ stored XSS
row.innerHTML = `<span>${todo.text}</span>`;
// ✅
const span = document.createElement("span");
span.textContent = todo.text;
row.append(span);
```

## Common errors to avoid
- `JSON.parse(localStorage.getItem(...))` with no try/catch and no `Array.isArray` guard.
- `placeholder` used as the only label; icon buttons with no `aria-label`.
- A visible counter/status with no `aria-live`/`role="status"`.
- `container.innerHTML = ""` (or `innerHTML +=`) inside a re-render loop.
- Interpolating user text into `innerHTML`.
- No `maxlength`, no `trim()`, no empty-state.
