// Armazenamento local (IndexedDB): registros com imagens, relatórios, cache da base e ajustes.

const NOME = 'inspecao-obra';
const VERSAO = 2;
let dbPromise = null;

function abrir() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(NOME, VERSAO);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('registros')) {
        const s = db.createObjectStore('registros', { keyPath: 'id' });
        s.createIndex('relatorio', 'idRelatorio');
        s.createIndex('status', 'statusEnvio');
      }
      if (!db.objectStoreNames.contains('relatorios')) db.createObjectStore('relatorios', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      // versão 2: vídeos (metadados) e as partes gravadas de cada vídeo
      if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('videoPartes')) {
        const p = db.createObjectStore('videoPartes', { keyPath: ['videoId', 'seq'] });
        p.createIndex('video', 'videoId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, modo, fn) {
  return abrir().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, modo);
    const s = t.objectStore(store);
    let resultado;
    Promise.resolve(fn(s)).then((r) => { resultado = r; });
    t.oncomplete = () => resolve(resultado);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const req2p = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export const db = {
  put: (store, valor) => tx(store, 'readwrite', (s) => req2p(s.put(valor))),
  get: (store, chave) => tx(store, 'readonly', (s) => req2p(s.get(chave))),
  del: (store, chave) => tx(store, 'readwrite', (s) => req2p(s.delete(chave))),
  all: (store) => tx(store, 'readonly', (s) => req2p(s.getAll())),
  kvGet: (chave) => tx('kv', 'readonly', (s) => req2p(s.get(chave))),
  kvSet: (chave, valor) => tx('kv', 'readwrite', (s) => req2p(s.put(valor, chave))),
};

// partes de um vídeo, em ordem
export function partesDoVideo(videoId) {
  return tx('videoPartes', 'readonly', (s) => req2p(s.index('video').getAll(IDBKeyRange.only(videoId))))
    .then((ps) => ps.sort((a, b) => a.seq - b.seq));
}

export function apagarPartesDoVideo(videoId) {
  return tx('videoPartes', 'readwrite', (s) => new Promise((resolve, reject) => {
    const r = s.index('video').openKeyCursor(IDBKeyRange.only(videoId));
    r.onsuccess = () => {
      const c = r.result;
      if (!c) { resolve(); return; }
      s.delete(c.primaryKey);
      c.continue();
    };
    r.onerror = () => reject(r.error);
  }));
}

export async function pedirPersistencia() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch (e) { /* opcional */ }
}
