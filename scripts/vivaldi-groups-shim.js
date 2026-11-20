// Emulates chrome.tabGroups for Vivaldi 8.3+, where chrome.tabs.group() returns an id
// but groups nothing (tab.groupId stays -1, tabGroups.get fails). The extension relies
// on tab groups to track the tabs Claude controls, so without this every browser tool
// fails with "anchor tab group not established".
// Groups live in chrome.storage.session, shared by the service worker and the panel.
// ponytail: groups are invisible in Vivaldi's UI and don't follow tabs moved to
// another window; fine for the extension's bookkeeping.
(() => {
  const NONE = -1, KEY = '__vivaldiTabGroups';
  const tabs = chrome.tabs, groups = chrome.tabGroups;
  const nat = { get: tabs.get.bind(tabs), query: tabs.query.bind(tabs), onUpdatedAdd: tabs.onUpdated.addListener.bind(tabs.onUpdated), onUpdatedRemove: tabs.onUpdated.removeListener.bind(tabs.onUpdated) };
  const empty = () => ({ next: 1000, groups: {} });
  let chain = Promise.resolve();
  const load = async () => (await chrome.storage.session.get(KEY))[KEY] || empty();
  const read = () => chain.then(load);
  const write = (fn) => (chain = chain.catch(() => {}).then(async () => {
    const s = await load(), r = await fn(s);
    for (const k in s.groups) if (!s.groups[k].tabIds.length) delete s.groups[k];
    await chrome.storage.session.set({ [KEY]: s });
    return r;
  }));
  const groupOf = (s, id) => { for (const g of Object.values(s.groups)) if (g.tabIds.includes(id)) return g.id; return NONE; };
  const decorate = (s, t) => (t && typeof t === 'object' ? Object.assign(t, { groupId: groupOf(s, t.id) }) : t);
  const info = (g) => ({ id: g.id, windowId: g.windowId, title: g.title, color: g.color, collapsed: g.collapsed });
  const missing = (id) => new Error(`No group with id: ${id}.`);
  const detach = (s, ids) => { for (const g of Object.values(s.groups)) g.tabIds = g.tabIds.filter((t) => !ids.includes(t)); };
  // Optional trailing callback, like the native API.
  const api = (fn) => (...args) => {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const p = fn(...args);
    if (!cb) return p;
    p.then(cb, () => cb());
  };
  const set = (obj, name, value) => Object.defineProperty(obj, name, { value, configurable: true, writable: true });

  set(tabs, 'get', api(async (id) => decorate(await read(), await nat.get(id))));
  set(tabs, 'query', api(async (q = {}) => {
    const { groupId, ...rest } = q;
    const s = await read(), list = (await nat.query(rest)).map((t) => decorate(s, t));
    return groupId === undefined ? list : list.filter((t) => t.groupId === groupId);
  }));
  set(tabs, 'group', api((opts) => write(async (s) => {
    const ids = [].concat(opts.tabIds);
    let g = opts.groupId !== undefined ? s.groups[opts.groupId] : null;
    if (opts.groupId !== undefined && !g) throw missing(opts.groupId);
    if (!g) {
      const id = s.next++;
      const windowId = opts.createProperties?.windowId ?? (await nat.get(ids[0])).windowId;
      g = s.groups[id] = { id, windowId, title: '', color: 'grey', collapsed: false, tabIds: [] };
    }
    detach(s, ids);
    g.tabIds.push(...ids);
    return g.id;
  })));
  set(tabs, 'ungroup', api((tabIds) => write((s) => detach(s, [].concat(tabIds)))));
  set(groups, 'get', api(async (id) => {
    const g = (await read()).groups[id];
    if (!g) throw missing(id);
    return info(g);
  }));
  set(groups, 'query', api(async (q = {}) => Object.values((await read()).groups)
    .filter((g) => Object.keys(q).every((k) => g[k] === q[k])).map(info)));
  set(groups, 'update', api((id, props = {}) => write((s) => {
    const g = s.groups[id];
    if (!g) throw missing(id);
    for (const k of ['title', 'color', 'collapsed']) if (k in props) g[k] = props[k];
    return info(g);
  })));

  // Listeners get tabs with the emulated groupId too.
  const wrapped = new Map();
  set(tabs.onUpdated, 'addListener', (fn) => {
    const w = (id, change, tab) => { read().then((s) => fn(id, change, decorate(s, tab))); };
    wrapped.set(fn, w);
    nat.onUpdatedAdd(w);
  });
  set(tabs.onUpdated, 'removeListener', (fn) => { nat.onUpdatedRemove(wrapped.get(fn) || fn); wrapped.delete(fn); });
  tabs.onRemoved.addListener((id) => { write((s) => detach(s, [id])); });
})();
