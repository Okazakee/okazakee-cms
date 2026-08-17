// TODO: Consolidate into a unified custom formatter that handles:
// 1. `****text****` -> violet highlight (currently produces `<label>`)
// 2. Markdown images: `![alt-blurhash](url)` split parsing
// This formatter should be shared between CMS previews and public site rendering.
export const formatLabels = (text: string) => {
  // Replace all instances of `****...****` with `<label>...</label>`
  return text.replace(/(\*\*\*\*([^*]+)\*\*\*\*)/g, (_match, _p1, p2) => {
    return `<label>${p2}</label>`;
  });
};
