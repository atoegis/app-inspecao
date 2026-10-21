// Carimbo da legenda na imagem: texto sem fundo, alinhado à direita, com contorno escuro.

const FONTE = "'IBM Plex Mono', ui-monospace, 'Roboto Mono', 'Courier New', monospace";
const FATOR = { P: 0.022, M: 0.028, G: 0.036 };

function quebrar(ctx, texto, larguraMax) {
  const palavras = String(texto).split(/\s+/);
  const linhas = [];
  let atual = '';
  for (const p of palavras) {
    const teste = atual ? `${atual} ${p}` : p;
    if (ctx.measureText(teste).width > larguraMax && atual) {
      linhas.push(atual);
      atual = p;
    } else {
      atual = teste;
    }
  }
  if (atual) linhas.push(atual);
  return linhas;
}

/**
 * Desenha a legenda (linhas) num contexto já pintado com a imagem.
 * linhas: [{ texto, cor?, negrito? }] · opcoes: { posicao: 'inf'|'sup', tamanho: 'P'|'M'|'G' }
 */
export function desenharLegenda(ctx, w, h, linhas, opcoes = {}) {
  if (!linhas || !linhas.length) return;
  const fs = Math.max(14, Math.round(Math.min(w, h) * (FATOR[opcoes.tamanho] || FATOR.M)));
  const margem = Math.round(Math.min(w, h) * 0.035);
  const entre = Math.round(fs * 1.32);
  const larguraMax = w * 0.86 - margem;

  const finais = [];
  for (const l of linhas) {
    if (!l || !l.texto) continue;
    ctx.font = `${l.negrito ? 700 : 500} ${fs}px ${FONTE}`;
    for (const t of quebrar(ctx, l.texto, larguraMax)) finais.push({ ...l, texto: t });
  }

  const alturaBloco = finais.length * entre;
  let y = opcoes.posicao === 'sup' ? margem + fs : h - margem - alturaBloco + fs;
  const x = w - margem;
  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  for (const l of finais) {
    ctx.font = `${l.negrito ? 700 : 500} ${fs}px ${FONTE}`;
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = fs * 0.35;
    ctx.lineWidth = Math.max(2, fs * 0.2);
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.strokeText(l.texto, x, y);
    ctx.shadowBlur = 0;
    ctx.fillStyle = l.cor || '#FFFFFF';
    ctx.fillText(l.texto, x, y);
    y += entre;
  }
  ctx.restore();
}

/**
 * Desenha a imagem de origem num canvas e, se `linhas` vier preenchido, carimba a legenda.
 * opcoes: { posicao: 'inf'|'sup', tamanho: 'P'|'M'|'G', maxLado?: number }
 */
export function renderizar(origem, larguraOrigem, alturaOrigem, linhas, opcoes = {}) {
  const maxLado = opcoes.maxLado || 2560;
  const escala = Math.min(1, maxLado / Math.max(larguraOrigem, alturaOrigem));
  const w = Math.round(larguraOrigem * escala);
  const h = Math.round(alturaOrigem * escala);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(origem, 0, 0, w, h);
  desenharLegenda(ctx, w, h, linhas, opcoes);
  return canvas;
}

export function canvasParaBlob(canvas, qualidade = 0.88) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', qualidade));
}

export async function carregarFonteCarimbo() {
  try {
    await Promise.all([
      document.fonts.load(`500 20px 'IBM Plex Mono'`),
      document.fonts.load(`700 20px 'IBM Plex Mono'`),
    ]);
  } catch (e) { /* usa monospace do sistema */ }
}
