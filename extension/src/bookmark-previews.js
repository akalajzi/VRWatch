export const PREVIEW_WIDTH = 480;
export const PREVIEW_HEIGHT = 270;
export const MAX_PREVIEW_BYTES = 100 * 1024;
export const PREVIEW_BUDGET = 12 * 1024 * 1024;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('vrwatch-bookmark-previews', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Preview storage is busy.'));
  });
}
async function transaction(mode, work) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('images', mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Preview storage failed.'));
      work(tx.objectStore('images'), value => { result = value; });
    });
  } finally { db.close(); }
}
export function previewEvictions(records, validKeys, incoming = null) {
  const valid = new Set(validKeys);
  const removed = records.filter(item => !valid.has(item.key) || item.key === incoming?.key).map(item => item.key);
  const retained = records.filter(item => !removed.includes(item.key)).sort((a, b) => a.created - b.created);
  let bytes = retained.reduce((total, item) => total + item.blob.size, 0) + (incoming?.blob.size || 0);
  while (bytes > PREVIEW_BUDGET && retained.length) {
    const item = retained.shift(); bytes -= item.blob.size; removed.push(item.key);
  }
  return removed;
}
export const getPreview = key => transaction('readonly', (store, done) => {
  const request = store.get(key); request.onsuccess = () => done(request.result?.blob || null);
});
function reconcile(validKeys, incoming) {
  return transaction('readwrite', store => {
    const request = store.getAll();
    request.onsuccess = () => {
      for (const key of previewEvictions(request.result, validKeys, incoming)) store.delete(key);
      if (incoming) store.put(incoming);
    };
  });
}
export const prunePreviews = validKeys => reconcile(validKeys);
export async function putPreview(key, blob, validKeys) {
  if (!(blob instanceof Blob) || blob.type !== 'image/jpeg' || !blob.size || blob.size > MAX_PREVIEW_BYTES)
    throw new Error('Preview image exceeds the storage limit.');
  await reconcile(validKeys, { key, blob, created: Date.now() });
}

export async function compressPreview(source) {
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = new OffscreenCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT);
    const context = canvas.getContext('2d');
    context.fillStyle = '#1c1e23'; context.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
    const width = bitmap.width * scale, height = bitmap.height * scale;
    context.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    for (const quality of [0.72, 0.5, 0.3]) {
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      if (blob.size <= MAX_PREVIEW_BYTES) return blob;
    }
    throw new Error('Preview image is too large.');
  } finally { bitmap.close(); }
}
