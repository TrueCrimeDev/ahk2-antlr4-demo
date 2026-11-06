import * as Parser from './parser/AutoHotkeyParser';
import type { ViewNode } from './model';

/** Labeled grammar alternatives (# AssignmentExpression etc.) by context class. */
const ALT_LABELS = new Map<Function, string>();
for (const [name, value] of Object.entries(Parser)) {
    if (typeof value === 'function' && name.endsWith('Context')) ALT_LABELS.set(value, name.slice(0, -'Context'.length));
}

/** The grammar's label for this alternative (AssignmentExpression, FunctionCallAccess, ...), if it has one. */
export function altLabel(n: ViewNode): string | null {
    if (n.kind !== 'rule') return null;
    const label = ALT_LABELS.get((n.tree as object).constructor);
    return label && label.toLowerCase() !== n.name.toLowerCase() ? label : null;
}
