const { randomUUID } = require('node:crypto');

const HISTORY_LIMIT = 5;
const CHUNK_SIZE = 500;

// Snapshot history owns chunk reconstruction and atomic restoration. Callers only
// see summaries and opaque IDs, never filenames or arbitrary restore payloads.
function createHistory(store) {
  function current() {
    const meta = store.get('scanResult').scanResult;
    if (!meta) return null;
    const items = meta.chunkCount
      ? Array.from({ length: meta.chunkCount }, (_, i) => store.get(`scanResult_chunk_${i}`)[`scanResult_chunk_${i}`] || []).flat()
      : meta.items || [];
    return { timestamp: meta.timestamp, game: meta.game, scanMode: meta.scanMode, stats: meta.stats, items };
  }
  const entries = () => store.get('desktopScanHistory').desktopScanHistory || [];
  function withCurrent(history, snapshot) {
    if (!snapshot?.items?.length) return history;
    const duplicate = history.find(entry => entry.result.timestamp === snapshot.timestamp && entry.result.game === snapshot.game);
    if (duplicate) return history;
    return [{ id: randomUUID(), result: snapshot }, ...history].slice(0, HISTORY_LIMIT);
  }
  return {
    list() {
      return entries().map(({ id, result }) => ({ id, timestamp: result.timestamp, game: result.game,
        scanMode: result.scanMode, count: result.items.length }));
    },
    async archive() {
      await store.set({ desktopScanHistory: withCurrent(entries(), current()) });
    },
    async restore(id) {
      const history = entries();
      const chosen = history.find(entry => entry.id === id);
      if (!chosen) throw new Error('历史记录不存在或已被轮换，请刷新列表。');
      const result = chosen.result;
      const next = withCurrent(history.filter(entry => entry.id !== id), current());
      const count = Math.ceil(result.items.length / CHUNK_SIZE);
      const oldCount = store.get('scanResult').scanResult?.chunkCount || 0;
      const { items, ...meta } = result;
      const values = {
        desktopScanHistory: next,
        scanResult: { ...meta, totalItems: items.length, chunkCount: count },
        scanState: { status: 'restored', timestamp: result.timestamp, game: result.game, scannedItems: items.length }
      };
      for (let i = 0; i < Math.max(count, oldCount); i++) values[`scanResult_chunk_${i}`] = items.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      await store.set(values);
      return structuredClone(result);
    }
  };
}
module.exports = { createHistory, HISTORY_LIMIT };
