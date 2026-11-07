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
    { name: 'method read then write', code: 'x := 1\nclass A {\n    M() {\n        y := x\n        x := 2\n        return y\n    }\n}\n', rules: ['global-shadow'] },
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
    // undefined-name
    { name: 'misspelled built-in call', code: 'MsgBx "hi"\n', rules: ['undefined-name'], fixed: 'MsgBox "hi"\n' },
    { name: 'misspelled call expression', code: 'x := StrLne("abc")\n', rules: ['undefined-name'], fixed: 'x := StrLen("abc")\n' },
    { name: 'swapped letters in a variable', code: 'count := 1\nMsgBox cuont\n', rules: ['undefined-name'], fixed: 'count := 1\nMsgBox count\n' },
    { name: 'misspelled script function', code: 'Helper() => 1\nHelpr()\n', rules: ['undefined-name'], fixed: 'Helper() => 1\nHelper()\n' },
    { name: 'local typo suggests local', code: 'F() {\n    total := 1\n    return totl\n}\n', rules: ['undefined-name', 'unused-variable'], fixed: 'F() {\n    total := 1\n    return total\n}\n' },
    { name: 'built-in variables and classes', code: 'g := Gui()\nMsgBox A_ScriptDir A_Index\nx := Map()\nif IsSet(x)\n    MsgBox true\n', rules: [] },
    { name: 'misspelled A_ variable', code: 'MsgBox A_ScriptDri\n', rules: ['undefined-name'], fixed: 'MsgBox A_ScriptDir\n' },
    { name: 'no guess for unrelated name', code: 'MsgBox zzqqxx\n', rules: ['undefined-name'] },
    { name: 'include makes it info only', code: '#Include <Lib>\nHelperFromLib()\n', rules: ['undefined-name'] },
    { name: 'function defined later is fine', code: 'Later()\nLater() => 1\n', rules: [] },
    { name: 'global declared and set in function', code: 'Init() {\n    global cfg\n    cfg := 1\n}\nMsgBox cfg\n', rules: [] },
    // unused-variable
    { name: 'unused local', code: 'F() {\n    tmp := 5\n    return 1\n}\n', rules: ['unused-variable'] },
    { name: 'used local', code: 'F() {\n    tmp := 5\n    return tmp\n}\n', rules: [] },
    { name: 'for and catch vars are not flagged', code: 'F() {\n    for k, v in [1]\n        MsgBox v\n    try x := 1\n    catch as e\n        return\n}\n', rules: ['unused-variable'] },
    { name: 'closure reads the local', code: 'F() {\n    n := 1\n    return () => n\n}\n', rules: [] },
    // unreachable
    { name: 'after return', code: 'F() {\n    return 1\n    MsgBox "never"\n}\n', rules: ['unreachable'] },
    { name: 'label makes it reachable', code: 'goto Skip\nMsgBox "never"\nSkip:\nMsgBox "runs"\n', rules: ['unreachable'] },
    { name: 'hotkeys after auto-execute return', code: 'x := 1\nreturn\n^j::MsgBox x\nF() => 1\n', rules: [] },
    { name: 'after ExitApp', code: 'ExitApp\nMsgBox "never"\n', rules: ['unreachable'] },
    { name: 'return inside if', code: 'F(x) {\n    if x\n        return 1\n    return 2\n}\n', rules: [] },
    { name: 'assigning a built-in in a function', code: 'Copy() {\n    A_Clipboard := "x"\n    A_IconHidden := true\n}\n', rules: [] },
    { name: 'assume-global function', code: 'n := 0\nBump() {\n    global\n    n++\n    total := n\n}\nMsgBox total\n', rules: [] },
    { name: 'comment after return', code: 'F() {\n    return 1  ; done\n}\n', rules: [] },
    // arg-alias for operators, compound assignment and literals (results checked on AutoHotkey 2.1-alpha)
    { name: 'operator reads late', code: 'x := 1\ny := x + (x := 5)\n', rules: ['arg-alias'] },
    { name: 'concat reads late', code: 'x := "a"\ny := x . (x := "b")\n', rules: ['arg-alias'] },
    { name: 'compound reads late', code: 'x := 1\nx += (x := 5)\n', rules: ['arg-alias'] },
    { name: 'array literal reads late', code: 'x := 1\na := [x, x := 2]\n', rules: ['arg-alias'] },
    { name: 'object literal reads late', code: 'x := 1\no := {p: x, q: x := 2}\n', rules: ['arg-alias'] },
    { name: 'write on the left is fine', code: 'x := 1\ny := (x := 5) + x\n', rules: [] },
    { name: 'inner operator runs first', code: 'x := 1\ny := x * 10 + (x := 3)\n', rules: [] },
    { name: 'call runs first', code: 'F(a) => a\nx := 1\ny := F(x) + (x := 5)\n', rules: [] },
    { name: 'short circuit reads first', code: 'x := 0\ny := x || (x := 9)\n', rules: [] },
    // callback-arity fix
    { name: 'hotkey callback ()', code: 'Hotkey "F1", () => 0\n', rules: ['callback-arity'], fixed: 'Hotkey "F1", (*) => 0\n' },
    { name: 'onevent callback (c)', code: 'g := Gui()\ng.OnEvent("Size", (gui) => 0)\n', rules: ['callback-arity'], fixed: 'g := Gui()\ng.OnEvent("Size", (gui, *) => 0)\n' },
    { name: 'onmessage bare param', code: 'OnMessage(0x200, w => 0)\n', rules: ['callback-arity'], fixed: 'OnMessage(0x200, (w, *) => 0)\n' },
];

function rulesFor(code: string) {
    const r = parseSource(code);
    if (!r.tree) return { rules: ['(no tree)'], diags: r.diagnostics };
    const diags = [...r.diagnostics, ...lint(r.tree, code, undefined, { syntaxErrors: r.diagnostics.some(d => d.severity === 'error') })];
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
