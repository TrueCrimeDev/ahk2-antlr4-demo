// Command-line front end for the parser, lint rules and scope analysis.
// Built into cli/ahk-ast.mjs by "npm run build:cli"; needs only Node 18+.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseSource, Diagnostic, SrcRange } from './parse';
import { lint, LINT_RULES } from './lint';
import { buildModel, ViewNode } from './model';
import { altLabel } from './labels';
import { analyzeScopes, describeSymbol } from './scope';
import { applyEdits } from './fixes';

const HELP = `ahk-ast: parse and lint AutoHotkey v2 scripts with Descolada's ANTLR4 grammar.

Usage:
  node ahk-ast.mjs lint [--json] [--fix] [--strict] [--no-info] <file...>
  node ahk-ast.mjs ast [--collapse] <file>
  node ahk-ast.mjs symbols <file>
  node ahk-ast.mjs tokens <file>
  node ahk-ast.mjs rules

Use - as the file to read standard input.

lint     Problems as file:line:col: severity rule: message, or JSON with --json.
         --fix applies the one-click fixes to the files in place.
         Exit code 1 if there are errors (with --strict, warnings too), 2 on bad usage.
ast      The parse tree as JSON: kind, rule or token name, grammar label, text and range.
symbols  Variables, functions and classes with their scope and every reference, as JSON.
tokens   The token stream the parser reads, as JSON.
rules    The lint rules.

Lines and columns in output are 1-based; columns count characters.`;

function readInput(file: string): string {
    const raw = file === '-' ? readFileSync(0) : readFileSync(file);
    let text: string;
    if (raw[0] === 0xff && raw[1] === 0xfe) text = new TextDecoder('utf-16le').decode(raw.subarray(2));
    else text = new TextDecoder().decode(raw).replace(/^﻿/, '');
    return text.replace(/\r\n?/g, '\n');
}

const pos = (r: SrcRange) => ({ line: r.from.line + 1, column: r.from.col + 1, endLine: r.to.line + 1, endColumn: r.to.col + 1 });

function analyze(code: string) {
    const result = parseSource(code);
    const diagnostics: Diagnostic[] = [...result.diagnostics];
    if (result.tree) diagnostics.push(...lint(result.tree, code));
    diagnostics.sort((a, b) => a.range.from.line - b.range.from.line || a.range.from.col - b.range.from.col);
    return { result, diagnostics };
}

function cmdLint(files: string[], flags: Set<string>): number {
    let errors = 0, warnings = 0;
    const json: unknown[] = [];
    for (const file of files) {
        let code = readInput(file);
        let { diagnostics } = analyze(code);
        if (flags.has('--fix') && file !== '-') {
            // Apply fixes that don't overlap, then lint again.
            const taken: SrcRange[] = [];
            const overlaps = (a: SrcRange, b: SrcRange) => !(cmp(a.to, b.from) < 0 || cmp(b.to, a.from) < 0);
            const edits = diagnostics.filter(d => d.fix).flatMap(d => {
                const rs = d.fix!.edits.map(e => e.range);
                if (rs.some(r => taken.some(t => overlaps(r, t)))) return [];
                taken.push(...rs);
                return d.fix!.edits;
            });
            if (edits.length) {
                code = applyEdits(code, edits);
                writeFileSync(file, code);
                diagnostics = analyze(code).diagnostics;
                if (!flags.has('--json')) console.error(`${file}: applied ${edits.length} fix${edits.length === 1 ? '' : 'es'}`);
            }
        }
        if (flags.has('--no-info')) diagnostics = diagnostics.filter(d => d.severity !== 'info');
        for (const d of diagnostics) {
            if (d.severity === 'error') errors++;
            else if (d.severity === 'warning') warnings++;
        }
        if (flags.has('--json')) {
            json.push({
                file, diagnostics: diagnostics.map(d => ({
                    severity: d.severity, rule: d.rule, message: d.message, ...pos(d.range),
                    ...(d.docs ? { docs: d.docs } : {}),
                    ...(d.fix ? { fix: { title: d.fix.title, edits: d.fix.edits.map(e => ({ ...pos(e.range), text: e.text })) } } : {}),
                })),
            });
        } else {
            for (const d of diagnostics) {
                console.log(`${file}:${d.range.from.line + 1}:${d.range.from.col + 1}: ${d.severity} ${d.rule}: ${d.message}`);
            }
        }
    }
    if (flags.has('--json')) console.log(JSON.stringify(files.length === 1 ? json[0] : json, null, 2));
    else console.error(`${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);
    return errors || (flags.has('--strict') && warnings) ? 1 : 0;
}

function cmp(a: { line: number; col: number }, b: { line: number; col: number }) {
    return a.line - b.line || a.col - b.col;
}

function cmdAst(file: string, flags: Set<string>): number {
    const { result } = analyze(readInput(file));
    if (!result.tree || !result.parser) {
        console.error(result.diagnostics.map(d => d.message).join('\n'));
        return 1;
    }
    const model = buildModel(result.tree, result.parser, flags.has('--collapse'));
    const toJson = (n: ViewNode): unknown => ({
        kind: n.kind, name: n.name,
        ...(altLabel(n) ? { label: altLabel(n) } : {}),
        ...(n.text !== undefined ? { text: n.text } : {}),
        ...(n.range ? pos(n.range) : {}),
        ...(n.children.length ? { children: n.children.map(toJson) } : {}),
    });
    console.log(JSON.stringify(model.root ? toJson(model.root) : null, null, 2));
    return 0;
}

function cmdSymbols(file: string): number {
    const { result } = analyze(readInput(file));
    if (!result.tree) return 1;
    const info = analyzeScopes(result.tree);
    const symbols = [...info.symbols.values()].map(s => ({
        name: s.name, kind: s.kind, scope: s.scope.kind === 'global' ? 'global' : `${s.scope.kind} ${s.scope.name}`,
        description: describeSymbol(s, s.scope),
        ...(s.def ? { definition: pos(s.def.range) } : {}),
        references: s.refs.map(r => ({ ...pos(r.range), role: r.role, ...(r.op ? { op: r.op } : {}), ...(r.scope !== s.scope ? { from: r.scope.name } : {}) })),
    }));
    console.log(JSON.stringify(symbols, null, 2));
    return 0;
}

function cmdTokens(file: string): number {
    const { result } = analyze(readInput(file));
    const names = result.parser?.vocabulary;
    console.log(JSON.stringify(result.codeTokens.map(t => ({
        type: names?.getSymbolicName(t.type) ?? t.type, text: t.text, line: t.line, column: t.column + 1,
    })), null, 2));
    return 0;
}

function main(argv: string[]): number {
    const [cmd, ...rest] = argv;
    const flags = new Set(rest.filter(a => a.startsWith('--')));
    const files = rest.filter(a => !a.startsWith('--'));
    if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(HELP); return cmd ? 0 : 2; }
    if (cmd === 'rules') {
        for (const r of LINT_RULES) console.log(`${r.id.padEnd(16)} ${r.title}\n${' '.repeat(17)}${r.description}\n`);
        return 0;
    }
    if (!files.length) { console.error(`${cmd}: no file given. Run with --help for usage.`); return 2; }
    try {
        switch (cmd) {
            case 'lint': return cmdLint(files, flags);
            case 'ast': return cmdAst(files[0], flags);
            case 'symbols': return cmdSymbols(files[0]);
            case 'tokens': return cmdTokens(files[0]);
        }
    } catch (e: any) {
        console.error(e?.code === 'ENOENT' ? `File not found: ${e.path}` : String(e?.stack ?? e));
        return 2;
    }
    console.error(`Unknown command "${cmd}". Run with --help for usage.`);
    return 2;
}

process.exitCode = main(process.argv.slice(2));
