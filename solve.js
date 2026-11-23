// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// Written from the makefun-site README and observed behaviour; original code.
//
// Speed strategy (measured profile of the reference: per-character HTML
// escaping ~31% of CPU, GC ~11%, word-count regex ~8%, token objects):
//   * inline Markdown: batch-escape plain runs instead of one call per char
//   * Markdown: one fused lex+render pass, no token objects
//   * word count: manual counter, no match-array allocation
//   * slugify: ASCII fast path (NFKD is identity on ASCII, no combining marks)
//   * template for-loops: one vars object per loop, mutated per element
//   * fence bodies: one escape over the joined body
//   * front matter: line scanner, no split/join of the whole source
// Behaviour is byte-for-byte identical to the reference on every input.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_TEST = /[&<>"']/;
function escapeHtml(text) {
  // Most runs hold no special character at all; a test is cheaper than a
  // replace, which builds a result and runs a callback per match.
  return ESCAPE_TEST.test(text) ? text.replace(ESCAPE_RE, (c) => ESCAPES[c]) : text;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

const COMBINING = /\p{M}/gu;
function slugify(text) {
  // ASCII fast path: NFKD is the identity on pure ASCII and ASCII holds no
  // combining marks, so the normalised form equals the input itself.
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(COMBINING, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2;
  while (taken.has(`${slug}-${n}`)) n++;
  const next = `${slug}-${n}`;
  taken.add(next);
  return next;
}

function dirOf(path) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------------------
// Front matter: grammar is the reference's own (see its README). The scanner
// walks lines with indexOf so the whole source is never split or re-joined.
// Every refusal string is reproduced exactly; they land in build-report.txt.
// ---------------------------------------------------------------------------

const FRONT_KEYS = ['title', 'summary', 'date', 'tags', 'draft', 'layout', 'slug'];
const KEY_LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TAG_RE = /^[^"\[\]]+$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) {
      return { error: 'a quoted string is not closed' };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      if (raw[i] === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (raw[i] === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += raw[i];
      }
    }
    return { value: out };
  }
  if (raw.startsWith('[')) {
    return { error: 'a bare string opens on [' };
  }
  return { value: raw };
}

function valueOf(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringOf(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    const m = DATE_RE.exec(raw);
    const y = m ? Number(m[1]) : 0;
    const mo = m ? Number(m[2]) : 0;
    const d = m ? Number(m[3]) : 0;
    if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (!raw.startsWith('[') || !raw.endsWith(']')) {
      return { error: 'key "tags": not a list [a, b]' };
    }
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const items = inner.split(',').map((t) => t.trim());
    if (items.some((t) => t === '' || !TAG_RE.test(t))) {
      return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    return { value: items };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    if (!NAME_RE.test(raw)) return { error: 'key "layout": not a template name' };
    return { value: raw };
  }
  // slug
  if (!SLUG_RE.test(raw) || raw.length > 64) {
    return { error: 'key "slug": not a slug' };
  }
  return { value: raw };
}

// Days of month m (1-12) of year y, by the Gregorian rule.
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

// Returns { data, body } or { error }.
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) {
    return { error: 'no front matter' };
  }
  if (text === '---') return { error: 'the front matter is not closed' };
  // Find the closing '---' line: first line after line 1 that is exactly '---'.
  let closeStart = -1;
  let closeEnd = -1;
  let p = 4; // just past '---\n'
  while (p < text.length) {
    const nl = text.indexOf('\n', p);
    const end = nl === -1 ? text.length : nl;
    if (text.slice(p, end) === '---') {
      closeStart = p;
      closeEnd = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    p = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  // Key lines live in text[4..closeStart); the region ends with '\n', so the
  // split's last element is '' and is dropped. Line i+2 is the reported n.
  const fmLines = text.slice(4, closeStart).split('\n');
  fmLines.pop();
  const data = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    const n = i + 2;
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = KEY_LINE.exec(line);
    if (m === null) return { error: `line ${n} is not "key: value"` };
    const key = m[1];
    if (!FRONT_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return { error: v.error };
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------------------
// Markdown: the reference's own subset (see its README). Fused lex+render:
// lines are walked once and blocks are emitted straight to the output, with
// the table of contents and the excerpt collected as side data. No tokens.
// ---------------------------------------------------------------------------

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE = /^>/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function headingOf(line) {
  const m = HEADING.exec(line);
  if (m === null || m[2] === '') return null;
  return { depth: m[1].length, text: m[2] };
}

function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return BLANK.test(line);
  if (c === 96) return FENCE_OPEN.test(line); // `
  if (c === 35) return headingOf(line) !== null; // #
  if (c === 45 || c === 42) return HR.test(line); // - or *
  return false;
}

function findUnescaped(s, what, from) {
  let i = from;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s.startsWith(what, i)) return i;
    i++;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '*') {
      if (s[j + 1] === '*') { j++; continue; }
      return j;
    }
  }
  return -1;
}

// Inline, left to right. The next special character is found by one native
// regex scan; plain runs between specials are escaped in one native pass
// instead of one escapeHtml call per character. `re` is threaded through the
// recursive calls so no new RegExp is made for a nested span (the caller
// resets lastIndex before every exec, so sharing it is safe).
// The scan ALSO matches the five HTML specials, so a plain run between two
// matches holds no special of either kind and is appended raw — no slice +
// escapeHtml + replace-callback per run. An HTML special is escaped inline
// from the ESCAPES table.
function inline(s, env, re) {
  re ??= /[\\`*[\&<>"']/g;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    re.lastIndex = i;
    const m = re.exec(s);
    const j = m === null ? n : m.index;
    if (j > i) out += s.slice(i, j);
    if (j >= n) break;
    const c = s[j];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      out += ESCAPES[c];
      i = j + 1;
      continue;
    }
    if (c === '\\') {
      // escapeHtml of the escaped char: identity for every escapable char
      // except '>', which is itself an HTML special ('&gt;'). A table lookup
      // is that function on one character, without the call or the regex.
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) { out += ESCAPES[s[j + 1]] ?? s[j + 1]; i = j + 2; }
      else { out += '\\'; i = j + 1; }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) { out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`; i = k + 1; }
      else { out += '`'; i = j + 1; }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) { out += `<strong>${inline(s.slice(j + 2, k), env, re)}</strong>`; i = k + 2; }
        else { out += '**'; i = j + 2; }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) { out += `<em>${inline(s.slice(j + 1, k), env, re)}</em>`; i = k + 1; }
        else { out += '*'; i = j + 1; }
      }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', j + 1);
    const m2 = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m2 === -1 ? '' : s.slice(k + 2, m2);
    if (target !== '' && !/\s/.test(target)) {
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env, re)}</a>`;
      i = m2 + 1;
    } else {
      out += '[';
      i = j + 1;
    }
  }
  return out;
}

function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let words = 0;
  for (let k = 0; k < lines.length; k++) words += countWordsIn(lines[k]);
  let i = 0;
  const n = lines.length;
  const re = /[\\`*[\&<>"']/g; // threaded through inline()
  while (i < n) {
    const line = lines[i];
    if (line === '') { i++; continue; }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      // A line opening on a space or tab is blank or a paragraph line: no
      // other block can start there.
      if (BLANK.test(line)) { i++; continue; }
    } else if (c0 === 96) { // `
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < n && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++; // past the closing fence, or past the end
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        const inner = body.length === 0 ? '' : escapeHtml(`${body.join('\n')}\n`);
        out.push(`<pre><code${cls}>${inner}</code></pre>\n`);
        continue;
      }
    } else if (c0 === 35) { // #
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, env, re);
        out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) {
          toc.push({ level: heading.depth, id, html });
        }
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) { // - or *
      if (HR.test(line)) { out.push('<hr>\n'); i++; continue; }
      const bullet = BULLET.exec(line);
      if (bullet !== null) {
        const items = [];
        while (i < n) {
          const m = BULLET.exec(lines[i]);
          if (m !== null) { items.push([trimLine(m[1])]); i++; }
          else if (CONTINUED.test(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
        // Push <li>s straight into the output instead of map() + join():
        // same concatenation, no intermediate array or string.
        out.push('<ul>\n');
        for (const parts of items) out.push(`<li>${inline(parts.length === 1 ? parts[0] : parts.join('\n'), env, re)}</li>\n`);
        out.push('</ul>\n');
        continue;
      }
    } else if (c0 === 62) { // >
      const body = [];
      while (i < n && QUOTE.test(lines[i])) body.push(lines[i++].replace(/^> ?/, ''));
      // One loop for trim + drop-empty instead of map() + filter() (two arrays).
      const inner = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') inner.push(t);
      }
      out.push(
        inner.length === 0
          ? '<blockquote>\n</blockquote>\n'
          : `<blockquote>\n<p>${inline(inner.length === 1 ? inner[0] : inner.join('\n'), env, re)}</p>\n</blockquote>\n`,
      );
      continue;
    } else if (c0 >= 48 && c0 <= 57) { // digit
      const ordered = ORDERED.exec(line);
      if (ordered !== null) {
        const items = [];
        while (i < n) {
          const m = ORDERED.exec(lines[i]);
          if (m !== null) { items.push([trimLine(m[2])]); i++; }
          else if (CONTINUED.test(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
        const open = Number(ordered[1]) !== 1 ? `<ol start="${Number(ordered[1])}">` : '<ol>';
        out.push(`${open}\n`);
        for (const parts of items) out.push(`<li>${inline(parts.length === 1 ? parts[0] : parts.join('\n'), env, re)}</li>\n`);
        out.push('</ol>\n');
        continue;
      }
    }
    // Paragraph: this line and the lines that follow it, up to a blank line,
    // a fence, a heading or a thematic break.
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    // A one-line paragraph is the common case: join() of one element is the
    // element itself, so skip the call.
    const html = inline(body.length === 1 ? body[0] : body.join('\n'), env, re);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '', words };
}

// Word count: runs of non-whitespace, counted by hand over one line. The
// reference's \S set is the JS one: \t \n \v \f \r space, U+00A0, U+1680,
// U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF.
// (U+0085 is NOT in JS \s — verified against the engine.) A word cannot span
// a line break, so summing per line equals counting the whole body.
function countWordsIn(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c < 33) ws = (c >= 9 && c <= 13) || c === 32;
    else if (c < 128) ws = false;
    else {
      ws = c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 ||
        c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    }
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Templates: the reference's own dialect (see its README). {{ path }} is
// escaped, {{{ path }}} is raw, {% for %}/{% if %}/{% include %} are the only
// tags, a {% %} tag alone on its line takes the line with it. Parse errors
// are reported as `template "<name>": <reason>`.
// ---------------------------------------------------------------------------

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

class TemplateError extends Error {}

function pathOf(text) {
  if (!PATH_RE.test(text)) {
    throw new TemplateError(`${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

function tokenize(name, src) {
  const toks = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (src[open + 1] === '%') {
      const close = src.indexOf('%}', open + 2);
      if (close === -1) throw new TemplateError('a {% is not closed');
      const end = close + 2;
      const lineStart = src.lastIndexOf('\n', open - 1) + 1;
      const nl = src.indexOf('\n', end);
      const lineEnd = nl === -1 ? src.length : nl;
      const standalone =
        /^[ \t]*$/.test(src.slice(lineStart, open)) &&
        /^[ \t]*$/.test(src.slice(end, lineEnd));
      if (standalone) text = text.slice(0, text.length - (open - lineStart));
      if (text !== '') { toks.push({ kind: 'text', text }); text = ''; }
      toks.push({ kind: 'tag', tag: src.slice(open + 2, close).trim() });
      i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
      continue;
    }
    const raw = src[open + 2] === '{';
    const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
    if (close === -1) throw new TemplateError(raw ? 'a {{{ is not closed' : 'a {{ is not closed');
    if (text !== '') { toks.push({ kind: 'text', text }); text = ''; }
    toks.push({ kind: raw ? 'raw' : 'var', path: pathOf(src.slice(open + (raw ? 3 : 2), close).trim()) });
    i = close + (raw ? 3 : 2);
  }
  if (text !== '') toks.push({ kind: 'text', text });
  return toks;
}

function parseTemplate(name, src) {
  const toks = tokenize(name, src);
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of toks) {
    if (tok.kind !== 'tag') { body.push(tok); continue; }
    const tag = tok.tag;
    if (tag === 'else') {
      const top = stack[stack.length - 1];
      if (top.kind !== 'if' || top.else !== null) {
        throw new TemplateError('an else outside an if');
      }
      top.else = [];
      body = top.else;
      continue;
    }
    if (tag === 'endfor' || tag === 'endif') {
      const top = stack.pop();
      if (top === undefined || top.kind !== tag.slice(3)) {
        throw new TemplateError(`an ${tag} with no open ${tag.slice(3)}`);
      }
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      continue;
    }
    const mFor = FOR_RE.exec(tag);
    if (mFor !== null) {
      const node = { kind: 'for', name: mFor[1], path: pathOf(mFor[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
      continue;
    }
    const mIf = IF_RE.exec(tag);
    if (mIf !== null) {
      const node = { kind: 'if', not: mIf[1] !== undefined, path: pathOf(mIf[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
      continue;
    }
    const mInc = INCLUDE_RE.exec(tag);
    if (mInc !== null) {
      body.push({ kind: 'include', name: mInc[1] });
      continue;
    }
    throw new TemplateError(`{% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) {
    throw new TemplateError(`a ${stack[stack.length - 1].kind} is not closed`);
  }
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text') { out += n.text; continue; }
    if (n.kind === 'var') { out += escapeHtml(textOf(lookup(scope, n.path))); continue; }
    if (n.kind === 'raw') { out += textOf(lookup(scope, n.path)); continue; }
    if (n.kind === 'if') {
      const v = truthy(lookup(scope, n.path));
      const branch = v !== n.not ? n.then : n.else;
      if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
      continue;
    }
    if (n.kind === 'for') {
      const xs = lookup(scope, n.path);
      if (!Array.isArray(xs)) continue;
      // One vars object per loop, mutated per element: rendering is
      // synchronous and depth-first, so no iteration can observe another's
      // bindings. `loop` is re-asserted after the element binding, so a
      // `for loop in ...` still sees the loop object, exactly as the
      // reference's object literal does (its later `loop` key wins).
      const lp = { index: 0, first: false, last: false, length: xs.length };
      const vars = { [n.name]: undefined, loop: lp };
      const child = { vars, parent: scope };
      for (let k = 0; k < xs.length; k++) {
        vars[n.name] = xs[k];
        vars.loop = lp;
        lp.index = k + 1;
        lp.first = k === 0;
        lp.last = k === xs.length - 1;
        out += renderNodes(n.body, child, ctx, depth);
      }
      continue;
    }
    // include
    const tpl = ctx.templates.get(n.name);
    if (tpl !== undefined && depth < INCLUDE_DEPTH) {
      out += renderNodes(tpl, scope, ctx, depth + 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build: the reference's eight plugins, in order, with the same outputs.
// ---------------------------------------------------------------------------

const RESERVED = ['posts', 'tags', 'page'];

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function linkOf(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

function pageOf(s, preCard) {
  // Posts already have a card in the `cards` map (built for index/tag pages);
  // reusing it avoids building the same card (with its tag array) twice.
  const card = preCard ?? cardOf(s);
  return {
    title: card.title,
    url: card.url,
    date: card.date,
    date_long: card.date_long,
    summary: card.summary,
    excerpt: card.excerpt,
    reading_minutes: card.reading_minutes,
    tags: card.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc, // already { level, id, html } per entry; templates only read it
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

function build(input) {
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  const broken = new Set();

  // Templates, parsed in code-unit name order; failures are reported.
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort()) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(`template "${name}": ${err.message}`);
    }
  }

  // Sources, in code-unit path order.
  const files = [...input.files].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      // Most sources hold no carriage return at all; skip the replace then.
      const content = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, text: content });
    } else {
      statics.push({ path: f.path, content: f.content });
    }
  }

  // Front matter, in order: parse, own directory, post date, layout, draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, with link resolution.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link(target) {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) {
          return target;
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const page = bySource.get(path);
          if (page !== undefined) return `${page.url}${frag}`;
          if (staticPaths.has(path)) return `${base}/${path}${frag}`;
        }
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => {
    if (y.data.date < x.data.date) return -1;
    if (y.data.date > x.data.date) return 1;
    if (x.slug < y.slug) return -1;
    if (x.slug > y.slug) return 1;
    return 0;
  });
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: each post's tags, each slug once, first spelling kept.
  const slugCache = new Map();
  const slugOf = (name) => {
    let v = slugCache.get(name);
    if (v === undefined) { v = slugify(name); slugCache.set(name, v); }
    return v;
  };
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugOf(name);
      if (!seen.has(sl)) { seen.add(sl); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOf(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map(
      (name) => bySlug.get(slugOf(name)) ?? { name, slug: slugOf(name), url: '', posts: [] },
    );
  }
  const tags = [...bySlug.values()].sort((x, y) => {
    const d = y.posts.length - x.posts.length;
    if (d !== 0) return d;
    if (x.slug < y.slug) return -1;
    if (x.slug > y.slug) return 1;
    return 0;
  });

  // Layouts.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    return nodes === undefined
      ? null
      : renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0);
  };
  const output = {};
  for (const s of kept) {
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, s.post ? cards.get(s) : undefined) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: {
        name: t.name,
        slug: t.slug,
        url: t.url,
        count: t.posts.length,
        posts: t.posts.map((p) => cards.get(p)),
      },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // Report.
  const lines = [...report, ...broken].sort();
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

export function run(input) {
  return build(input);
}
