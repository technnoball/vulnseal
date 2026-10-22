// Generates clearly-labelled synthetic evidence documents (no external deps).
const BANNER = "SYNTHETIC DEMONSTRATION DOCUMENT - not a real repair record";

const esc = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").replace(/([()\\])/g, "\\$1");

/** Minimal single-page PDF (Courier body, Helvetica-Bold title). */
export function makePdf(title: string, lines: string[]): Buffer {
  const body = [
    "BT /F2 15 Tf 50 790 Td (" + esc(title) + ") Tj ET",
    "BT /F2 9 Tf 50 772 Td (" + esc(BANNER) + ") Tj ET",
    "BT /F1 10 Tf 14 TL 50 740 Td " + lines.map((l) => "(" + esc(l) + ") Tj T*").join(" ") + " ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += String(off).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A flat, labelled "photograph" of a component, drawn as SVG. */
export function makeComponentSvg(title: string, component: "battery" | "hinge" | "board", caption: string): Buffer {
  const shapes: Record<string, string> = {
    battery: `<rect x="120" y="110" width="400" height="150" fill="#494D49" stroke="#332A26" stroke-width="4"/>
      <rect x="140" y="128" width="110" height="114" fill="#8B9270"/><rect x="265" y="128" width="110" height="114" fill="#8B9270"/>
      <rect x="390" y="128" width="110" height="114" fill="#8B9270"/><rect x="520" y="160" width="22" height="50" fill="#332A26"/>
      <text x="320" y="300" font-family="monospace" font-size="16" text-anchor="middle" fill="#332A26">CELL PACK 11.4V 60Wh (synthetic label)</text>`,
    hinge: `<rect x="150" y="150" width="340" height="40" fill="#494D49"/><circle cx="200" cy="170" r="30" fill="#B59658" stroke="#332A26" stroke-width="4"/>
      <circle cx="440" cy="170" r="30" fill="#B59658" stroke="#332A26" stroke-width="4"/><rect x="185" y="200" width="30" height="80" fill="#CBBDA9" stroke="#332A26" stroke-width="3"/>
      <rect x="425" y="200" width="30" height="80" fill="#CBBDA9" stroke="#332A26" stroke-width="3"/>`,
    board: `<rect x="110" y="100" width="420" height="200" fill="#8B9270" stroke="#332A26" stroke-width="4"/>
      <rect x="170" y="140" width="90" height="90" fill="#332A26"/><rect x="300" y="140" width="60" height="30" fill="#B59658"/>
      <rect x="300" y="190" width="60" height="30" fill="#B59658"/><rect x="400" y="130" width="100" height="140" fill="#494D49"/>`,
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
  <rect width="640" height="400" fill="#E9E1D2"/>
  <rect x="8" y="8" width="624" height="384" fill="none" stroke="#CBBDA9" stroke-width="2"/>
  <text x="24" y="44" font-family="monospace" font-size="18" fill="#332A26">${title}</text>
  <text x="24" y="70" font-family="monospace" font-size="12" fill="#CC4F32">${BANNER}</text>
  ${shapes[component]}
  <text x="24" y="370" font-family="monospace" font-size="13" fill="#494D49">${caption}</text>
</svg>
`;
  return Buffer.from(svg, "utf8");
}

export function makeText(title: string, lines: string[]): Buffer {
  return Buffer.from([title, BANNER, "", ...lines, ""].join("\n"), "utf8");
}
