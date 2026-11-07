/**
 * Save a rendered graph as a standalone SVG or PNG. The page styles the SVG with CSS classes, so
 * the export copies the computed styles onto each element. State classes (selection, hover,
 * focus fading) are removed first, so the file shows the plain graph.
 */

const STYLE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'opacity',
    'font-family', 'font-size', 'font-weight', 'font-style'] as const;
const STATE_CLASSES = ['sel', 'cur', 'match', 'in-focus', 'hot', 'near', 'dim-out'];

function styledClone(svg: SVGSVGElement, hostClass: string): SVGSVGElement {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.querySelectorAll('*').forEach(e => e.classList.remove(...STATE_CLASSES));
    // Lay the clone out under a host with the same class, so the page's CSS applies to it.
    const host = document.createElement('div');
    host.className = hostClass;
    host.style.cssText = 'position:fixed;left:-100000px;top:0;width:auto;height:auto;visibility:hidden;pointer-events:none';
    host.append(clone);
    (svg.closest('.views') ?? document.body).append(host);
    const all = [clone, ...Array.from(clone.querySelectorAll<SVGElement>('*'))];
    const styles = all.map(e => getComputedStyle(e));
    all.forEach((e, i) => {
        const cs = styles[i];
        const decl = STYLE_PROPS.map(p => `${p}:${cs.getPropertyValue(p)}`).join(';');
        e.setAttribute('style', decl);
        e.removeAttribute('class');
    });
    host.remove();
    clone.removeAttribute('style');
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return clone;
}

function svgText(svg: SVGSVGElement, hostClass: string, background: string): { text: string; width: number; height: number } {
    const clone = styledClone(svg, hostClass);
    const width = Number(svg.getAttribute('width')) || svg.getBoundingClientRect().width;
    const height = Number(svg.getAttribute('height')) || svg.getBoundingClientRect().height;
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', '100%');
    bg.setAttribute('height', '100%');
    bg.setAttribute('fill', background);
    clone.insertBefore(bg, clone.firstChild);
    return { text: '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone), width, height };
}

function download(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function exportSvg(svg: SVGSVGElement, hostClass: string, filename: string, background = '#1A1A1A') {
    const { text } = svgText(svg, hostClass, background);
    download(new Blob([text], { type: 'image/svg+xml' }), filename);
}

export async function exportPng(svg: SVGSVGElement, hostClass: string, filename: string, background = '#1A1A1A', scale = 2): Promise<void> {
    const { text, width, height } = svgText(svg, hostClass, background);
    // Canvas size limits: keep the bitmap under about 16k pixels on a side.
    const k = Math.min(scale, 16000 / Math.max(width, height, 1));
    const img = new Image();
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    try {
        await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('the SVG could not be drawn')); img.src = url; });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(width * k);
        canvas.height = Math.ceil(height * k);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
        if (!blob) throw new Error('the image is too large');
        download(blob, filename);
    } finally {
        URL.revokeObjectURL(url);
    }
}
