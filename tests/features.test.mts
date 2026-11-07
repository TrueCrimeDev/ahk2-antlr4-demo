// Checks for the Steps, Search, Symbols and Calls features.
// Run: npm run test:features
import { parseSource } from '../src/parse.ts';
import { analyzeScopes } from '../src/scope.ts';
import { expressionAt, evaluationSteps } from '../src/evaluate.ts';
import { compilePattern, findMatches, replaceEdits } from '../src/search.ts';
import { documentSymbols, callGraph } from '../src/symbols.ts';
import { applyEdits } from '../src/fixes.ts';

let failed = 0, total = 0;
function check(name: string, got: unknown, want: unknown) {
    total++;
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
}

// ---------------------------------------------------------------------------
// Steps. Each expectation follows what AutoHotkey v2.1-alpha.33 printed for the expression;
// "!" marks a read that sees a value changed after the operand appeared.

const STEP_CASES: [string, string][] = [
    ['y := x + (x := 5)', 'Store in x | Read x! | Read x | Add | Store in y'],                   // 10
    ['y := (x := 1) + (x := 2)', 'Store in x | Store in x | Read x! | Read x | Add | Store in y'], // 4
    ['y := F(x) + (x := 5)', 'Read x | Call F | Store in x | Read x | Add | Store in y'],         // 6
    ['y := x++ + x', 'Add 1 to x | Read x | Add | Store in y'],                                  // 3
    ['y := [x, x := 2]', 'Store in x | Read x! | Read x | Build an array of 2 items | Store in y'], // [2, 2]
    ['o.p := (o := o2, 7)', 'Read o2 | Store in o | Read o! | Set o.p'],                          // sets p on o2
    ['y := -x + (x := 4)', 'Read x | Negate | Store in x | Read x | Add | Store in y'],           // 3
    ['y := arr[i] + (i := 2)', 'Read arr | Read i | Index arr | Store in i | Read i | Add | Store in y'], // 12
    ['n := m and (m := 0)', 'Read m | Test m | Store in m | Read m! | Store in n'],              // 0
    ['v := (1 ? x : 0) + (x := 5)', 'Test 1 | Store in x | Read x! | Read x | Add | Store in v'], // 10
    ['v := s " " (s := "b")', 'Read s | Join (concatenate) | Store in s | Read s | Join (concatenate) | Store in v'], // "a b"
    ['v := y ** (y := 2)', 'Store in y | Read y! | Read y | Raise to a power | Store in v'],     // 4
    ['v := (c++) + (c := 9)', 'Add 1 to c | Store in c | Read c | Add | Store in v'],            // 10
    ['v := (++d) + (d := 9)', 'Add 1 to d | Store in d | Read d! | Read d | Add | Store in v'],  // 18
    ['v := (h, h) + (h := 4)', 'Store in h | Read h! | Read h | Add | Store in v'],              // 8
    ['obj.M(x, x := 2)', 'Store in x | Read obj | Read x! | Read x | Call method M of obj'],     // 2, 2
    ['G(x := 1, x := 2)', 'Store in x | Store in x | Read x! | Read x | Call G'],                // 2,2
    ['v := {p: x, q: x := 2}', 'Store in x | Read x! | Read x | Build an object with p, q | Store in v'], // 2, 2
    ['f := (a) => a + x', 'Create a function | Store in f'],
    ['MsgBox "n=" n', 'Read n | Join (concatenate) | Call MsgBox'],
];

const support = '\nF(v) => v\nG(a, b) => a\n';
for (const [line, want] of STEP_CASES) {
    const code = line + support;
    const r = parseSource(code);
    const expr = r.tree ? expressionAt(r.tree, { line: 0, col: 1 }) : null;
    const ev = expr ? evaluationSteps(expr, code, analyzeScopes(r.tree!)) : null;
    check(`steps: ${line}`, ev?.steps.map(s => s.title + (s.warn ? '!' : '')).join(' | '), want);
}

{
    const code = 'if (a := Check()) && a.ok\n    MsgBox "yes"\n';
    const r = parseSource(code);
    const expr = expressionAt(r.tree!, { line: 0, col: 12 });
    const ev = evaluationSteps(expr!, code, analyzeScopes(r.tree!));
    check('steps: if condition is its own expression', ev.code, '(a := Check()) && a.ok');
    check('steps: short-circuit branch is marked', ev.steps.filter(s => s.when).map(s => s.when), ['only if (a := Check()) is true', 'only if (a := Check()) is true']);
    const arrowCode = 'f := () => x + 1\n';
    const inArrow = expressionAt(parseSource(arrowCode).tree!, { line: 0, col: 12 });
    check('steps: cursor in a fat arrow body steps through the body', inArrow && evaluationSteps(inArrow, arrowCode, null).code, 'x + 1');
}

// ---------------------------------------------------------------------------
// Structural search

const SEARCH_CODE = `SetTimer(Tick, 1000)
SetTimer Tock,   -50  ; command form
x := x + 1
count := count + 1
y := x + 2
MsgBox("a", "b", 64)
MsgBox "only"
if (a = b)
    MsgBox "eq"
s := "A"
Pair(v, v := 2)
`;

function search(pattern: string) {
    const r = parseSource(SEARCH_CODE);
    const p = compilePattern(pattern);
    if (typeof p === 'string') return { error: p };
    const ms = findMatches(r.tree!, p, SEARCH_CODE);
    return { lines: ms.map(m => m.range.from.line + 1), bindings: ms.map(m => Object.fromEntries([...m.bindings].map(([k, v]) => [k, v.text]))), ms };
}

check('search: call pattern matches command form too', search('SetTimer($fn, $ms)').bindings, [{ $fn: 'Tick', $ms: '1000' }, { $fn: 'Tock', $ms: '-50' }]);
check('search: repeated placeholder must match the same code', search('$x := $x + 1').lines, [3, 4]);
check('search: $$rest takes the remaining arguments', search('MsgBox($$args)').bindings, [{ $$args: '"a", "b", 64' }, { $$args: '"only"' }, { $$args: '"eq"' }]);
check('search: names ignore case', search('msgbox($m)').lines, [7, 9]);
check('search: strings keep case', search('$v := "a"').lines, []);
check('search: aliasing pattern', search('$f($a, $a := $b)').bindings, [{ $f: 'Pair', $a: 'v', $b: '2' }]);
check('search: bad pattern explains', typeof search('x +').error, 'string');
check('search: bare placeholder is refused', search('$z').error, 'A pattern needs some fixed code around its $ placeholders.');
{
    const { ms } = search('$x := $x + 1');
    check('search: replace fills placeholders', applyEdits(SEARCH_CODE, replaceEdits(ms!, '$x += 1')).split('\n').slice(2, 4), ['x += 1', 'count += 1']);
}

// ---------------------------------------------------------------------------
// Symbols and calls

const SYM_CODE = `count := 0
class Counter extends Object {
    static Created := 0
    __New(start := 0) {
        this.n := start
        Log("new")
    }
    Inc() => ++this.n
    Value {
        get => this.n
    }
}
Log(msg) {
}
Tick() {
    global count
    count++
    c := Counter()
    c.Inc()
}
Recurse(n) => n ? Recurse(n - 1) : 0
SetTimer(Tick, 100)
^j::Tick()
::btw::by the way
g := Gui()
g.OnEvent("Close", Quit)
Quit(*) => ExitApp()
Unused() => 0
`;
{
    const r = parseSource(SYM_CODE);
    const scopes = analyzeScopes(r.tree!);
    const syms = documentSymbols(r.tree!, scopes, SYM_CODE);
    const flat = (items: typeof syms, depth = 0): string[] => items.flatMap(s => [`${'  '.repeat(depth)}${s.kind} ${s.name}${s.isStatic ? ' static' : ''}`, ...flat(s.children, depth + 1)]);
    check('symbols: tree', flat(syms), [
        'class Counter', '  field Created static', '  method __New', '  method Inc', '  property Value',
        'function Log', 'function Tick', 'function Recurse', 'hotkey ^j', 'hotstring ::btw::', 'function Quit', 'function Unused',
        'variable count', 'variable g',
    ]);
    check('symbols: class detail', syms[0].detail, 'extends Object');
    check('symbols: hotstring expansion', syms.find(s => s.kind === 'hotstring')?.detail, '→ by the way');

    const g = callGraph(r.tree!, scopes);
    const label = (id: string) => g.nodes.find(n => n.id === id)?.label ?? id;
    const edges = g.edges.map(e => `${label(e.from)} -> ${label(e.to)} ${e.via}${e.guess ? '?' : ''}`).sort();
    check('calls: edges', edges, [
        'Auto-execute -> Quit() OnEvent',
        'Auto-execute -> Tick() SetTimer',
        'Counter.__New -> Log() call',
        'Recurse() -> Recurse() call',
        'Tick() -> Counter.Inc call?',
        'Tick() -> Counter.__New call',
        '^j -> Tick() call',
    ]);
    check('calls: unused function is still a node', g.nodes.some(n => n.label === 'Unused()'), true);
    check('calls: properties without calls are dropped', g.nodes.some(n => n.kind === 'property'), false);
}

console.log(failed ? `${failed} of ${total} feature checks failed` : `${total}/${total} feature checks passed`);
process.exit(failed ? 1 : 0);
