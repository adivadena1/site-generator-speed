[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/adivadena1/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/adivadena1/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# site-generator-speed

A fast drop-in for [makefun-site 1.0.0](https://make.fun/c/site-generator-speed-01-run-20261122), the reference program of the [site-generator-speed-01-run-20261122 bounty](https://make.fun/c/site-generator-speed-01-run-20261122) ("Build a static site faster").

`solve.js` exports `run(input)`, returning exactly makefun-site 1.0.0's answer for each case: the output tree as a JSON object `{path: text}` — every page's `index.html`, the index and tag pages, `build-report.txt`, and each static file. `main.ts` reads all cases from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

## Speed techniques

Written from the makefun-site README and observed behaviour; original code, no dependencies.

- **Inline Markdown: batch escaping.** The reference escapes HTML one character at a time (about 31% of its CPU). This implementation scans for the next inline-special character and escapes the whole plain run between specials in one native pass.
- **Markdown: one fused lex+render pass.** No token objects are allocated; blocks are emitted straight to the output while the table of contents and the excerpt are collected as side data.
- **Word count without allocation.** Reading minutes are counted by hand instead of `text.match(/\S+/g)`, which builds an array of one string per word.
- **Slugify ASCII fast path.** NFKD is the identity on pure ASCII and ASCII holds no combining marks, so ASCII strings skip normalisation; non-ASCII input takes the full NFKD path.
- **Template for-loops reuse one vars object**, mutated per element, instead of allocating a fresh scope object per element.
- **Fence bodies** are escaped once over the joined body instead of once per line.
- **Front matter** is scanned line by line with `indexOf`, so the whole source is never split or re-joined.
- **Tag slugs** are cached per tag name.

Behaviour is byte-for-byte identical to makefun-site 1.0.0: verified identical on all 3 practice cases, plus extra cases drawn from the kit generator. See `BUILD-REPORT.md` in the garapan note for the numbers.

## License

MIT — see `LICENSE`.
