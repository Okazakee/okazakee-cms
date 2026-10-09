/**
 * Default resume stylesheet, transcribed verbatim from the author's
 * print-perfect HTML files (resume-two-page-{en,it}-ats.html).
 *
 * Both files share this identical CSS: fixed 210mm x 297mm pages, A4
 * @page with zero margin, screen styling plus a print-media fallback to
 * locally-available fonts. The CMS stores an optional override next to the
 * locale data; empty override falls back to this string.
 */
export const DEFAULT_RESUME_CSS = `:root {
      --accent: #8B53FB;
      --accent-dark: #533197;
      --accent-deeper: #361d66;
      --accent-light: #f0e8ff;
      --text: #080808;
      --muted: #6b7280;
      --border: #d4d4d4;
      --bg: #ffffff;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    @page { size: A4; margin: 0; }

    body {
      font-family: 'DM Sans', sans-serif;
      font-size: 12.1px;
      line-height: 1.45;
      color: var(--text);
      background: #f3f4f6;
    }

    .page {
      position: relative;
      background: var(--bg);
      width: 210mm;
      height: 297mm;
      margin: 0 auto;
      overflow: hidden;
      break-after: page;
      page-break-after: always;
    }
    .page:last-child { break-after: auto; page-break-after: auto; }
    .page + .page { margin-top: 12px; }

    header {
      padding: 14px 30px 10px;
      border-bottom: 2.5px solid var(--accent);
      background: linear-gradient(135deg, #faf8ff 0%, #f0e8ff 100%);
    }

    .name { font-size: 24px; font-weight: 600; letter-spacing: -0.5px; color: var(--text); }
    .title { font-size: 13.3px; font-weight: 400; color: var(--accent); margin-top: 5px; }
    .contact { display: flex; flex-wrap: nowrap; gap: 4px 12px; margin-top: 11px; align-items: center; }
    .contact a, .contact span {
      font-family: 'DM Mono', monospace;
      font-size: 10.3px;
      color: var(--text);
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
    }
    .contact a:hover { color: var(--accent); }
    .ci { width: 11px; height: 11px; opacity: 0.65; flex-shrink: 0; }
    .header-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    .header-copy { flex: 1; min-width: 0; }

    .continuation-header {
      padding: 12px 30px 9px;
      border-bottom: 2px solid var(--accent);
      background: linear-gradient(135deg, #faf8ff 0%, #f0e8ff 100%);
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 16px;
    }
    .continuation-name { font-size: 15px; font-weight: 600; color: var(--text); }
    .continuation-title { font-size: 10px; color: var(--accent); font-family: 'DM Mono', monospace; }

    main { padding: 0 30px 16mm; }
    section { margin-top: 14px; }
    .section-title {
      font-size: 9.8px;
      font-weight: 600;
      letter-spacing: 1.6px;
      text-transform: uppercase;
      color: var(--accent);
      padding-bottom: 4px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 10px;
    }

    .summary { color: #374151; font-size: 12.2px; line-height: 1.62; }
    .summary strong { color: var(--accent-dark); }

    .skills-grid { display: grid; gap: 5px; }
    .skill-row {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 8px;
      align-items: baseline;
    }
    .skill-label { font-size: 12.1px; font-weight: 500; color: var(--muted); }
    .tag {
      display: inline-block;
      background: var(--accent-light);
      color: var(--accent-dark);
      font-family: 'DM Mono', monospace;
      font-size: 11.1px;
      padding: 1px 6px;
      border-radius: 3px;
      margin: 1px 2px 1px 0;
    }

    .entry { margin-bottom: 11px; break-inside: avoid; page-break-inside: avoid; }
    .entry:last-child { margin-bottom: 0; }
    .entry-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    .entry-title { font-size: 13.5px; font-weight: 600; color: var(--accent-deeper); }
    .entry-sub { font-size: 12.3px; color: var(--muted); margin-top: 1px; }
    .entry-meta { font-family: 'DM Mono', monospace; font-size: 11px; color: var(--accent); white-space: nowrap; text-align: right; padding-top: 1px; }
    .bullets { margin-top: 4px; list-style: none; }
    .bullets li {
      position: relative;
      padding-left: 12px;
      margin-bottom: 1px;
      font-size: 11.9px;
      color: #374151;
      line-height: 1.5;
    }
    .bullets li::before { content: "–"; position: absolute; left: 0; color: var(--accent); font-weight: 600; }
    .bullets li strong { color: var(--accent-dark); }

    .proj-header { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; }
    .proj-name { font-size: 13.3px; font-weight: 600; color: var(--accent-deeper); }
    .proj-link { font-family: 'DM Mono', monospace; font-size: 11px; color: var(--accent); text-decoration: none; }
    .proj-link:hover { text-decoration: underline; }
    .proj-link + .proj-link::before { content: "·"; color: var(--muted); margin-right: 8px; }
    .proj-stack { font-family: 'DM Mono', monospace; font-size: 11px; color: var(--muted); margin-top: 1px; }

    .edu-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 6px; }
    .edu-row:last-child { margin-bottom: 0; }
    .edu-degree { font-size: 12.7px; font-weight: 500; }
    .edu-school { font-size: 12px; color: var(--muted); margin-top: 1px; }
    .edu-year { font-family: 'DM Mono', monospace; font-size: 11px; color: var(--accent); white-space: nowrap; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 0 40px; }
    .lang-row { display: flex; justify-content: space-between; font-size: 12.6px; margin-bottom: 4px; }
    .lang-level { font-size: 11.4px; color: var(--muted); }
    .nowrap { white-space: nowrap; }

    .page-footer {
      position: absolute;
      left: 30px;
      right: 30px;
      bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 5px;
      border-top: 1px solid #ececec;
      font-family: 'DM Mono', monospace;
      font-size: 8.5px;
      color: #9ca3af;
    }

    html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

    @media print {
      body { background: white; font-family: 'Noto Sans', Arial, Helvetica, sans-serif !important; }
      .page { margin: 0; box-shadow: none; border-radius: 0; }
      .page + .page { margin-top: 0; }
      .contact a, .contact span, .tag, .entry-meta, .proj-link, .proj-stack, .edu-year, .continuation-title, .page-footer {
        font-family: 'Noto Sans Mono', 'DejaVu Sans Mono', 'Courier New', monospace !important;
      }
      *, *::before, *::after {
        font-variant-ligatures: none !important;
        font-feature-settings: "liga" 0, "clig" 0 !important;
      }
      .section-title { letter-spacing: 0.45px !important; }
      .skill-label { font-size: 10px !important; white-space: nowrap; }
      .bullets li { position: static !important; padding-left: 12px !important; text-indent: -12px; }
      .bullets li::before { position: static !important; display: inline-block; width: 12px; text-indent: 0; }
    }
`;
