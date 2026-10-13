const paths = {
  pin: '<path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4-1-6ZM12 15v6"/>',
  edit: '<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15v5Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  settings: '<path d="m9 3-.5 3-2 1.2-2.8-1-3 5.2 2.3 2v2.3l-2.3 2 3 5.2 2.8-1 2 1.2.5 3h6l.5-3 2-1.2 2.8 1 3-5.2-2.3-2v-2.3l2.3-2-3-5.2-2.8 1-2-1.2L15 3Z" transform="translate(2 0) scale(.83)"/><circle cx="12" cy="12" r="3"/>',

  back: '<path d="M20 12H4m7-7-7 7 7 7"/>',
  forward: '<path d="M4 12h16m-7-7 7 7-7 7"/>',
  reload: '<path d="M20 7v5h-5M20 12a8 8 0 1 0-2 5M20 7v5"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 10h18M10 10v11"/>',
  home: '<path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4Z"/>',
  tabs: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m7 14 5-5 5 5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 7h14M5 17h14"/>',
};
export const browserIcon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
