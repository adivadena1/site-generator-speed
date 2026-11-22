// Driver: reads every case from /input/cases.json, answers each with run,
// writes /output/answers.json: a JSON array of the answers, one per case and
// in the cases' order. Equivalent to the kit's reference driver.
import { setFlagsFromString } from 'node:v8';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it (the rules: the house baseline runs with
// --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

const { run } = await import(new URL('./solve.js', import.meta.url).href);

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const answers = cases.map((c) => run(c.input));
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
