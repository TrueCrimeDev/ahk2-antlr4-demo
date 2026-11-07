# AutoHotkey v2 AST Explorer

A fork of [Descolada/ahk2-antlr4-demo](https://github.com/Descolada/ahk2-antlr4-demo) that adds tools for reading and checking the parse tree from Descolada's AutoHotkey v2 ANTLR4 grammar.

**Live:** https://truecrimedev.github.io/ahk2-antlr4-demo/

## What this fork adds

- **Steps tab: evaluation order.** Put the cursor in an expression and step through it in the order AutoHotkey runs it, with each step marked in the editor. It models AutoHotkey's late variable reads, checked on v2.1-alpha.33: a plain variable is read when the operator, call or literal that uses it runs, so `x + (x := 5)` is 10; an assignment, `++x` or `(a, b)` gives the variable itself, so `(x := 1) + (x := 2)` is 4; `x++` gives the old value. A read that sees a variable changed after it appeared gets a warning. Short-circuit and ternary branches are labeled with when they run.
- **Search tab: structural search and replace.** Patterns are code with placeholders: `$name` matches any expression, `$$name` the rest of an argument list, and the same name twice must match the same code. Matching follows the parse tree, so spacing, comments and the letter case of names don't matter, and `SetTimer($fn, $ms)` also finds `SetTimer Tick, 100`. Replace one match or all of them (one Ctrl+Z undoes it), with a preview of each result.
- **Symbols tab.** Classes with their methods, properties and fields (static marked), functions, hotkeys, hotstrings and globals, with a fuzzy filter. The declaration around the cursor is highlighted; click or Enter jumps to it.
- **Calls tab.** A call graph of functions, methods and hotkeys, including callbacks registered with `SetTimer`, `OnEvent`, `Hotkey`, `OnMessage` and the like (dashed, labeled with the registering call), recursion, `Class()` calls to `__New`, and method calls matched by name when the receiver is unknown (dotted). Functions nothing calls are dimmed. Hover a box to see its callers and callees; click to go to it.
- **Ctrl+K command palette.** One box to jump to any symbol (`@`), open an example (`#`) or run a command (`>`): switch tabs, fix all problems, next problem (F8), rename, share, export, fold. Ctrl+Shift+P opens it on commands.
- **Graph folding and export.** Double-click a box (or use Fold) to collapse its subtree into a dashed box that says how many nodes it hides; Unfold all brings them back. Export the syntax tree or the call graph as SVG or a 2× PNG.
- **Hover cards.** Hovering code shows what a name is (with its definition line, colored like the editor), any problems there with their Fix buttons, and how the parser read that spot, with a link to show it in the tree. Graph boxes get cards with their kind, grammar label, merged chain and position. Buttons and gutter dots get styled tips with key caps for shortcuts, in place of the browser's plain tooltips.
- **Lint checks with one-click fixes.** Ten rules, each based on behavior checked on AutoHotkey 2.1-alpha (see the table below). Problems with an obvious repair get a **Fix** button in the Problems list and in the gutter hint; Ctrl+Z undoes it.
- **Scope-aware references.** Put the cursor on a name to highlight every use of that same variable, following AutoHotkey's rules: assume-local functions, `global` declarations, parameters, and closures that share an outer function's variables. The bar under the editor says what the name is ("local variable of Bump", "parameter of Outer, captured by this closure", "function", ...). **Ctrl+click** or **F12** jumps to the definition; **F2** renames every reference.
- **Share links and files.** **Share** copies a link with the code compressed into it (an unedited example gets a short `#ex=` link). **Open…** or dropping a file on the editor loads an `.ahk` file (UTF-8, UTF-8 with BOM or UTF-16). Shared and opened code goes into its own slot, so it never replaces "Your code".
- **Command-line linter** for scripts, CI and AI coding harnesses: see below.
- **Examples picker.** A dropdown above the editor with Weird AHK parser edge cases, lint demos and a syntax tour, plus ‹ › buttons to step through them. Each one has a note on how AutoHotkey reads it and where this grammar disagrees. "Your code" keeps your own script, edits to an example are kept (with Reset to restore it), and `#ex=<id>` links open an example, e.g. [`#ex=insane-pipes`](https://truecrimedev.github.io/ahk2-antlr4-demo/#ex=insane-pipes).
- **Click-to-source linking.** Click a node in the graph or outline to highlight its code. Move the editor cursor to mark the deepest node under it. A breadcrumb shows the selected node's path; click any part to select that ancestor.
- **Problems panel.** Lexer and parser errors appear with positions instead of replacing the tree, plus the lint rules, all marked in the editor gutter and underlined.
- **Graph view** with drag to pan, wheel or pinch to zoom, and Fit / 1:1 buttons.
  - Boxes are colored by kind (statement, declaration, expression, literal, name, directive, structure), with a key in the corner.
  - Boxes show the grammar's labeled alternative when there is one, such as `AssignmentExpression` or `FunctionCallAccess` instead of `singleExpression`.
  - **Merge chains** (on by default) draws each chain of single-child rules as one box, with the wrapper rules in small gray text, and drops empty `eos` leaves. This roughly halves the number of boxes. Hover a box for its full chain.
  - Tokens are dark code chips colored exactly like the editor's highlighting.
  - Clicking a box selects its code and fades everything outside its subtree; click empty space to clear. Hovering a box marks its code in the editor.
- **Outline view.** A collapsible text tree with line:column positions. It handles programs too large for Graphviz.
- **Tokens view.** The exact token stream the parser reads after whitespace preprocessing, or every lexer token including hidden-channel comments and whitespace.
- **Node search** across the graph and outline, with Enter / Shift+Enter to step through matches.
- **Syntax highlighting** with the highlight.js 11.9 grammar and VS Code Dark+ colors from [AHKv2_LLMs](https://truecrimedev.github.io/AHKv2_LLMs/). `src/vendor/highlight-ahk2.js` starts from that repo's copy, with fixes found by checking it against the ANTLR lexer on about 1,300 scripts: keywords in any case, strings that can't run past their line, continuation sections, hotkeys and hotstrings. The header of the file lists the changes.
- **Lint hints in the gutter.** Click or tap a colored dot next to a line number to see that line's problems, with docs links; click a problem to select its code.
- The TrueCrimeAudit dark design: an almost-black app bar and editor, charcoal page, #262626 cards, bright blue (#3B82F6) for active and focus states, Inter type, 6px corners and very soft shadows. Graph kinds use the TrueCrimeAudit accents (purple, teal, indigo, orange, cyan, pink). Also a phone layout, and your code and edited examples saved in the browser between visits.

## Lint rules

| Rule | Checks |
|:--|:--|
| `arg-alias` | A plain variable passed as an argument, used as an operand, or put in an array or object literal is not read until the call, operator or literal runs, so a later part that assigns, increments or `&`-references it changes the value used. `x := 1, Pair(x, x := 2)` passes `[2, 2]` and `x + (x := 5)` gives 10. See the known limitation under [Parameters](https://www.autohotkey.com/docs/alpha/Functions.htm#param). |
| `global-shadow` | Functions and hotkeys are assume-local, so `count++` or `total += x` on a global without `global count` changes a new local that has no value: "This local variable has not been assigned a value." Fix: add the `global` line (one-line hotkeys get a block). |
| `name-conflict` | Names ignore case, and a function or class name can't be assigned in the scope that defines it, so `t := 1` next to `T()` stops the script from loading ("This Func cannot be assigned a value."). Covers `:=`, `+=`, `++`, `for`, `catch` and `&`. Locals that shadow a global function are fine. |
| `property-call` | `obj.f()` passes `obj` as a hidden first argument, so a function stored with `obj.f := () => ...` or `{f: () => ...}` throws "Too many parameters passed to function." Fix: `obj.f.Call()`. |
| `string-compare` | `<`, `>`, `<=` and `>=` throw TypeError ("Expected a Number but got a String") on non-numeric strings in v2.1. Fix: `StrCompare(a, b) < 0`. |
| `space-index` | `value [1]` indexes `value` even with the space, so `"Total: " [1, 2].Length` throws PropertyError. This grammar shows a concatenation there instead. Fix: join with `.`, or remove the space. |
| `undefined-name` | A name that is read or called but never assigned, defined or built in (the built-in list comes from the AutoHotkey language server's definitions). AutoHotkey only warns at load ("This global variable appears to never be assigned a value") and throws UnsetError when the line runs. Fix: the closest defined or built-in name, such as `MsgBx` to `MsgBox`. Errors for calls, warnings for reads, info when the script has `#Include`. |
| `unused-variable` | A local that a function, method or hotkey assigns but never reads. |
| `unreachable` | Lines after `return`, `throw`, `break`, `continue`, `goto`, `Exit` or `ExitApp` in the same block, with no label in between. |
| `callback-arity` | `Hotkey`, `HotIf`, `SetTimer`, `OnMessage`, `OnClipboardChange`, `OnError`, `OnExit`, Gui `OnEvent` / `OnNotify` / `OnCommand` and `Menu.Add` check a callback's parameters when it is registered and throw "Invalid callback function" if it can't accept what they pass. Checked for inline fat-arrow functions and for functions declared in the script. Parameter counts come from AutoHotkey's `ValidateFunctor` call sites. Fix for inline fat arrows: add `*`. |

## Command-line linter

`cli/ahk-ast.mjs` is a single-file build of the parser, lint rules and scope analysis. It needs only Node 18 or later.

```sh
node cli/ahk-ast.mjs lint script.ahk              # script.ahk:3:5: warning global-shadow: ...
node cli/ahk-ast.mjs lint --json a.ahk b.ahk      # machine-readable, with fixes as edits
node cli/ahk-ast.mjs lint --fix script.ahk        # apply the one-click fixes in place
node cli/ahk-ast.mjs ast script.ahk               # parse tree as JSON, with grammar labels
node cli/ahk-ast.mjs symbols script.ahk           # variables/functions/classes, scopes, references
node cli/ahk-ast.mjs outline script.ahk           # declarations as a tree, as JSON
node cli/ahk-ast.mjs calls --dot script.ahk       # call graph as Graphviz DOT (JSON without --dot)
node cli/ahk-ast.mjs search 'SetTimer($fn, $ms)' --replace 'SetTimer($fn, -$ms)' --write *.ahk
node cli/ahk-ast.mjs steps script.ahk 12:5        # evaluation order of the expression at line 12, column 5
node cli/ahk-ast.mjs rules
```

`lint` exits with 1 when there are errors (add `--strict` to count warnings too) and 2 on bad usage. `search` exits with 1 when nothing matches. Use `-` as the file name to read standard input.

## Development

```sh
npm install
npm start          # dev server
npm run typecheck
npm run test:highlight                      # targeted highlighting checks
npm run test:lint                           # lint rules and their fixes
npm run test:features                       # evaluation order, structural search, symbols, call graph
npm run check:highlight-corpus -- <folder>  # compare highlighting with the lexer on your .ahk files
npm run build      # writes the site to docs/, a root index.html that loads it, and cli/ahk-ast.mjs
```

Source layout:

| File | Purpose |
|:--|:--|
| `src/lexing.ts` | Token preprocessing from the original demo |
| `src/parse.ts` | Lexing and parsing with positioned diagnostics |
| `src/model.ts` | Display tree, source ranges, collapse logic |
| `src/lint.ts` | Lint rules and fixes |
| `src/scope.ts` | Scopes, symbols and references |
| `src/builtins.ts` | Built-in function, class and variable names |
| `src/symbols.ts` | Document symbols and the call graph |
| `src/search.ts` | Structural search patterns and replacement |
| `src/evaluate.ts` | Evaluation-order steps |
| `src/callsdot.ts` | Call graph DOT |
| `src/symbolsview.ts`, `src/callsview.ts`, `src/searchview.ts`, `src/stepsview.ts` | Symbols, Calls, Search and Steps tabs |
| `src/palette.ts` | Ctrl+K command palette |
| `src/exportsvg.ts` | SVG and PNG export |
| `src/cli.ts` | Command-line linter (built to `cli/ahk-ast.mjs`) |
| `src/examples.ts` | Example scripts for the picker |
| `src/graph.ts`, `src/outline.ts`, `src/tokens.ts` | Views |
| `src/highlight.ts` | Applies highlight.js output to the editor |
| `src/tooltip.ts` | Tooltips and hover cards |
| `src/index.ts` | Editor and UI wiring |
| `src/index.html` | Page source; the root `index.html` is generated by the build |

The grammar in `src/grammar` and the generated parser in `src/parser` are unchanged from upstream.
