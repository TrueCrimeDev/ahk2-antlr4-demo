// Targeted checks for src/vendor/highlight-ahk2.js. Run: npm run test:highlight
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const hljs = require('highlight.js/lib/core');
globalThis.hljs = hljs;
new Function('hljs', readFileSync(process.env.GRAMMAR ?? new URL('../src/vendor/highlight-ahk2.js', import.meta.url), 'utf8'))(hljs);

/** Scope of each character, as the innermost class list. */
function scopes(code) {
    const html = hljs.highlight(code, { language: 'ahk2', ignoreIllegals: true }).value;
    const out = [];
    const stack = [];
    const re = /<span class="([^"]+)">|<\/span>|&(amp|lt|gt|quot|#x27);|[^<&]+/g;
    let m;
    while ((m = re.exec(html))) {
        if (m[1] !== undefined) stack.push(m[1]);
        else if (m[0] === '</span>') stack.pop();
        else for (let i = 0; i < (m[2] ? 1 : m[0].length); i++) out.push(stack[stack.length - 1] ?? '');
    }
    return out;
}

/** Scope covering `text` (the nth occurrence) in `code`, or 'mixed:...' if it is split. */
function scopeOf(code, text, nth = 0) {
    let at = -1;
    for (let i = 0; i <= nth; i++) at = code.indexOf(text, at + 1);
    if (at < 0) throw new Error(`"${text}" not found in ${JSON.stringify(code)}`);
    const s = scopes(code).slice(at, at + text.length);
    const uniq = [...new Set(s)];
    return uniq.length === 1 ? uniq[0] : 'mixed:' + uniq.join('|');
}

const cases = [
    // [code, text, expected scope, nth occurrence]
    ['If (x) {\n    Return Loop\n}', 'If', 'hljs-keyword'],
    ['If (x) {\n    Return Loop\n}', 'Return', 'hljs-keyword'],
    ['WHILE x\n  x--', 'WHILE', 'hljs-keyword'],
    ['catch ValueError as e', 'as', 'hljs-keyword'],
    ['} until !IsSet(p)', 'until', 'hljs-keyword'],
    ['Loop Files "*.txt"', 'Loop Files', 'hljs-keyword'],
    ['Prop {\n  get => 1\n  set {\n  }\n}', 'get', 'hljs-keyword'],
    ['m.Get(1)', 'Get', 'hljs-title function_ invoke__'],
    ['x := true', 'true', 'hljs-literal'],
    ['msgbox "hi"', 'msgbox', 'hljs-built_in'],
    ['#Requires AutoHotkey v2.0', '#Requires', 'hljs-meta'],
    ['#InputLevel 1', '#InputLevel', 'hljs-meta'],
    ['#c::Run("calc")', '#c::', 'hljs-symbol'],
    ['^j::MsgBox "x"', '^j::', 'hljs-symbol'],
    ['~LButton & RButton::Send "x"', '~LButton & RButton::', 'hljs-symbol'],
    ['F1 up::return', 'F1 up::', 'hljs-symbol'],
    ['^+"::Send \'""{Left}\'', '^+"::', 'hljs-symbol'],
    ['^+"::Send \'""{Left}\'', 'Send', 'hljs-built_in'],
    ['a::b', 'a::', 'hljs-symbol'],
    ['::btw::by the way', '::btw::', 'hljs-symbol'],
    ['::btw::by the way', 'by the way', 'hljs-string'],
    ["::dont::don't do it\nx := 1", "don't do it", 'hljs-string'],
    ["::dont::don't do it\nx := 1", '1', 'hljs-number'],
    [':*:]d::today ; note', 'today ', 'hljs-string'],
    [':*:]d::today ; note', '; note', 'hljs-comment'],
    [':X:btw::MsgBox("hi")', 'MsgBox', 'hljs-built_in'],
    ['w := a " :: " b\nMsgBox w', '" :: "', 'hljs-string'],
    ['w := a " :: " b\nMsgBox w', 'MsgBox', 'hljs-built_in'],
    ['Hotstring "::btw", "by the way"', '"::btw"', 'hljs-string'],
    ['x := "unclosed\ny := 2', '2', 'hljs-number'],
    ['x := "a ; b"', '"a ; b"', 'hljs-string'],
    ['x := 1;notcomment ; comment', ';notcomment', ''],
    ['x := 1 ; comment', '; comment', 'hljs-comment'],
    ['Var := "\n(\nline "one"\n)"\ny := 2', '"\n(\nline "one"\n)"', 'hljs-string'],
    ['Var := "\n(\nline "one"\n)"\ny := 2', '2', 'hljs-number'],
    ['FileAppend "   ; Comment.\n; Comment.\n( LTrim\ntext\n)", "C:\\f.txt"', '"C:\\f.txt"', 'hljs-string'],
    ['MsgBox(\n(\n    "Left: " MI.Left "\n    Top: " MI.Top\n))', '"\n    Top: "', 'hljs-string'],
    ['MsgBox(\n(\n    "Left: " MI.Left "\n    Top: " MI.Top\n))', '.Top', 'hljs-property'],
    ['MsgBox(\n(\n    "Left: " MI.Left "\n    Top: " MI.Top\n))\nz := 3', '3', 'hljs-number'],
    ['x := (a + b)\ny := "s"', '"s"', 'hljs-string'],
    ['/* block\ncomment */\nx := 1', '/* block\ncomment */', 'hljs-comment'],
    ['class Foo extends Bar {\n}', 'Foo', 'hljs-title class_'],
    ['class Foo extends Bar {\n}', 'Bar', 'hljs-title class_'],
    ['x := A_Index', 'A_Index', 'hljs-variable language_'],
    ['n := 0xFF + 1.5', '0xFF', 'hljs-number'],
    ['switch x {\ncase 1: y := 2\n}', 'case', 'hljs-keyword'],
];

let failed = 0;
for (const [code, text, expected, nth] of cases) {
    const got = scopeOf(code, text, nth ?? 0);
    if (got !== expected) {
        failed++;
        console.log(`FAIL ${JSON.stringify(text)} in ${JSON.stringify(code)}\n     expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    }
}
console.log(`${cases.length - failed}/${cases.length} highlight checks passed`);
process.exit(failed ? 1 : 0);
