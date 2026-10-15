const CHUNK_SIZE = 500;

async function saveData(key, data) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: data }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

async function loadData(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([key], (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result[key] || null);
      }
    });
  });
}

async function loadMultipleKeys(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

async function removeData(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, resolve);
  });
}

async function saveScanResult(data) {
  const items = data.items || [];
  const chunkCount = Math.ceil(items.length / CHUNK_SIZE);

  const meta = {
    timestamp: data.timestamp,
    game: data.game,
    scanMode: data.scanMode,
    stats: data.stats,
    chunkCount: chunkCount,
    totalItems: items.length
  };

  const toSave = { [STORAGE_KEYS.SCAN_RESULT]: meta };

  for (let i = 0; i < chunkCount; i++) {
    const chunk = items.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    toSave[`${STORAGE_KEYS.SCAN_RESULT}_chunk_${i}`] = chunk;
  }

  const oldMeta = await loadData(STORAGE_KEYS.SCAN_RESULT);
  const oldChunkKeys = [];
  if (oldMeta && oldMeta.chunkCount) {
    for (let i = 0; i < oldMeta.chunkCount; i++) {
      oldChunkKeys.push(`${STORAGE_KEYS.SCAN_RESULT}_chunk_${i}`);
    }
  }

  await new Promise((resolve, reject) => {
    chrome.storage.local.set(toSave, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });

  const staleKeys = oldChunkKeys.filter(k => !toSave[k]);
  if (staleKeys.length > 0) {
    await removeData(staleKeys);
  }
}

async function loadScanResult() {
  const meta = await loadData(STORAGE_KEYS.SCAN_RESULT);
  if (!meta) return null;

  if (!meta.chunkCount) return meta;

  const chunkKeys = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    chunkKeys.push(`${STORAGE_KEYS.SCAN_RESULT}_chunk_${i}`);
  }

  const chunks = await loadMultipleKeys(chunkKeys);
  const items = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    const chunk = chunks[chunkKeys[i]];
    if (chunk) items.push(...chunk);
  }

  return {
    timestamp: meta.timestamp,
    game: meta.game,
    scanMode: meta.scanMode,
    stats: meta.stats,
    items: items
  };
}

async function saveScanState(state) {
  return saveData(STORAGE_KEYS.SCAN_STATE, state);
}
