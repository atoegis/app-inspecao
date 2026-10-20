// Geometria: base de estacas, estaca mais próxima, formatos e UTM.

export function fmtEstaca(m) {
  const km = Math.floor(m / 1000 + 1e-9);
  const resto = m - km * 1000;
  if (Math.abs(resto - Math.round(resto)) < 1e-6) {
    return `${km}+${String(Math.round(resto)).padStart(3, '0')}`;
  }
  const inteiro = Math.floor(resto);
  const dec = (resto - inteiro).toFixed(3).slice(2).replace(/0+$/, '');
  return `${km}+${String(inteiro).padStart(3, '0')},${dec}`;
}

export class BaseEstacas {
  constructor(json) {
    this.versao = json.v;
    this.eixos = json.eixos;
    this.s = json.s;
    const n = json.r.length;
    this.n = n;
    this.lat = new Float64Array(n);
    this.lon = new Float64Array(n);
    this.rows = json.r;
    for (let i = 0; i < n; i++) {
      this.lat[i] = json.r[i][0] / 1e6;
      this.lon[i] = json.r[i][1] / 1e6;
    }
  }

  // Distância aproximada em metros (equiretangular; precisa para < 50 km).
  static dist(lat1, lon1, lat2, lon2) {
    const k = Math.PI / 180;
    const x = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k);
    const y = (lat2 - lat1) * k;
    return Math.sqrt(x * x + y * y) * 6371008.8;
  }

  maisProxima(lat, lon) {
    let best = -1;
    let bestD = Infinity;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    for (let i = 0; i < this.n; i++) {
      const dy = this.lat[i] - lat;
      const dx = (this.lon[i] - lon) * cosLat;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD) { bestD = d2; best = i; }
    }
    if (best < 0) return null;
    return this.info(best, BaseEstacas.dist(lat, lon, this.lat[best], this.lon[best]));
  }

  info(i, distancia) {
    const r = this.rows[i];
    const s = this.s;
    return {
      idx: i,
      eixo: this.eixos[r[3]],
      estacaM: r[2],
      estaca: fmtEstaca(r[2]),
      pacote: r[4],
      segmento: s[r[5]],
      cidade: s[r[6]],
      infra: s[r[7]],
      super: s[r[8]],
      oae: s[r[9]],
      distancia,
    };
  }
}

// Conversão WGS84/SIRGAS2000 -> UTM (fuso calculado pela longitude).
export function paraUTM(lat, lon) {
  const a = 6378137.0;
  const f = 1 / 298.257222101; // GRS80 (SIRGAS 2000); diferença p/ WGS84 é desprezível
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const zona = Math.floor((lon + 180) / 6) + 1;
  const lon0 = ((zona - 1) * 6 - 180 + 3) * (Math.PI / 180);
  const phi = (lat * Math.PI) / 180;
  const lam = (lon * Math.PI) / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2;
  const C = ep2 * Math.cos(phi) ** 2;
  const A = Math.cos(phi) * (lam - lon0);
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const M = a * ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi
    - ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi)
    + ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi)
    - ((35 * e6) / 3072) * Math.sin(6 * phi));
  const E = k0 * N * (A + ((1 - T + C) * A ** 3) / 6
    + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  let Nn = k0 * (M + N * Math.tan(phi) * ((A * A) / 2
    + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24
    + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  if (lat < 0) Nn += 10000000;
  return { E, N: Nn, zona, hemisferio: lat < 0 ? 'S' : 'N' };
}

const nf = (casas) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });

export function fmtNum(v, casas) {
  return nf(casas).format(v);
}

export function fmtCoord(lat, lon, formato) {
  if (formato === 'utm') {
    const u = paraUTM(lat, lon);
    return `E ${fmtNum(u.E, 1)}  N ${fmtNum(u.N, 1)}  (${u.zona}${u.hemisferio})`;
  }
  return `Lat ${fmtNum(lat, 6)}  Lon ${fmtNum(lon, 6)}`;
}

export function fmtDist(m) {
  return m < 10 ? fmtNum(m, 1) : fmtNum(Math.round(m), 0);
}
