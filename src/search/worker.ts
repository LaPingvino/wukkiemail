/// <reference lib="webworker" />
// Full-text message search index, off the main thread.
//
// Why a worker: the previous search filtered the in-memory item list on
// the main thread, which froze the UI on phones with big accounts. This
// owns a separate IndexedDB ('wukkiemail-search') of message documents
// and answers substring queries via a cursor scan in the worker, so the
// UI thread never blocks. A token/inverted index can come later; moving
// off-thread already fixes the freeze.

interface Doc {
  id: string;        // event id (stable; upsert key)
  roomId: string;
  roomName: string;
  sender: string;
  body: string;
  ts: number;
}

type Req =
  | { type: 'put'; reqId: number; docs: Doc[] }
  | { type: 'search'; reqId: number; q: string; limit: number }
  | { type: 'clear'; reqId: number };

const DB_NAME = 'wukkiemail-search';
const STORE = 'messages';
const ctx = self as unknown as Worker;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function put(docs: Doc[]): Promise<void> {
  if (!docs.length) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const d of docs) store.put(d);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function search(q: string, limit: number): Promise<Doc[]> {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const db = await openDb();
  return new Promise<Doc[]>((resolve, reject) => {
    const hits: Doc[] = [];
    const tx = db.transaction(STORE, 'readonly');
    // Walk newest-first so the cap keeps the most recent matches.
    const cursorReq = tx.objectStore(STORE).index('ts').openCursor(null, 'prev');
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || hits.length >= limit) { resolve(hits); return; }
      const d = cursor.value as Doc;
      if (
        d.body.toLowerCase().includes(needle) ||
        d.sender.toLowerCase().includes(needle) ||
        d.roomName.toLowerCase().includes(needle)
      ) {
        hits.push(d);
      }
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

async function clear(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

ctx.onmessage = async (e: MessageEvent<Req>) => {
  const msg = e.data;
  try {
    if (msg.type === 'put') {
      await put(msg.docs);
      ctx.postMessage({ reqId: msg.reqId, ok: true });
    } else if (msg.type === 'search') {
      const hits = await search(msg.q, msg.limit);
      ctx.postMessage({ reqId: msg.reqId, hits });
    } else if (msg.type === 'clear') {
      await clear();
      ctx.postMessage({ reqId: msg.reqId, ok: true });
    }
  } catch (err) {
    ctx.postMessage({ reqId: msg.reqId, error: String(err) });
  }
};
