/**
 * The page a public link opens: server-rendered HTML with no script at all,
 * in the same visual language as the web app — system font, SF-style glyphs,
 * Apple's system colours, light and dark.
 */

export interface PageEntry {
  name: string;
  /** Path inside the link. */
  sub: string;
  isDir: boolean;
  size: string;
  modified: Date;
  kind: string;
  thumbnail: boolean;
}

export interface LinkPage {
  token: string;
  /** Name of the linked item itself. */
  title: string;
  /** Path inside the link being shown, "" for the linked item. */
  sub: string;
  name: string;
  isDir: boolean;
  size: string;
  kind: string;
  thumbnail: boolean;
  modified: Date;
  expiresAt: number | null;
  entries: PageEntry[];
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const DATE = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' });

const GLYPHS: Record<string, string> = {
  folder: 'M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2a2 2 0 0 1 1.6.8l.9 1.2h7.3A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z',
  file: 'M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7zM14 3v4h4',
  image: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5zM4 16l4.2-4a1.8 1.8 0 0 1 2.5 0L16 17M14.5 14l1.4-1.3a1.8 1.8 0 0 1 2.4 0L20 14M9.5 9.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0',
  video: 'M3 7.5A2.5 2.5 0 0 1 5.5 5h8A2.5 2.5 0 0 1 16 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 3 16.5zM16 10.2l4-2.3v8.2l-4-2.3z',
  audio: 'M9 18V6.2l10-2v11.3M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0M19 15.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0',
  pdf: 'M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7zM14 3v4h4M8.5 17c2-1 3.2-3.2 3.8-5 .4-1.3.1-2.2-.6-2.2-.8 0-1 1-.5 2.5.8 2.4 2.3 3.9 3.8 4',
  text: 'M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7zM14 3v4h4M9 12h6M9 15.5h6',
  download: 'M12 4v11.5M8 11.5l4 4 4-4M4.5 15v3A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5v-3',
  cloud: 'M7 18.5a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17.4 10 3.75 3.75 0 0 1 17 18.5z',
  chevron: 'm9.5 6 6 6-6 6',
};

const TINTS: Record<string, string> = {
  folder: 'var(--accent)', image: 'var(--purple)', video: 'var(--red)', audio: 'var(--orange)',
  pdf: 'var(--red)', text: 'var(--teal)', file: 'var(--gray)',
};

function glyph(name: string, size = 20, colour = 'currentColor'): string {
  const d = GLYPHS[name] ?? GLYPHS.file;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${colour}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

const query = (sub: string) => (sub ? `?path=${encodeURIComponent(sub)}` : '');

const KIND_LABELS: Record<string, string> = {
  folder: 'Folder', image: 'Image', video: 'Video', audio: 'Audio', pdf: 'PDF document', text: 'Text document', file: 'Document',
};

const STYLE = `
:root{color-scheme:light dark;--bg:#f5f5f7;--card:#fff;--text:#1d1d1f;--secondary:#6e6e73;--tertiary:#a1a1a6;--separator:rgba(60,60,67,.14);--hover:rgba(0,0,0,.04);--accent:#007aff;--accent-hover:#0a6fd8;--red:#ff3b30;--orange:#ff9500;--purple:#af52de;--teal:#30b0c7;--gray:#8e8e93;--field:rgba(118,118,128,.12)}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--text:#f5f5f7;--secondary:#98989d;--tertiary:#6e6e73;--separator:rgba(84,84,88,.5);--hover:rgba(255,255,255,.06);--accent:#0a84ff;--accent-hover:#409cff;--red:#ff453a;--orange:#ff9f0a;--purple:#bf5af2;--teal:#40c8e0;--field:rgba(118,118,128,.24)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.page{max-width:880px;margin:0 auto;padding:28px 16px 48px}
.brand{display:flex;align-items:center;gap:7px;color:var(--secondary);font-size:13px;font-weight:600;margin-bottom:22px}
.card{background:var(--card);border-radius:18px;box-shadow:0 1px 2px rgba(0,0,0,.05),0 8px 28px rgba(0,0,0,.06);overflow:hidden}
.head{display:flex;align-items:center;gap:16px;padding:22px 22px 20px;border-bottom:1px solid var(--separator)}
.head__icon{width:52px;height:52px;border-radius:12px;display:grid;place-items:center;background:var(--field);flex:none}
.head__text{flex:1;min-width:0}
h1{margin:0;font-size:22px;font-weight:700;letter-spacing:-.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{color:var(--secondary);font-size:13px;margin-top:2px}
.button{display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 16px;border-radius:999px;background:var(--accent);color:#fff;font-size:14px;font-weight:600;flex:none;transition:background .15s}
.button:hover{background:var(--accent-hover)}
.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:2px;padding:10px 18px;border-bottom:1px solid var(--separator);font-size:13px;color:var(--secondary)}
.crumbs a{padding:3px 6px;border-radius:6px}.crumbs a:hover{background:var(--hover);color:var(--text)}
.crumbs span{padding:3px 6px;color:var(--text);font-weight:600}
.row{display:flex;align-items:center;gap:14px;padding:10px 18px;border-bottom:1px solid var(--separator)}
.row:last-child{border-bottom:none}
.row:hover{background:var(--hover)}
.row__main{flex:1;min-width:0;display:flex;align-items:center;gap:14px}
.thumb{width:40px;height:40px;border-radius:8px;display:grid;place-items:center;flex:none;overflow:hidden}
.thumb img{width:40px;height:40px;object-fit:cover}
.name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.small{color:var(--secondary);font-size:12.5px}
.get{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;color:var(--accent);flex:none}
.get:hover{background:var(--hover)}
.empty{padding:48px 20px;text-align:center;color:var(--secondary)}
.preview{display:grid;place-items:center;padding:28px;background:var(--bg)}
.preview img{max-width:100%;max-height:70vh;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.18)}
.foot{margin-top:18px;text-align:center;color:var(--tertiary);font-size:12px}
@media (max-width:560px){.head{flex-wrap:wrap}.head .button{width:100%;justify-content:center}h1{white-space:normal}}
`;

function documentFor(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main class="page"><div class="brand">${glyph('cloud', 18, 'var(--accent)')}Cloud</div>${body}<p class="foot">Shared from Cloud</p></main></body></html>`;
}

export function renderLinkPage(page: LinkPage): string {
  const t = page.token;
  const expires = page.expiresAt ? ` · Link expires ${DATE.format(new Date(page.expiresAt))}` : '';
  const meta = page.isDir
    ? `${page.entries.length === 1 ? '1 item' : `${page.entries.length} items`}${expires}`
    : `${KIND_LABELS[page.kind] ?? 'Document'} · ${page.size}${expires}`;
  const action = page.isDir
    ? `<a class="button" href="${t}/zip${query(page.sub)}">${glyph('download', 17)}Download All</a>`
    : `<a class="button" href="${t}/file${query(page.sub)}">${glyph('download', 17)}Download</a>`;

  // Where this is inside the link: the link's own name, then each folder.
  let crumbs = '';
  if (page.sub) {
    const parts = page.sub.split('/');
    const links = [`<a href="${t}">${escape(page.title)}</a>`];
    parts.forEach((part, index) => {
      const target = parts.slice(0, index + 1).join('/');
      links.push(index === parts.length - 1 ? `<span>${escape(part)}</span>` : `<a href="${t}${query(target)}">${escape(part)}</a>`);
    });
    crumbs = `<nav class="crumbs" aria-label="Location">${links.join(glyph('chevron', 12, 'var(--tertiary)'))}</nav>`;
  }

  let content: string;
  if (!page.isDir) {
    content = page.thumbnail
      ? `<div class="preview"><img src="${t}/thumb${query(page.sub)}${page.sub ? '&' : '?'}size=1024" alt="${escape(page.name)}"></div>`
      : '';
  } else if (page.entries.length === 0) {
    content = `<div class="empty">This folder is empty.</div>`;
  } else {
    content = page.entries
      .map((entry) => {
        const icon = entry.thumbnail
          ? `<span class="thumb"><img loading="lazy" src="${t}/thumb?path=${encodeURIComponent(entry.sub)}&amp;size=128" alt=""></span>`
          : `<span class="thumb">${glyph(entry.kind, 26, TINTS[entry.kind] ?? TINTS.file)}</span>`;
        const detail = entry.isDir ? DATE.format(entry.modified) : `${entry.size} · ${DATE.format(entry.modified)}`;
        const open = entry.isDir ? `${t}?path=${encodeURIComponent(entry.sub)}` : `${t}?path=${encodeURIComponent(entry.sub)}`;
        const get = entry.isDir ? `${t}/zip?path=${encodeURIComponent(entry.sub)}` : `${t}/file?path=${encodeURIComponent(entry.sub)}`;
        return `<div class="row"><a class="row__main" href="${open}">${icon}<span style="min-width:0"><div class="name">${escape(entry.name)}</div><div class="small">${detail}</div></span></a><a class="get" href="${get}" aria-label="Download ${escape(entry.name)}" title="Download">${glyph('download', 19)}</a></div>`;
      })
      .join('');
  }

  const headIcon = glyph(page.kind, 28, TINTS[page.kind] ?? TINTS.file);
  return documentFor(
    page.name,
    `<section class="card"><header class="head"><div class="head__icon">${headIcon}</div><div class="head__text"><h1>${escape(page.name)}</h1><div class="meta">${meta}</div></div>${action}</header>${crumbs}${content}</section>`,
  );
}

export function renderMissingPage(): string {
  return documentFor(
    'Link unavailable',
    `<section class="card"><div class="empty">${glyph('file', 44, 'var(--tertiary)')}<h1 style="white-space:normal;margin-top:10px">This link is no longer available</h1><p>It may have expired, or the person who shared it may have removed it.</p></div></section>`,
  );
}
