const fs = require('node:fs');
const path = require('node:path');

// A single serialized, atomic snapshot. No Chrome quotas or browser profile dependency.
function createStore(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'data.json');
  let data = {};
  if (fs.existsSync(file)) {
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
      if (!fs.existsSync(`${file}.bak`)) throw new Error(`本地数据损坏，请保留文件后恢复备份：${file}`, { cause: error });
      data = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
      fs.copyFileSync(`${file}.bak`, file);
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('本地数据格式错误');
  // A desktop process cannot resume a previous process's pending network work.
  if (data.scanState?.status === 'running') {
    data.scanState = { ...data.scanState, status: 'aborted', error: '上次扫描因应用退出而中断，可重新扫描。' };
  }
  let queue = Promise.resolve();
  function commit(change) {
    const operation = queue.then(async () => {
      const next = structuredClone(data);
      change(next);
      const temporary = `${file}.tmp`;
      await fs.promises.writeFile(temporary, JSON.stringify(next), 'utf8');
      if (fs.existsSync(file)) await fs.promises.copyFile(file, `${file}.bak`);
      await fs.promises.rename(temporary, file);
      data = next;
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return {
    file,
    get(keys) {
      const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      return structuredClone(Object.fromEntries(list.filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]])));
    },
    set(values) {
      const snapshot = structuredClone(values);
      return commit(next => Object.assign(next, snapshot));
    },
    remove(keys) { return commit(next => { for (const key of Array.isArray(keys) ? keys : [keys]) delete next[key]; }); },
    flush() { return queue; }
  };
}
module.exports = { createStore };
