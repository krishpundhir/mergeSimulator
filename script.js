/* In-place merge visualizer (dynamic version).
   One array, no temporary array. The learner supplies the array, the variables and
   every step. Each step is stored as an explicit state, so Previous and Next are
   deterministic: going back restores the exact stored state, never a recomputation. */

'use strict';

/* ------------------------------------------------------------------ */
/* Constants and runtime data                                         */
/* ------------------------------------------------------------------ */

const POINTER_ORDER = ['left', 'i', 'mid', 'right'];
const VAR_ORDER = ['left', 'mid', 'i', 'right', 'count'];
const FIXED_POINTERS = new Set(['mid', 'right']);
const MAX_N = 12;

let n = 0;                 // array length
let values = [];           // token id -> number (tokens keep their identity, so duplicates work)
let origin = [];           // token id -> css class describing where it started
let setup = null;          // {left, mid, right, i, count}
let states = [];           // states[0] is the setup, states[k] the result of step k
let currentStep = 0;
let busy = false;
let displayed = [];        // array of token ids currently on screen
let geo = {};
let pendingResize = false;

/* ------------------------------------------------------------------ */
/* DOM helpers                                                        */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const viz = $('viz'), board = $('board'), track = $('track'), indicesEl = $('indices');
const pointersEl = $('pointers'), bracketsEl = $('brackets');
const prevBtn = $('prevBtn'), nextBtn = $('nextBtn');

const cells = [];          // token id -> cell element
const idxEls = [];
let ptrEls = {};

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const SPEED = reduceMotion ? 0.3 : 1;
const wait = (ms) => new Promise((r) => setTimeout(r, ms * SPEED));

const valsOf = (s) => ({ ...s.ptr, count: s.count });
const valueAt = (arr, idx) => values[arr[idx]];

/* ------------------------------------------------------------------ */
/* Setup form                                                         */
/* ------------------------------------------------------------------ */

let iTouched = false;
$('iInput').addEventListener('input', () => { iTouched = true; });
$('midInput').addEventListener('input', () => {
  const m = Number($('midInput').value);
  if (!iTouched && Number.isInteger(m)) $('iInput').value = m + 1;
});

$('exampleBtn').addEventListener('click', () => {
  $('arrInput').value = '-2, 1, 6, 7, 8, -9, -1, 0, 3, 5';
  $('leftInput').value = 0; $('midInput').value = 4; $('rightInput').value = 9;
  $('iInput').value = 5; $('countInput').value = 0;
  iTouched = false;
  setMsg($('setupMsg'), '');
});

function setMsg(node, text, warn) {
  node.textContent = text;
  node.classList.toggle('warn', !!warn);
}

function readInt(id, label) {
  const raw = $(id).value.trim();
  const v = Number(raw);
  if (raw === '' || !Number.isInteger(v)) throw new Error(`${label} must be a whole number.`);
  return v;
}

function parseSetup() {
  const parts = $('arrInput').value.split(/[\s,]+/).filter(Boolean);
  if (parts.length < 2 || parts.length > MAX_N) throw new Error(`Enter between 2 and ${MAX_N} numbers.`);
  const arr = parts.map(Number);
  if (arr.some((x) => !Number.isFinite(x))) throw new Error('The array may only contain numbers separated by commas.');
  if (parts.some((p) => p.length > 5)) throw new Error('Keep each number to 5 characters or fewer so it fits in a box.');

  const len = arr.length;
  const left = readInt('leftInput', 'left');
  const mid = readInt('midInput', 'mid');
  const right = readInt('rightInput', 'right');
  const i = readInt('iInput', 'i');
  const count = readInt('countInput', 'count');

  if (left < 0 || left > mid) throw new Error('Need 0 ≤ left ≤ mid.');
  if (mid >= right) throw new Error('Need mid < right.');
  if (right > len - 1) throw new Error(`right can be at most ${len - 1} for this array.`);
  if (i < -1 || i > len) throw new Error(`i must be between -1 and ${len}.`);

  const sorted = (a, b) => { for (let k = a; k < b; k++) if (arr[k] > arr[k + 1]) return false; return true; };
  const warn = [];
  if (!sorted(left, mid)) warn.push(`arr[${left}..${mid}] is not sorted.`);
  if (!sorted(mid + 1, right)) warn.push(`arr[${mid + 1}..${right}] is not sorted.`);

  return { arr, left, mid, right, i, count, warn };
}

$('startBtn').addEventListener('click', () => {
  let p;
  try { p = parseSetup(); } catch (e) { setMsg($('setupMsg'), e.message); return; }
  setMsg($('setupMsg'), p.warn.length ? p.warn.join(' ') + ' The visualization still works.' : '', true);
  startVisualization(p);
});

$('editSetupBtn').addEventListener('click', () => {
  if (busy) return;
  $('setupForm').hidden = false;
  $('setupSummary').hidden = true;
  $('workspace').hidden = true;
});

/* ------------------------------------------------------------------ */
/* Step builder: reading, validating, applying                        */
/* ------------------------------------------------------------------ */

function addSwapRow(a = '', b = '') {
  const row = el('div', 'row');
  const ia = el('input'); ia.type = 'number'; ia.value = a; ia.setAttribute('aria-label', 'First index');
  const ib = el('input'); ib.type = 'number'; ib.value = b; ib.setAttribute('aria-label', 'Second index');
  const x = el('button', 'x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Remove swap');
  x.addEventListener('click', () => row.remove());
  row.append(el('code', '', 'swap(arr['), ia, el('code', '', '], arr['), ib, el('code', '', '])'), x);
  $('swapRows').appendChild(row);
}

function addSetRow(name = 'left', expr = '') {
  const row = el('div', 'row');
  const sel = el('select');
  VAR_ORDER.forEach((v) => { const o = el('option', '', v); o.value = v; sel.appendChild(o); });
  sel.value = name;
  sel.setAttribute('aria-label', 'Variable');
  const inp = el('input'); inp.type = 'text'; inp.value = expr; inp.placeholder = 'e.g. left + 1';
  inp.setAttribute('aria-label', 'New value');
  const x = el('button', 'x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Remove change');
  x.addEventListener('click', () => row.remove());
  row.append(sel, el('code', '', '='), inp, x);
  $('setRows').appendChild(row);
}

$('addSwapBtn').addEventListener('click', () => addSwapRow());
$('addSetBtn').addEventListener('click', () => addSetRow());

function fillBuilder(raw) {
  $('swapRows').replaceChildren();
  $('setRows').replaceChildren();
  $('cmpA').value = raw && raw.compare ? raw.compare.a : '';
  $('cmpB').value = raw && raw.compare ? raw.compare.b : '';
  $('whyInput').value = raw ? raw.why : '';
  if (raw && raw.swaps.length) raw.swaps.forEach(([a, b]) => addSwapRow(a, b)); else addSwapRow();
  if (raw && raw.sets.length) raw.sets.forEach((s) => addSetRow(s.name, s.expr)); else addSetRow();
  setMsg($('builderError'), '');
}

function parseIndex(text, label) {
  const v = Number(text);
  if (text.trim() === '' || !Number.isInteger(v) || v < 0 || v >= n) {
    throw new Error(`${label} must be a whole number from 0 to ${n - 1}.`);
  }
  return v;
}

function readBuilder() {
  const raw = { compare: null, swaps: [], sets: [], why: $('whyInput').value.trim() };

  const ca = $('cmpA').value.trim(), cb = $('cmpB').value.trim();
  if (ca !== '' || cb !== '') {
    raw.compare = { a: parseIndex(ca, 'Comparison index'), b: parseIndex(cb, 'Comparison index') };
  }

  [...$('swapRows').children].forEach((row) => {
    const [ia, ib] = row.querySelectorAll('input');
    const a = ia.value.trim(), b = ib.value.trim();
    if (a === '' && b === '') return;
    const x = parseIndex(a, 'Swap index'), y = parseIndex(b, 'Swap index');
    if (x === y) throw new Error('A swap needs two different indices.');
    raw.swaps.push([x, y]);
  });

  [...$('setRows').children].forEach((row) => {
    const name = row.querySelector('select').value;
    const expr = row.querySelector('input').value.trim();
    if (expr === '') return;
    raw.sets.push({ name, expr });
  });
  return raw;
}

/* Tiny safe evaluator: whole numbers, + - ( ) and the five variable names. */
function evalExpr(expr, vars) {
  if (!/^[\w\s+\-()]+$/.test(expr)) throw new Error(`Can't read "${expr}". Use numbers, + , - and variable names.`);
  const replaced = expr.replace(/[A-Za-z_]\w*/g, (name) => {
    if (!(name in vars)) throw new Error(`Unknown name "${name}" in "${expr}".`);
    return `(${vars[name]})`;
  });
  if (!/^[\d\s+\-()]+$/.test(replaced)) throw new Error(`Can't read "${expr}".`);
  let result;
  try { result = new Function(`"use strict"; return (${replaced});`)(); }
  catch (e) { throw new Error(`Can't evaluate "${expr}".`); }
  if (!Number.isInteger(result)) throw new Error(`"${expr}" must give a whole number.`);
  return result;
}

/* Builds the stored state that results from applying `raw` to `prev`. */
function buildStep(prev, raw) {
  const array = prev.array.slice();
  const vars = valsOf(prev);
  const ops = [];
  const assigns = [];

  if (raw.compare) {
    const { a, b } = raw.compare;
    const x = valueAt(array, a), y = valueAt(array, b);
    ops.push({
      text: `compare(arr[${a}], arr[${b}])`,
      detail: `arr[${a}] = ${x} vs arr[${b}] = ${y}  →  ${x} ${x < y ? '<' : x > y ? '>' : '='} ${y}`
    });
  }
  raw.swaps.forEach(([a, b]) => {
    ops.push({ text: `swap(arr[${a}], arr[${b}])`, detail: `${valueAt(array, a)} ↔ ${valueAt(array, b)}` });
    [array[a], array[b]] = [array[b], array[a]];
  });
  raw.sets.forEach(({ name, expr }) => {
    const to = evalExpr(expr, vars);
    if (name !== 'count' && (to < -1 || to > n)) throw new Error(`${name} must stay between -1 and ${n} (you set ${to}).`);
    const from = vars[name];
    vars[name] = to;
    assigns.push({ name, from, to });
    ops.push({ text: `${name} = ${expr}`, detail: `${from} → ${to}` });
  });

  // Plain-language description, used when the learner leaves "Explanation" empty.
  const auto = [];
  if (raw.compare) auto.push(ops[0].detail.replace('  →  ', ', so ') + '.');
  raw.swaps.forEach(([a, b], k) => {
    const op = ops[(raw.compare ? 1 : 0) + k];
    auto.push(`Swapped arr[${a}] and arr[${b}] (${op.detail}).`);
  });
  assigns.forEach((a) => auto.push(`${a.name} changes from ${a.from} to ${a.to}.`));

  const moved = assigns.filter((a) => a.name === 'mid' || a.name === 'right').map((a) => a.name);
  return {
    array,
    ptr: { left: vars.left, mid: vars.mid, i: vars.i, right: vars.right },
    count: vars.count,
    compare: raw.compare,
    swaps: raw.swaps,
    assigns,
    ops,
    title: ops.map((o) => o.text).join('  →  '),
    why: raw.why || auto.join(' '),
    note: moved.length ? `${moved.join(' and ')} is normally fixed in this algorithm, but this step changes it.` : '',
    raw,
    key: JSON.stringify(raw)
  };
}

function makeInitialState(p) {
  const array = values.map((_, id) => id);
  const ptr = { left: p.left, mid: p.mid, i: p.i, right: p.right };
  const ok = (k) => k >= 0 && k < n;
  const ops = [], focus = [];
  let why = 'Initial state. Describe the next step below, then click Next.';
  if (ok(p.left) && ok(p.i)) {
    const x = values[p.left], y = values[p.i];
    ops.push({
      status: 'active', text: 'compare(arr[left], arr[i])',
      detail: `arr[${p.left}] = ${x} vs arr[${p.i}] = ${y}  →  ${x} ${x < y ? '<' : x > y ? '>' : '='} ${y}`
    });
    focus.push(p.left, p.i);
    why = `Compare arr[left] = ${x} with arr[i] = ${y}. ` + (y < x
      ? `Since ${y} is smaller, the element at index i must move before the element at index left.`
      : `Since ${x} is not larger than ${y}, it is already in a valid position.`) +
      ' Describe the next step below, then click Next.';
  }
  return {
    array, ptr, count: p.count, compare: null, swaps: [], assigns: [], ops, focus,
    title: 'Initial state', why, note: '', raw: null, key: 'init',
    brackets: [
      { from: p.left, to: p.mid, label: 'Left sorted section', cls: 'left' },
      { from: p.mid + 1, to: p.right, label: 'Right sorted section', cls: 'right' }
    ]
  };
}

/* ------------------------------------------------------------------ */
/* Board construction and geometry                                    */
/* ------------------------------------------------------------------ */

function computeGeometry() {
  const cs = getComputedStyle(viz);
  const avail = viz.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const gap = avail < 520 ? 6 : 12;
  const cell = Math.max(24, Math.min(76, Math.floor((avail - gap * (n - 1)) / n)));
  geo = {
    cell, gap, pitch: cell + gap,
    cellH: Math.round(cell * 0.92),
    lane: Math.round(cell * 0.5),
    width: (cell + gap) * n - gap
  };
}

function buildBoard() {
  track.replaceChildren(); indicesEl.replaceChildren(); pointersEl.replaceChildren();
  cells.length = 0; idxEls.length = 0; ptrEls = {};

  values.forEach((v, id) => {
    const c = el('div', 'cell ' + origin[id], String(v));
    c.setAttribute('role', 'listitem');
    cells.push(c);
    track.appendChild(c);
  });
  for (let k = 0; k < n; k++) {
    const d = el('div', 'idx', String(k));
    idxEls.push(d);
    indicesEl.appendChild(d);
  }
  POINTER_ORDER.forEach((name) => {
    const root = el('div', 'ptr ptr-' + name);
    const stem = el('div', 'stem');
    const badge = el('div', 'badge');
    badge.appendChild(el('span', '', name));
    badge.appendChild(el('small', '', FIXED_POINTERS.has(name) ? 'fixed' : 'moves'));
    root.append(stem, badge);
    pointersEl.appendChild(root);
    ptrEls[name] = { root, stem };
  });
}

function applyGeometry() {
  board.style.width = geo.width + 'px';
  track.style.height = geo.cellH + geo.lane * 2 + 'px';
  cells.forEach((c) => {
    c.style.width = geo.cell + 'px';
    c.style.height = geo.cellH + 'px';
    c.style.top = geo.lane + 'px';
    c.style.fontSize = Math.max(12, Math.round(geo.cell * 0.3)) + 'px';
  });
  idxEls.forEach((d, k) => { d.style.left = k * geo.pitch + 'px'; d.style.width = geo.cell + 'px'; });
}

const cellX = (index) => index * geo.pitch;
const moveCell = (id, index, y = 0) => {
  cells[id].style.transform = `translate(${cellX(index)}px, ${y}px)`;
};

function positionCells(arr) {
  arr.forEach((id, k) => { cells[id].style.transitionDuration = ''; moveCell(id, k, 0); });
}

/* ------------------------------------------------------------------ */
/* Rendering                                                          */
/* ------------------------------------------------------------------ */

const LEVEL_H = 46, STEM_BASE = 12, BADGE_H = 38;

/* Pointers close together are stacked on different levels so labels never overlap. */
function renderPointers(ptr) {
  const labelW = geo.cell < 44 ? 46 : 60;
  const placed = [];
  let maxLevel = 0;
  POINTER_ORDER.forEach((name) => {
    const x = ptr[name] * geo.pitch + geo.cell / 2;
    let level = 0;
    while (placed.some((p) => p.level === level && Math.abs(p.x - x) < labelW + 6)) level++;
    placed.push({ x, level });
    maxLevel = Math.max(maxLevel, level);
    const { root, stem } = ptrEls[name];
    root.style.width = labelW + 'px';
    root.style.zIndex = String(10 - level);
    root.style.transform = `translateX(${x - labelW / 2}px)`;
    stem.style.height = STEM_BASE + level * LEVEL_H + 'px';
  });
  pointersEl.style.height = STEM_BASE + maxLevel * LEVEL_H + BADGE_H + 8 + 'px';
}

function renderBrackets(s) {
  bracketsEl.replaceChildren();
  (s.brackets || []).forEach((b) => {
    if (b.from > b.to || b.from < 0 || b.to >= n) return;
    const node = el('div', 'bracket ' + b.cls);
    node.style.left = b.from * geo.pitch + 'px';
    node.style.width = (b.to - b.from) * geo.pitch + geo.cell + 'px';
    node.appendChild(el('b', '', b.label));
    node.appendChild(el('span', '', '[' + s.array.slice(b.from, b.to + 1).map((id) => values[id]).join(', ') + ']'));
    bracketsEl.appendChild(node);
  });
}

function renderVars(vals, prev) {
  const box = $('vars');
  box.replaceChildren();
  VAR_ORDER.forEach((name) => {
    const kind = name === 'count' ? 'counter' : FIXED_POINTERS.has(name) ? 'fixed' : 'moves';
    const changed = prev && prev[name] !== vals[name];
    const card = el('div', 'var ' + kind + (changed ? ' changed' : ''));
    card.append(el('span', 'vname', name), el('span', 'veq', '='), el('span', 'vval', String(vals[name])));
    card.appendChild(el('span', 'vtag', kind === 'counter' ? 'counter' : kind === 'fixed' ? 'normally fixed' : 'moves'));
    if (changed) card.appendChild(el('span', 'vwas', 'was ' + prev[name]));
    box.appendChild(card);
  });
}

function renderOps(k, mode) {
  const list = $('ops');
  list.replaceChildren();
  const ops = states[k].ops;
  if (!ops.length) {
    list.appendChild(el('li', 'op', 'No operation yet.'));
    return;
  }
  ops.forEach((op) => {
    const li = el('li', 'op ' + (mode === 'pending' ? 'pending' : op.status || 'done'));
    li.appendChild(el('span', 'op-mark'));
    li.appendChild(el('code', 'op-text', op.text));
    li.appendChild(el('span', 'op-detail', op.detail));
    list.appendChild(li);
  });
}

function setOp(index, status) {
  const li = $('ops').children[index];
  if (li) li.className = 'op ' + status;
}

function renderWhy(k) {
  const s = states[k];
  $('whyText').textContent = s.why;
  const note = $('noteText');
  note.hidden = !s.note;
  note.textContent = s.note;

  const box = $('changes');
  box.replaceChildren();
  if (k > 0) {
    const a = valsOf(states[k - 1]), b = valsOf(s);
    VAR_ORDER.forEach((name) => {
      if (a[name] !== b[name]) box.appendChild(el('span', 'pill', `${name}: ${a[name]} → ${b[name]}`));
    });
  }
  if (!box.children.length) {
    box.appendChild(el('span', 'pill none', k === 0 ? 'No variable has changed yet.' : 'No variable changed in this step.'));
  }
}

function renderTexts(k, mode) {
  $('callLabel').textContent = `merge(arr, ${setup.left}, ${setup.mid}, ${setup.right})`;
  $('stepTitle').textContent = states[k].title;
  $('stepIndicator').textContent = `Step ${k + 1} / ${states.length}`;
  renderOps(k, mode);
  renderWhy(k);
}

function renderProgress(k) {
  const box = $('progress');
  box.replaceChildren();
  states.forEach((_, i) => box.appendChild(el('span', 'seg' + (i <= k ? ' done' : ''))));
}

function updateNav() {
  prevBtn.disabled = busy || currentStep === 0;
  nextBtn.disabled = busy;
}

function setFocus(indices) {
  cells.forEach((c) => c.classList.remove('focus'));
  const arr = states[currentStep].array;
  indices.forEach((idx) => { if (idx >= 0 && idx < n) cells[arr[idx]].classList.add('focus'); });
}

/* The single source of truth for a settled screen. */
function renderState(step) {
  const s = states[step];
  currentStep = step;
  displayed = s.array.slice();
  positionCells(displayed);
  renderTexts(step, 'static');
  renderVars(valsOf(s), step > 0 ? valsOf(states[step - 1]) : null);
  renderPointers(s.ptr);
  renderBrackets(s);
  renderProgress(step);
  setFocus(s.focus || []);
  $('opStatus').textContent = '';
  fillBuilder(states[step + 1] ? states[step + 1].raw : null);
  updateNav();
}

/* ------------------------------------------------------------------ */
/* Animation                                                          */
/* ------------------------------------------------------------------ */

function setDur(seconds, ...nodes) {
  nodes.forEach((nd) => { nd.style.transitionDuration = seconds * SPEED + 's'; });
}

/* Swaps arr[a] and arr[b] on screen and in `arr`; the two boxes visibly travel. */
async function animateSwap(a, b, arr) {
  const ia = arr[a], ib = arr[b];
  const A = cells[ia], B = cells[ib];
  const { lane } = geo;

  [A, B].forEach((c) => c.classList.add('swap-hi'));                 // 1. highlight
  idxEls[a].classList.add('hot'); idxEls[b].classList.add('hot');
  await wait(450);

  setDur(0.3, A, B);                                                  // 2. lift apart
  moveCell(ia, a, -lane); moveCell(ib, b, lane);
  await wait(330);

  setDur(0.8, A, B);                                                  // 3. travel
  moveCell(ia, b, -lane); moveCell(ib, a, lane);
  await wait(820);

  setDur(0.3, A, B);                                                  // 4. settle
  moveCell(ia, b, 0); moveCell(ib, a, 0);
  await wait(340);

  arr[a] = ib; arr[b] = ia;                                           // 5. commit, clear highlight
  [A, B].forEach((c) => { c.classList.remove('swap-hi'); c.style.transitionDuration = ''; });
  idxEls[a].classList.remove('hot'); idxEls[b].classList.remove('hot');
  await wait(120);
}

async function animateCompare(a, b, arr) {
  const A = cells[arr[a]], B = cells[arr[b]];
  [A, B].forEach((c) => c.classList.add('cmp'));
  idxEls[a].classList.add('hot'); idxEls[b].classList.add('hot');
  await wait(1200);
  [A, B].forEach((c) => c.classList.remove('cmp'));
  idxEls[a].classList.remove('hot'); idxEls[b].classList.remove('hot');
  await wait(100);
}

/* ------------------------------------------------------------------ */
/* Navigation                                                         */
/* ------------------------------------------------------------------ */

async function goTo(target) {
  if (busy || target < 0 || target >= states.length || target === currentStep) return;
  busy = true;
  updateNav();
  setFocus([]);

  const forward = target > currentStep;
  const owner = forward ? states[target] : states[currentStep];   // the state that owns this transition
  const arr = displayed.slice();
  const status = $('opStatus');

  if (forward) {
    const before = valsOf(states[currentStep]);
    renderTexts(target, 'pending');
    let opIdx = 0;

    if (owner.compare) {
      setOp(opIdx, 'active'); status.textContent = 'Comparing…';
      await animateCompare(owner.compare.a, owner.compare.b, arr);
      setOp(opIdx++, 'done');
    }
    for (const [a, b] of owner.swaps) {
      setOp(opIdx, 'active'); status.textContent = 'Swapping…';
      await animateSwap(a, b, arr);
      setOp(opIdx++, 'done');
    }
    const live = { ...before };
    for (const as of owner.assigns) {
      setOp(opIdx, 'active'); status.textContent = `Updating ${as.name}…`;
      live[as.name] = as.to;
      renderVars(live, before);
      if (as.name !== 'count') renderPointers(live);
      await wait(800);
      setOp(opIdx++, 'done');
    }
  } else {
    for (let k = owner.swaps.length - 1; k >= 0; k--) {
      const [a, b] = owner.swaps[k];
      status.textContent = `Rewinding: undoing swap(arr[${a}], arr[${b}])`;
      await animateSwap(a, b, arr);
    }
    if (!owner.swaps.length) await wait(250);
  }

  if (arr.join() !== states[target].array.join()) {
    console.error('Animation ended in an unexpected array', arr, states[target].array);
  }

  renderState(target);
  busy = false;
  updateNav();
}

function previousStep() { goTo(currentStep - 1); }

function nextStep() {
  if (busy) return;
  let raw;
  try { raw = readBuilder(); } catch (e) { setMsg($('builderError'), e.message); return; }
  if (!raw.compare && !raw.swaps.length && !raw.sets.length) {
    setMsg($('builderError'), 'Add a comparison, a swap or a variable change first.');
    return;
  }
  const target = currentStep + 1;
  const key = JSON.stringify(raw);

  if (states[target] && states[target].key === key) {   // identical to the recorded step: replay it
    setMsg($('builderError'), '');
    goTo(target);
    return;
  }
  let s;
  try { s = buildStep(states[currentStep], raw); } catch (e) { setMsg($('builderError'), e.message); return; }
  states.length = currentStep + 1;                      // a changed step replaces the old future
  states.push(s);
  setMsg($('builderError'), '');
  goTo(target);
}

/* ------------------------------------------------------------------ */
/* Start and layout                                                   */
/* ------------------------------------------------------------------ */

function startVisualization(p) {
  n = p.arr.length;
  values = p.arr.slice();
  origin = values.map((_, id) => (id >= p.left && id <= p.mid ? 'o-left' : id > p.mid && id <= p.right ? 'o-right' : 'o-out'));
  setup = { left: p.left, mid: p.mid, right: p.right, i: p.i, count: p.count };

  $('summaryText').textContent = `arr = [${values.join(', ')}]   merge(arr, ${p.left}, ${p.mid}, ${p.right})   i = ${p.i}   count = ${p.count}`;
  $('setupForm').hidden = true;
  $('setupSummary').hidden = false;
  $('workspace').hidden = false;

  states = [makeInitialState(setup)];
  busy = false;
  buildBoard();
  computeGeometry();
  applyGeometry();
  board.classList.add('no-anim');
  renderState(0);
  requestAnimationFrame(() => requestAnimationFrame(() => board.classList.remove('no-anim')));
}

function layout() {
  if (!n) return;
  computeGeometry();
  applyGeometry();
  board.classList.add('no-anim');
  positionCells(displayed);
  renderPointers(states[currentStep].ptr);
  renderBrackets(states[currentStep]);
  requestAnimationFrame(() => requestAnimationFrame(() => board.classList.remove('no-anim')));
}

prevBtn.addEventListener('click', previousStep);
nextBtn.addEventListener('click', nextStep);

document.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement.tagName)) return;
  if ($('workspace').hidden) return;
  if (e.key === 'ArrowLeft') previousStep();
  if (e.key === 'ArrowRight') nextStep();
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (busy) pendingResize = true; else layout(); }, 120);
});
setInterval(() => { if (pendingResize && !busy) { pendingResize = false; layout(); } }, 400);
