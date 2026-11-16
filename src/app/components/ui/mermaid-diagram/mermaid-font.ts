const FONT_URL = '/fonts/Berkeley-Mono-Variable.woff2';
const BASE64_CHUNK_SIZE = 0x8000;

/*
 * The sandboxed diagram iframe has an opaque origin, so it cannot fetch the
 * self-hosted font directly. Inline it once and retain the fallback stack when
 * the font is unavailable.
 */
let fontFaceCssPromise: Promise<string> | undefined;

async function fetchFontFaceCss(): Promise<string> {
  const response = await fetch(FONT_URL);
  if (!response.ok) {
    return '';
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
  }

  return `@font-face{font-family:"Berkeley Mono";font-weight:100 900;font-display:swap;src:url("data:font/woff2;base64,${btoa(binary)}") format("woff2")}`;
}

function loadMermaidFontFaceCss(): Promise<string> {
  fontFaceCssPromise ??= fetchFontFaceCss().catch(() => '');
  return fontFaceCssPromise;
}

export { loadMermaidFontFaceCss };
