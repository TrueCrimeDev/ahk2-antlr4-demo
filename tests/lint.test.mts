// Lint rule checks: each case lists the rules it should trigger (and nothing else),
// and every fix must produce code that no longer triggers that rule.
// Run: npm run test:lint
import { parseSource } from '../src/parse.ts';
import { lint } from '../src/lint.ts';
import { applyEdits } from '../src/fixes.ts';

interface Case { name: string; code: string; rules: string[]; fixed?: string }

const CASES: Case[] = [
    // global-shadow
    { name: 'global ++ in function', code: 'count := 0\nBump() {\n    count++\n}\n', rules: ['global-shadow'],
      fixed: 'count := 0\nBump() {\n    global count\n    count++\n}\n' },
    { name: 'global += in function', code: 'total := 0\nAdd(n) {\n    total += n\n}\n', rules: ['global-shadow'] },
    { name: 'global ++ in one-line hotkey', code: 'count := 0\n^j::count++\n', rules: ['global-shadow'],
      fixed: 'count := 0\n^j::{\n    global count\n    count++\n}\n' },
    { name: 'global ++ in block hotkey', code: 'count := 0\n^j:: {\n    count++\n}\n', rules: ['global-shadow'] },
    { name: 'global declared', code: 'count := 0\nBump() {\n    global count\n    count++\n}\n', rules: [] },
    { name: 'local set first', code: 'count := 0\nBump() {\n    count := 5\n    count++\n}\n', rules: [] },
    { name: 'read only uses global', code: 'count := 0\nShow() {\n    return count + 1\n}\n', rules: [] },
    { name: 'closure updates outer', code: 'Outer() {\n    n := 0\n    f := () => n++\n    f()\n}\nn := 1\n', rules: [] },
    { name: 'method read then write', code: 'x := 1\nclass A {\n    M() {\n        y := x\n        x := 2\n    }\n}\n', rules: ['global-shadow'] },
    // name-conflict
    { name: 'assign over function', code: 'T() => 0\nt := 1\n', rules: ['name-conflict'] },
    { name: 'for var over function', code: 'T() => 0\nfor t in [1]\n    x := 1\n', rules: ['name-conflict'] },
    { name: 'assign over class', code: 'class Foo {\n}\nfoo := 1\n', rules: ['name-conflict'] },
    { name: 'nested function name', code: 'Outer() {\n    Inner() => 1\n    inner := 2\n}\n', rules: ['name-conflict'] },
    { name: 'local shadows global function', code: 'T() => 0\nF() {\n    t := 1\n    return t\n}\n', rules: [] },
    { name: 'built-in name is fine', code: 'log := []\n', rules: [] },
    // property-call
    { name: 'stored arrow called as method', code: 'o := {h: () => 1}\no.h()\n', rules: ['property-call'], fixed: 'o := {h: () => 1}\no.h.Call()\n' },
    { name: 'this.f in class', code: 'class H {\n    __New() {\n        this.f := (a) => a\n    }\n    Run() => this.f(1)\n}\n', rules: ['property-call'] },
    { name: 'stored arrow with self', code: 'o := {k: (self) => 1}\no.k()\n', rules: [] },
    { name: 'variadic stored', code: 'o := {k: (a*) => 1}\no.k()\n', rules: [] },
    { name: 'real method of same name', code: 'class Q {\n    h() => 1\n}\no := {h: () => 1}\no.h()\n', rules: [] },
    { name: 'call via .Call', code: 'o := {h: () => 1}\no.h.Call()\n', rules: [] },
    // string-compare
    { name: 'string <', code: 'x := 1\ny := "a" < x\n', rules: ['string-compare'], fixed: 'x := 1\ny := StrCompare("a", x) < 0\n' },
    { name: 'numeric string <', code: 'x := 1\ny := "10" < x\n', rules: [] },
    { name: 'string =', code: 'x := 1\ny := "a" = x\n', rules: [] },
    // space-index
    { name: 'string then [', code: 'MsgBox "Count: " [1, 2].Length\n', rules: ['space-index'], fixed: 'MsgBox "Count: " . [1, 2].Length\n' },
    { name: 'variable then [', code: 'arr := [1]\nx := arr [1]\n', rules: ['space-index'], fixed: 'arr := [1]\nx := arr[1]\n' },
    { name: 'explicit . join', code: 'x := "a " . [1, 2].Length\n', rules: [] },
    // callback-arity fix
    { name: 'hotkey callback ()', code: 'Hotkey "F1", () => 0\n', rules: ['callback-arity'], fixed: 'Hotkey "F1", (*) => 0\n' },
    { name: 'onevent callback (c)', code: 'g := Gui()\ng.OnEvent("Size", (gui) => 0)\n', rules: ['callback-arity'], fixed: 'g := Gui()\ng.OnEvent("Size", (gui, *) => 0)\n' },
    { name: 'onmessage bare param', code: 'OnMessage(0x200, w => 0)\n', rules: ['callback-arity'], fixed: 'OnMessage(0x200, (w, *) => 0)\n' },
];

function rulesFor(code: string) {
    const r = parseSource(code);
    if (!r.tree) return { rules: ['(no tree)'], diags: r.diagnostics };
    const diags = [...r.diagnostics, ...lint(r.tree, code)];
    return { rules: [...new Set(diags.map(d => d.rule))].sort(), diags };
}

let failed = 0;
for (const c of CASES) {
    const { rules, diags } = rulesFor(c.code);
    const want = [...c.rules].sort();
    let ok = JSON.stringify(rules) === JSON.stringify(want);
    let note = ok ? '' : `got [${rules}] want [${want}] ${diags.map(d => `${d.rule}@${d.range.from.line + 1}:${d.range.from.col + 1}`).join(' ')}`;
    for (const d of diags.filter(d => d.fix && c.rules.includes(d.rule))) {
        const fixed = applyEdits(c.code, d.fix!.edits);
        if (c.fixed !== undefined && fixed !== c.fixed) { ok = false; note += ` fix gave ${JSON.stringify(fixed)}`; }
        if (rulesFor(fixed).rules.includes(d.rule)) { ok = false; note += ` still ${d.rule} after fix: ${JSON.stringify(fixed)}`; }
    }
    if (c.fixed !== undefined && !diags.some(d => d.fix)) { ok = false; note += ' no fix offered'; }
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}${note ? '  ' + note : ''}`);
}
console.log(failed ? `${failed} of ${CASES.length} failed` : `${CASES.length}/${CASES.length} lint checks passed`);
process.exit(failed ? 1 : 0);
