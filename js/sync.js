// Comunicação com o script do Google e fila de envio (funciona sem sinal e envia depois).
import { db } from './db.js';

let apiUrl = '';
let codigo = '';
let enviando = false;
const ouvintes = new Set();

export function configurarApi(url, cod) {
  apiUrl = url || '';
  codigo = cod || '';
}

export const apiConfigurada = () => !!apiUrl;

export function aoMudarFila(fn) { ouvintes.add(fn); }
function avisar() { ouvintes.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }

export async function chamar(action, dados = {}, timeoutMs = 60000) {
  if (!apiUrl) throw new Error('Servidor não configurado');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita preflight CORS no Apps Script
      body: JSON.stringify({ action, codigo, ...dados }),
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json.ok) {
      const err = new Error(json.erro || 'Erro no servidor');
      err.servidor = true;
      err.codigoInvalido = json.erro === 'CODIGO_INVALIDO';
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

function blobParaBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function relatorioParaEnvio(rel) {
  const { sincronizado, ...resto } = rel;
  return resto;
}

export async function pendentes() {
  const regs = await db.all('registros');
  return regs.filter((r) => r.statusEnvio !== 'Enviado').length;
}

let deNovo = false;

export async function processarFila() {
  if (enviando) { deNovo = true; return { enviados: 0 }; }
  if (!apiUrl || !navigator.onLine) return { enviados: 0 };
  enviando = true;
  avisar();
  let enviados = 0;
  try {
    const rels = (await db.all('relatorios')).filter((r) => !r.sincronizado);
    for (const rel of rels) {
      await chamar('relatorio', { relatorio: relatorioParaEnvio(rel) });
      rel.sincronizado = true;
      await db.put('relatorios', rel);
    }
    const regs = (await db.all('registros'))
      .filter((r) => r.statusEnvio !== 'Enviado')
      .sort((a, b) => a.criadoEm - b.criadoEm);
    for (const reg of regs) {
      const { imgCom, imgSem, thumb, ...dados } = reg;
      const payload = {
        registro: dados,
        imgCom: imgCom ? await blobParaBase64(imgCom) : null,
        imgSem: imgSem ? await blobParaBase64(imgSem) : null,
      };
      const r = await chamar('registro', payload, 120000);
      reg.statusEnvio = 'Enviado';
      reg.linkCom = r.linkCom || '';
      reg.linkSem = r.linkSem || '';
      reg.enviadoEm = Date.now();
      // libera espaço: mantém só a miniatura depois de enviado
      delete reg.imgCom;
      delete reg.imgSem;
      await db.put('registros', reg);
      enviados++;
      avisar();
    }
  } catch (e) {
    console.warn('Fila parada:', e.message);
    throw e;
  } finally {
    enviando = false;
    avisar();
  }
  if (deNovo) {
    deNovo = false;
    const r = await processarFila();
    enviados += r.enviados;
  }
  return { enviados };
}

export const estaEnviando = () => enviando;
