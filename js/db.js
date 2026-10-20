// Armazenamento local (IndexedDB): registros com imagens, relatórios, cache da base e ajustes.

const NOME = 'inspecao-obra';
const VERSAO = 1;
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

export async function pedirPersistencia() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch (e) { /* opcional */ }
}
