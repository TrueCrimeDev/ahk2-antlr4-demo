export interface Example {
    id: string;
    group: string;
    title: string;
    /** One line shown under the picker. */
    note: string;
    code: string;
}

const WEIRD = 'Weird AHK: parser edge cases';
const LINT = 'Lint checks';
const SYNTAX = 'Syntax tour';

// The Weird AHK cases are from TrueCrimeDev's Weird_AHK collection. Comments describe
// how AutoHotkey reads each case; the tree shows how this grammar reads it.
export const EXAMPLES: Example[] = [
    {
        id: 'remaps-hotstrings',
        group: WEIRD,
        title: 'Remaps and hotstrings made of colons',
        note: 'AutoHotkey accepts every line. This grammar\'s lexer rejects the ; in ::a::b; so no tree is drawn. Delete that line to see the rest.',
        code: `; A comment, followed by a colon->semicolon remap, followed by a semicolon->colon remap:
;:::
:::;
\`;:::

; Hotstring expanding to b;
::a::b;

; Hotstring expanding to b, followed by a comment
::c::b ;
`,
    },
    {
        id: 'call-vs-assign',
        group: WEIRD,
        title: 'Call statement, then assignment over three lines',
        note: 'A bare identifier on its own line is a call. The next three lines join into one assignment.',
        code: `; Function call statement for c without arguments, followed by an assignment expression statement:
; (c must hold a callable value here: a bare identifier statement is always parsed as a call.)
c := (*) => 0
c
b
:=
1
`,
    },
    {
        id: 'precedence',
        group: WEIRD,
        title: 'not, &&, ternary and concatenation in one line',
        note: 'Expected: MsgBox(b := (((not 1) && 2) ? 0 : (1 . 2)))',
        code: `; Some operator precedence which should be parsed as MsgBox(b := (((not 1) && 2) ? 0 : (1 . 2))):
MsgBox b := not 1 && 2 ? 0 : 1 2
`,
    },
    {
        id: 'dangling-else',
        group: WEIRD,
        title: 'Dangling else',
        note: 'The else belongs to the nearest if (if 3), not the outer one.',
        code: `; Dangling else:
if 1
  if 3
    MsgBox 4
  else
    MsgBox 5
`,
    },
    {
        id: 'labels-switch',
        group: WEIRD,
        title: 'default: as a label vs. a switch clause',
        note: 'Outside the switch, default: is a label; inside it, the default clause. d: inside the switch is a label.',
        code: `; Some switch and label handling:
d := 1
loopCount := 0
goto default
MsgBox "skipped"
default: ; Should be parsed as a label
switch 1 {
  case d:
    MsgBox 3
    loopCount += 1
    if loopCount < 3
        goto default ; Resolves to the outer label, not the switch's own default clause
  default: ; Should not be called, but parsed as switch default clause
    goto d
    MsgBox 1
    d: ; Should be parsed as a label
    MsgBox 2
}
`,
    },
    {
        id: 'deref-call',
        group: WEIRD,
        title: 'Dynamic deref in a call statement',
        note: 'Expected: a((%(&b)%) . (c & d)), so & binds tighter than the implicit concatenation.',
        code: `; More operator precedence (the function call should be parsed as a((%(&b)%) . (c & d))):
b := 2, c := 1, d := 2
a %&b% c & d
a(b) => MsgBox(b)
`,
    },
    {
        id: 'call-vs-loop',
        group: WEIRD,
        title: 'Name (args) { } : function expression or loop?',
        note: 'In v2.1, CallMe (a := 1) { } passes an unnamed function to CallMe and Loop (x := 1) { } loops once. This grammar targets v2.0 and reports syntax errors.',
        code: `; Function call statement taking an anonymous function expression as an argument (with a default for a).
CallMe (a := 1) {
    MsgBox a
}
CallMe(f) => f("hello")

; ...whereas this should be a loop statement with the evaluated expression being an assignment expression:
Loop (x := 1) {
  MsgBox a
}
`,
    },
    {
        id: 'object-literal-member',
        group: WEIRD,
        title: 'Object literal member access across lines',
        note: 'AutoHotkey reads the braces as an object literal argument and shows "b". This grammar reports syntax errors here.',
        code: `; Function call statement with object literal member access:
MsgBox {
  a: "b"
}.a
`,
    },
    {
        id: 'callables',
        group: WEIRD,
        title: 'Functions, closures and callable objects',
        note: 'MsgBox is a Func, a nested function that captures a is a Closure, and {Call: ...} is callable.',
        code: `MsgBox "MsgBox is Func: " (MsgBox is Func)

MyFunc()

MyFunc() {
    a := 1
    MsgBox "MyClosure is Func: " (MyClosure is Func)
    MyClosure() => a
}

c := {Call: (*) => ToolTip("Hello, I'm a callable object")}
c()

MsgBox "Callable object: " HasMethod(c)
MsgBox "Built-in function: " HasMethod(MsgBox)
`,
    },
    {
        id: 'insane-pipes',
        group: WEIRD,
        title: 'Insane pipes: [] as a pipeline operator',
        note: '_(x)[F][G] calls __Item with each function as the key, so brackets chain calls left to right.',
        code: `class _ {
    __New(Value) {
        this.Value := Value
    }

    ; _(Val)[Func] calls __Item with the function as the key
    __Item[Function] {
        get {
            return _(Function(this.Value))
        }
    }
}

StrReverse(S) {
    Result := ""
    Loop Parse, String(S)
        Result := A_LoopField . Result
    return Result
}

Double(N) => N * 2
Sum(Arr) {
    Total := 0
    for N in Arr
        Total += N
    return Total
}
MapArr(Arr, Fn) {
    Result := []
    for Item in Arr
        Result.Push(Fn(Item))
    return Result
}

; "AutoHotkey" -> StrUpper -> StrReverse -> MsgBox
_("AutoHotkey")[StrUpper][StrReverse][MsgBox]

; [1, 2, 3] -> double each -> Sum -> MsgBox (12)
_([1, 2, 3])[(Arr) => MapArr(Arr, Double)][Sum][MsgBox]
`,
    },
    {
        id: 'arg-alias',
        group: LINT,
        title: 'Argument changed before the call',
        note: 'A plain variable argument is read when the call runs, so a later argument that changes it wins.',
        code: `; Type AutoHotkey v2 code here to see its AST.
; Click a tree node to highlight its code, or move the cursor to find its node.

#Requires AutoHotkey v2.0

x := 1
Pair(x, x := 2)        ; warning: x is read after x := 2 runs
Pair(x + 0, x := 2)    ; fine: x + 0 is a new value

Hotkey "F1", () => MsgBox("hi")   ; error: Hotkey passes 1 argument

Pair(a*) => a
`,
    },
    {
        id: 'arg-alias-variants',
        group: LINT,
        title: 'Argument aliasing variants',
        note: 'Each flagged line passes a variable that another argument changes. Real results noted per line.',
        code: `x := 1, Pair(x, x++)             ; [2, 1]  x++ is a value, x is read last
x := 1, Pair(x++, x)             ; [1, 2]  fine: the change happens before x
x := 1, Pair(x, ++x)             ; [2, 2]
x := 1, Pair(x, x := 2, x := 3)  ; [3, 3, 3]
x := 1, Pair(x, Inc(&x))         ; [2, 2]  &x lets Inc change it
x := 1, Pair((x), x := 2)        ; [2, 2]  parentheses don't help
x := 1, Pair(Val(x), x := 2)     ; [1, 2]  fine: Val returns a value

o := {x: 1}, Pair(o.x, o.x := 2) ; [1, 2]  fine: properties are read right away

Pair(a*) => a
Inc(&v) => ++v
Val(v) => v
`,
    },
    {
        id: 'eval-order',
        group: LINT,
        title: 'Evaluation order (open the Steps tab)',
        note: 'Put the cursor on a line and open Steps to see when each variable is read. The results are what AutoHotkey v2.1 prints.',
        code: `; Put the cursor on a line, then open the Steps tab to watch AutoHotkey run it.
; The numbers are what AutoHotkey v2.1 prints for y.
x := 1, y := x + (x := 5)           ; 10: x is read when + runs, after x := 5
x := 1, y := (x := 1) + (x := 2)    ; 4: an assignment gives the variable, not a copy
x := 1, y := F(x) + (x := 5)        ; 6: F(x) runs before x changes
x := 1, y := x++ + x                ; 3: x++ gives the old value, then x is 2
x := 1, y := -x + (x := 4)          ; 3: -x is computed right away
x := 1, y := [x, x := 2]            ; [2, 2]: items are read when the array is built
x := 3, y := (x || 0) + (x := 5)    ; 10: || gives the variable it picked
s := "a", y := s " " (s := "b")     ; "a b": s " " is joined right away

F(v) => v
`,
    },
    {
        id: 'typos-dead-code',
        group: LINT,
        title: 'Typos, unused variables and dead code',
        note: 'Misspelled names get a "Did you mean" fix. Fix all problems at once from the Ctrl+K menu.',
        code: `#Requires AutoHotkey v2.0
greeting := "hello"
MsgBx(greeting)                     ; error: no MsgBx; did you mean MsgBox?
size := StrLne(greeting)            ; error: did you mean StrLen?
ToolTip "Size: " size

Average(values) {
    total := 0
    cuont := 0                      ; info: cuont is set but never read
    for v in values
        total += v
    return total / values.Length
    MsgBox "done"                   ; warning: never runs, it comes after return
}

MsgBox Average([1, 2, 3])
MsgBox Avrage([4, 5])               ; error: did you mean Average?
`,
    },
    {
        id: 'callback-arity',
        group: LINT,
        title: 'Callback parameter counts',
        note: 'Each flagged callback throws "Invalid callback function" when registered. The others are valid.',
        code: `g := Gui()
btn := g.AddButton(, "OK")
btn.OnEvent("Click", () => 0)          ; error: Click passes 2 or 3
btn.OnEvent("Click", (ctrl, *) => 0)   ; fine
g.OnEvent("Close", (g) => 0)           ; fine: Close passes 1
g.OnEvent("Size", (g, mm, w) => 0)     ; error: Size passes 4

SetTimer(Tick, 100)                    ; error: SetTimer passes none
Tick(n) => 0

OnMessage(0x4A, (w) => 0)              ; error: OnMessage passes 4
OnMessage(0x4A, (w, l, msg, hwnd) => 0)

Hotkey "F1", () => 0                   ; error: Hotkey passes the key name
Hotkey "F2", (*) => 0                  ; fine

m := Menu()
m.Add("Open", (*) => 0)                ; fine
m.Add("Save", () => 0)                 ; warning: Menu.Add passes 3
`,
    },
    {
        id: 'more-checks',
        group: LINT,
        title: 'Globals, names, stored functions, < and [',
        note: 'Each flagged line fails on AutoHotkey v2.1. Use a problem\'s Fix button to repair it, and put the cursor on count to see which counts are the same variable.',
        code: `count := 0
Bump() {
    count++                         ; warning: this count is a new local
}
^F1::count++                        ; same problem in a hotkey

o := {greet: () => "hi"}
o.greet()                           ; error: o is passed as a hidden first argument

if ("apple" < "banana")             ; warning: < throws on strings in v2.1
    MsgBox "sorted"

MsgBox "Items: " [1, 2, 3].Length   ; warning: this indexes the string

Total() => 0
total := 5                          ; error: total is the function Total
`,
    },
    {
        id: 'hotkeys-directives',
        group: SYNTAX,
        title: 'Hotkeys, hotstrings and directives',
        note: 'Labels, auto-replace text, X hotstrings, #HotIf expressions and literal directive arguments.',
        code: `#Requires AutoHotkey v2.0
#SingleInstance Force
#Include *i <JSON>

^j::MsgBox "Ctrl+J"
~LButton & RButton::ToolTip "both"
F1 up::Send "{F1 up}"
a::b

::btw::by the way
:*:]d::today's date  ; auto-replace text, then a comment
:X:ts::Send(FormatTime(, "yyyy-MM-dd"))

#HotIf WinActive("ahk_exe notepad.exe")
^s::MsgBox "Notepad only"
#HotIf
`,
    },
    {
        id: 'continuation',
        group: SYNTAX,
        title: 'Continuation sections',
        note: 'Lines inside ( ) are joined, so a string can span them.',
        code: `text := "
(
    Line one with "quotes"
    Line two
)"

MsgBox(
(
    "Left: " 10 "
    Top: " 20
))

total := 1
    + 2
    + 3
`,
    },
    {
        id: 'classes',
        group: SYNTAX,
        title: 'Classes, properties and meta-functions',
        note: 'Static and instance members, get/set, fat-arrow properties, __Item and __Enum.',
        code: `class Counter extends Object {
    static Created := 0
    count := 0

    __New(start := 0) {
        this.count := start
        Counter.Created += 1
    }

    Value {
        get => this.count
        set => this.count := value
    }

    Double => this.count * 2

    __Item[i] => this.count + i

    Inc(&by := 1) {
        this.count += by
        return this
    }

    __Enum(n) {
        i := 0
        return (&v) => (++i <= this.count && (v := i, true))
    }
}

c := Counter(2)
c.Inc().Inc()
for v in c
    ToolTip v
MsgBox c.Value " " c.Double " " c[10]
`,
    },
    {
        id: 'control-flow',
        group: SYNTAX,
        title: 'Loops, try/catch and switch',
        note: 'Loop sub-commands, until, try/catch/finally with as, and switch with a default clause.',
        code: `Loop Files A_ScriptDir "\\*.ahk"
    ToolTip A_LoopFileName

Loop Parse, "a,b,c", ","
    MsgBox A_LoopField

n := 0
Loop {
    n++
} Until n >= 3

try {
    throw ValueError("bad", -1)
} catch ValueError as e {
    MsgBox e.Message
} finally {
    ToolTip
}

switch n {
    case 1, 2: MsgBox "small"
    case 3: MsgBox "three"
    default: MsgBox "other"
}
`,
    },
];

export function exampleById(id: string): Example | undefined {
    return EXAMPLES.find(e => e.id === id);
}
