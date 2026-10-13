// Stable keyed nodes retain focus, scroll position and decoded canvases. Only
// changed metadata updates a card; preview bytes never participate in diffing.
export function reconcileCards(container, cards, tabs, create, update) {
  const keep = new Set(tabs.map(tab => tab.id));
  for (const [id, card] of cards) if (!keep.has(id)) { card.node.remove(); cards.delete(id); }
  tabs.forEach((tab, index) => {
    let card = cards.get(tab.id);
    if (!card) { card = { node: create(tab), data: null }; cards.set(tab.id, card); }
    if (!card.data || Object.keys(tab).some(key => tab[key] !== card.data[key])) {
      update(card.node, tab, card.data);
      card.data = tab;
    }
    if (container.children[index] !== card.node) container.insertBefore(card.node, container.children[index] ?? null);
  });
}
