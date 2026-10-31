// Cross-checks highlight-ahk2.js against the ANTLR lexer, which is a real AHK v2 tokenizer.
// For every comment, string, number, keyword and identifier token the lexer finds in the
// .ahk files under the given folders, checks that highlight.js gave it the matching scope.
// Usage: npm run check:highlight-corpus -- <folder with .ahk files> [more folders]
//    or: npx tsx tests/highlight-corpus.mts <project dir> <grammar file> <folder...>
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const explicit = args.length > 2 && fs.existsSync(path.join(args[0], 'package.json'));
const projectDir = explicit ? path.resolve(args[0]) : path.resolve(here, '..');
const grammarFile = explicit ? path.resolve(args[1]) : path.join(projectDir, 'src/vendor/highlight-ahk2.js');
const corpusDirs = explicit ? args.slice(2) : args;
if (!corpusDirs.length) { console.error('Give one or more folders containing .ahk files.'); process.exit(2); }
const req = createRequire(path.join(projectDir, 'package.json'));
const hljs = req('highlight.js/lib/core');
(globalThis as any).hljs = hljs;
new Function('hljs', fs.readFileSync(grammarFile, 'utf8'))(hljs);

const Antlr4 = req('antlr4ng');
const { AutoHotkeyLexer } = await import(path.join(projectDir, 'src/parser/AutoHotkeyLexer.ts'));
const { readTokens } = await import(path.join(projectDir, 'src/lexing.ts'));

type Cat = 'comment' | 'string' | 'number' | 'keyword' | 'code';
const KEYWORDS = new Set(['If', 'Else', 'Return', 'Loop', 'While', 'For', 'Break', 'Continue', 'Switch', 'Case', 'Try', 'Catch',
    'Finally', 'Throw', 'Until', 'Goto', 'Global', 'Local', 'Static', 'Class', 'Extends', 'In', 'Is', 'VerbalAnd', 'VerbalOr',
    'VerbalNot', 'This', 'Super', 'Unset', 'As']);

/** Class string of the innermost highlight.js scope for every UTF-16 offset. */
function hljsClasses(code: string): string[] {
    const html: string = hljs.highlight(code, { language: 'ahk2', ignoreIllegals: true }).value;
    const out: string[] = [];
    const stack: string[] = [];
    const re = /<span class="([^"]+)">|<\/span>|&(amp|lt|gt|quot|#x27|#39);|[^<&]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
        if (m[1] !== undefined) stack.push(m[1]);
        else if (m[0] === '</span>') stack.pop();
        else {
            const len = m[2] ? 1 : m[0].length;
            for (let i = 0; i < len; i++) out.push(stack.join(' '));
        }
    }
    return out;
}

function categorize(t: any, prev: any, symbolic: (string | null)[]): Cat | null {
    const name = symbolic[t.type] ?? '';
    const text: string = t.text ?? '';
    if (text.startsWith(';') || text.startsWith('/*')) return 'comment';
    if (name === 'StringLiteral') return 'string';
    if (name === 'Text' || name === 'DirectiveString') return 'string'; // Directive argument, e.g. #Requires AutoHotkey v2.0
    if (name === 'DecimalLiteral' || name === 'HexIntegerLiteral') return 'number';
    if (KEYWORDS.has(name)) {
        if (prev && (prev.text === '.' || prev.text === '?.')) return null; // property name, e.g. obj.Base
        return 'keyword';
    }
    if (name === 'Identifier') return 'code';
    return null;
}

const expect: Record<Cat, (cls: string) => boolean> = {
    comment: c => c.includes('hljs-comment'),
    string: c => c.includes('hljs-string'),
    number: c => c.includes('hljs-number'),
    keyword: c => c.includes('hljs-keyword'),
    code: c => !c.includes('hljs-string') && !c.includes('hljs-comment'),
};

interface Miss { cat: Cat; file: string; line: number; text: string; got: string; context: string }
const misses: Miss[] = [];
const totals: Record<string, number> = {};
let files = 0, skipped = 0;

function lineStarts(code: string) {
    const starts = [0];
    for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1);
    return starts;
}

function checkSource(code: string, file: string) {
    let tokens: any[];
    try {
        const lexer = new AutoHotkeyLexer(Antlr4.CharStream.fromString(code + '\n'));
        lexer.removeErrorListeners();
        tokens = readTokens(lexer).allTokens;
    } catch { skipped++; return; }
    files++;
    const classes = hljsClasses(code);
    const starts = lineStarts(code);
    const lines = code.split('\n');
    const symbolic = AutoHotkeyLexer.symbolicNames;
    let prev: any = null;
    for (const t of tokens) {
        if (t.channel !== 0 && !(t.text ?? '').match(/^\s*(;|\/\*)/)) { continue; }
        const cat = categorize(t, prev, symbolic);
        if (t.channel === 0 && (t.text ?? '').trim()) prev = t;
        if (!cat || t.line < 1) continue;
        // Token offsets: line/column are reliable; columns are code points but the corpus is BMP-only in practice.
        let text: string = (t.text ?? '').replace(/\r?\n$/, '');
        const lead = text.length - text.trimStart().length;
        text = text.trim();
        if (!text) continue;
        const start = starts[t.line - 1] + t.column + lead;
        totals[cat] = (totals[cat] ?? 0) + 1;
        let bad = '';
        for (let i = 0; i < text.length; i++) {
            if (/\s/.test(text[i])) continue;
            const c = classes[start + i] ?? '';
            if (!expect[cat](c)) { bad = c || '(none)'; break; }
        }
        if (bad) misses.push({ cat, file, line: t.line, text: text.split('\n')[0].slice(0, 60), got: bad, context: (lines[t.line - 1] ?? '').trim().slice(0, 100) });
    }
}

function* walk(dir: string): Generator<string> {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) yield* walk(p);
        else if (/\.(ahk|ah2)$/i.test(e.name)) yield p;
    }
}

for (const dir of corpusDirs) for (const f of walk(dir)) checkSource(fs.readFileSync(f, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n'), path.relative(dir, f));

console.log(`files checked: ${files}, skipped (lexer error): ${skipped}`);
for (const cat of Object.keys(totals)) {
    const m = misses.filter(x => x.cat === cat);
    console.log(`${cat.padEnd(8)} ${totals[cat]} tokens, ${m.length} mismatched (${(100 * m.length / totals[cat]).toFixed(1)}%)`);
}
const groups = new Map<string, Miss[]>();
for (const m of misses) {
    const key = `${m.cat} -> ${m.got}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
}
for (const [key, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n## ${key}: ${list.length}`);
    const seen = new Set<string>();
    for (const m of list) {
        const sig = m.text.toLowerCase();
        if (seen.has(sig)) continue;
        seen.add(sig);
        console.log(`   ${m.file}:${m.line}  [${m.text}]  in: ${m.context}`);
        if (seen.size >= 8) break;
    }
}
