'use strict';
/**
 * Testa os encoders de imagem em Node (sem browser).
 *
 * Valida:
 *  - CRC-32 (valor conhecido)
 *  - LZW (round-trip com paletas de 2, 5 e 256 cores)
 *  - GIF (estrutura + round-trip do stream LZW)
 *  - BMP (cabeçalho e pixels)
 *  - TIFF (cabeçalho, tags e strip)
 *  - ICO (cabeçalho + payload PNG intacto)
 *  - ZIP (estrutura + CRC + dados extraídos)
 *  - base64 (round-trip)
 *
 * Uso: node scripts/test-image-codecs.js
 */

const C = require('../public/js/image-codecs.js');

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log('  ok  ' + msg);
  } else {
    failed++;
    console.log('FAIL  ' + msg);
  }
}

function eq(actual, expected, msg) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    passed++;
    console.log('  ok  ' + msg);
  } else {
    failed++;
    console.log('FAIL  ' + msg);
    console.log('      esperado: ' + JSON.stringify(expected));
    console.log('      obtido:   ' + JSON.stringify(actual));
  }
}

/* ---------------------------------------------------------
   LZW round-trip
   --------------------------------------------------------- */
function lzwDecode(data, numColors) {
  const m = C.minCodeSize(numColors);
  const clearCode = 1 << m;
  const endCode = clearCode + 1;
  let codeSize = m + 1;
  let nextCode = clearCode + 2;
  let dict = [];

  function resetDict() {
    dict = [];
    for (let i = 0; i < clearCode; i++) dict[i] = [i];
  }
  resetDict();

  let bytePos = 0;
  let bitPos = 7;

  function readCode() {
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      if (bytePos >= data.length) throw new Error('fim do stream');
      // MSB-first, como o encoder escreve
      code = (code << 1) | ((data[bytePos] >> bitPos) & 1);
      bitPos--;
      if (bitPos < 0) { bitPos = 7; bytePos++; }
    }
    return code;
  }

  const out = [];
  let prev = -1;

  while (true) {
    const code = readCode();
    if (code === endCode) break;
    if (code === clearCode) {
      codeSize = m + 1;
      nextCode = clearCode + 2;
      resetDict();
      prev = -1;
      continue;
    }

    let string;
    if (prev === -1) {
      // primeiro código após a limpeza: um único símbolo
      string = dict[code];
    } else if (code < nextCode) {
      string = dict[code];
    } else if (code === nextCode) {
      // caso KWW: cadeia ainda não registrada
      string = dict[prev].concat(dict[prev][0]);
    } else {
      throw new Error('código inválido: ' + code);
    }

    for (const v of string) out.push(v);

    if (prev !== -1) {
      dict[nextCode] = dict[prev].concat(string[0]);
      nextCode++;
      // alarga depois de adicionar, quando o próximo slot não cabe mais
      if (nextCode >= (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = code;
  }
  return out;
}

// sequência aleatória com seed determinístico
function randSeq(n, paletteSize, seed) {
  let s = seed;
  const out = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out.push(s % paletteSize);
  }
  return out;
}

console.log('LZW round-trip');
for (const paletteSize of [2, 5, 256]) {
  for (const len of [1, 5, 50, 500]) {
    const seq = randSeq(len, paletteSize, paletteSize * 1000 + len);
    const encoded = C.lzwEncode(seq, paletteSize);
    const decoded = lzwDecode(encoded, paletteSize);
    eq(decoded, seq, 'palette=' + paletteSize + ' len=' + len);
  }
}

// sequência com repetição pesada (teste do caso KWW)
{
  const seq = [0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0];
  const encoded = C.lzwEncode(seq, 2);
  const decoded = lzwDecode(encoded, 2);
  eq(decoded, seq, 'caso KWW (repetições)');
}

/* ---------------------------------------------------------
   GIF round-trip
   --------------------------------------------------------- */
console.log('GIF');
{
  const w = 64, h = 64;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = (x * 4 + y) & 255;
      rgba[i + 1] = (y * 4) & 255;
      rgba[i + 2] = (x * 2) & 255;
      rgba[i + 3] = 255;
    }
  }

  const { palette, indexFor } = C.quantize(rgba, w, h);
  ok(palette.length <= 256, 'paleta com até 256 cores (' + palette.length + ')');

  const gif = C.encodeGif(rgba, w, h);
  eq(Array.from(gif.slice(0, 6)), [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 'assinatura GIF89a');
  eq([gif[6], gif[7]], [w & 255, w >>> 8], 'largura na header');
  eq([gif[8], gif[9]], [h & 255, h >>> 8], 'altura na header');

  // localiza o início do stream LZW
  // header: 6 + 7 (screen desc) + tableSize*3 + 10 (image desc) + 1 (min code)
  const tableSize = 1 << C.minCodeSize(palette.length);
  const lzwStart = 6 + 7 + tableSize * 3 + 10 + 1;
  const lzwBytes = [];
  let p = lzwStart;
  while (true) {
    const len = gif[p];
    p++;
    if (len === 0) break;
    for (let i = 0; i < len; i++) lzwBytes.push(gif[p + i]);
    p += len;
  }

  const expectedIndices = [];
  for (let i = 0; i < w * h; i++) {
    const key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
    expectedIndices.push(indexFor(key));
  }
  const decoded = lzwDecode(new Uint8Array(lzwBytes), palette.length);
  eq(decoded.length, w * h, 'número de pixels decodificados');
  eq(decoded, expectedIndices, 'índices de paleta reproduzidos');
}

/* ---------------------------------------------------------
   BMP
   --------------------------------------------------------- */
console.log('BMP');
{
  const w = 2, h = 2;
  const rgba = new Uint8Array([
    10, 20, 30, 255, 40, 50, 60, 255,
    70, 80, 90, 255, 100, 110, 120, 255,
  ]);
  const bmp = C.encodeBmp(rgba, w, h);
  eq(String.fromCharCode(bmp[0], bmp[1]), 'BM', 'assinatura BM');
  const fileSize = bmp[2] | (bmp[3] << 8) | (bmp[4] << 16) | (bmp[5] << 24);
  eq(fileSize, bmp.length, 'file size bate com o array');
  const width = bmp[18] | (bmp[19] << 8) | (bmp[20] << 16) | (bmp[21] << 24);
  const height = bmp[22] | (bmp[23] << 8) | (bmp[24] << 16) | (bmp[25] << 24);
  eq([width, height], [w, h], 'dimensões');
  // primeira linha de pixels (bottom-up): linha y=1 (índice 2,3)
  // rowBytes = ceil(2*3/4)*4 = 8
  const row0 = bmp.slice(54, 54 + 8);
  eq(Array.from(row0.slice(0, 3)), [90, 80, 70], 'pixel (0,1) BGR');
  eq(Array.from(row0.slice(3, 6)), [120, 110, 100], 'pixel (1,1) BGR');
}

/* ---------------------------------------------------------
   TIFF
   --------------------------------------------------------- */
console.log('TIFF');
{
  const w = 2, h = 2;
  const rgba = new Uint8Array([
    1, 2, 3, 255, 4, 5, 6, 255,
    7, 8, 9, 255, 10, 11, 12, 255,
  ]);
  const tiff = C.encodeTiff(rgba, w, h);
  eq(String.fromCharCode(tiff[0], tiff[1]), 'II', 'little-endian marker');
  eq(tiff[2], 0x2A, '0x2A');
  const ifdOffset = tiff[4] | (tiff[5] << 8) | (tiff[6] << 16) | (tiff[7] << 24);
  eq(ifdOffset, 8, 'offset do IFD');
  const numTags = tiff[8] | (tiff[9] << 8);
  eq(numTags, 9, 'número de tags');
  // strip offset = 8 + (2 + 9*12 + 2) + 6 = 8 + 112 + 6 = 126
  const stripStart = 8 + (2 + 9 * 12 + 2) + 6;
  // primeiros pixels RGB
  eq(Array.from(tiff.slice(stripStart, stripStart + 3)), [1, 2, 3], 'pixel (0,0) RGB');
  eq(Array.from(tiff.slice(stripStart + 3, stripStart + 6)), [4, 5, 6], 'pixel (1,0) RGB');
  eq(Array.from(tiff.slice(stripStart + 6, stripStart + 9)), [7, 8, 9], 'pixel (0,1) RGB');
  eq(Array.from(tiff.slice(stripStart + 9, stripStart + 12)), [10, 11, 12], 'pixel (1,1) RGB');
}

/* ---------------------------------------------------------
   ICO
   --------------------------------------------------------- */
console.log('ICO');
{
  const fakePng = new Uint8Array([137, 80, 78, 71, 13, 10, 13, 10, 255, 254, 253]);
  const w = 32, h = 32;
  const ico = C.encodeIco(fakePng, w, h);
  eq(ico[2], 0, 'reserved 0');
  eq(ico[3], 1, 'count 1');
  eq(ico[6], w, 'width');
  eq(ico[7], h, 'height');
  const dataOffset = ico[16] | (ico[17] << 8) | (ico[18] << 16) | (ico[19] << 24);
  eq(dataOffset, 22, 'offset dos dados');
  const size = ico[12] | (ico[13] << 8) | (ico[14] << 16) | (ico[15] << 24);
  eq(size, fakePng.length, 'size do payload');
  ok(Array.from(ico.slice(22, 22 + fakePng.length)).every((v, i) => v === fakePng[i]), 'payload PNG intacto');
}

/* ---------------------------------------------------------
   ZIP
   --------------------------------------------------------- */
console.log('ZIP');
{
  const a = new TextEncoder().encode('arquivo um');
  const b = new TextEncoder().encode('arquivo dois');
  const zip = C.zipStore([
    { name: 'a.txt', data: a },
    { name: 'b.txt', data: b },
  ]);
  // EOCD no fim
  const eocd = zip.slice(zip.length - 22);
  eq([eocd[0], eocd[1], eocd[2], eocd[3]], [0x50, 0x4b, 0x05, 0x06], 'assinatura EOCD');
  const entries = eocd[8] | (eocd[9] << 8);
  eq(entries, 2, 'número de entradas');
  const cdStart = eocd[16] | (eocd[17] << 8) | (eocd[18] << 16) | (eocd[19] << 24);
  // primeiro local header
  eq([zip[0], zip[1], zip[2], zip[3]], [0x50, 0x4b, 0x03, 0x04], 'assinatura local header');
  const nameLen = zip[26] | (zip[27] << 8);
  const name = zip.slice(30, 30 + nameLen);
  eq(new TextDecoder().decode(name), 'a.txt', 'nome do primeiro arquivo');
  const dataStart = 30 + nameLen;
  const crc = (zip[14] | (zip[15] << 8) | (zip[16] << 16) | (zip[17] << 24)) >>> 0;
  eq(crc, C.crc32(a), 'CRC do primeiro arquivo');
  const size = zip[18] | (zip[19] << 8) | (zip[20] << 16) | (zip[21] << 24);
  eq(size, a.length, 'size do primeiro arquivo');
  const data = zip.slice(dataStart, dataStart + size);
  eq(new TextDecoder().decode(data), 'arquivo um', 'conteúdo do primeiro arquivo');
  ok(cdStart > 0, 'offset do diretório central');

  // O diretório central precisa estar inteiro: 46 bytes + nome, por arquivo.
  // Leitores rígidos (Explorer/.NET) abrem o ZIP "vazio" quando o CD omite
  // os nomes, mesmo com os headers locais corretos.
  const names = ['a.txt', 'b.txt'];
  const datas = [a, b];
  const cdSize = eocd[12] | (eocd[13] << 8) | (eocd[14] << 16) | (eocd[15] << 24);
  eq(cdSize, names.reduce((acc, n) => acc + 46 + new TextEncoder().encode(n).length, 0), 'tam diretório central inclui nomes');
  let cd = cdStart;
  for (let i = 0; i < names.length; i++) {
    eq([zip[cd], zip[cd + 1], zip[cd + 2], zip[cd + 3]], [0x50, 0x4b, 0x01, 0x02], 'assinatura CD ' + i);
    const flags = zip[cd + 8] | (zip[cd + 9] << 8);
    ok((flags & 0x0800) !== 0, 'CD ' + i + ' marca nomes UTF-8');
    const cdNameLen = zip[cd + 28] | (zip[cd + 29] << 8);
    const cdName = zip.slice(cd + 46, cd + 46 + cdNameLen);
    eq(new TextDecoder().decode(cdName), names[i], 'nome no CD ' + i);
    const cdCrc = (zip[cd + 16] | (zip[cd + 17] << 8) | (zip[cd + 18] << 16) | (zip[cd + 19] << 24)) >>> 0;
    eq(cdCrc, C.crc32(datas[i]), 'CRC no CD ' + i);
    const cdSizeEntry = zip[cd + 20] | (zip[cd + 21] << 8) | (zip[cd + 22] << 16) | (zip[cd + 23] << 24);
    eq(cdSizeEntry, datas[i].length, 'size no CD ' + i);
    // O deslocamento do header local fica no byte 42 (38..41 são os atributos
    // externos). Se ele aponta errado, cada arquivo é lido do lugar errado e
    // sai corrompido — só a 1ª entrada (offset 0) escaparia.
    const localOff = (zip[cd + 42] | (zip[cd + 43] << 8) | (zip[cd + 44] << 16) | (zip[cd + 45] << 24)) >>> 0;
    eq([zip[localOff], zip[localOff + 1], zip[localOff + 2], zip[localOff + 3]], [0x50, 0x4b, 0x03, 0x04], 'header local apontado pelo CD ' + i);
    const lNameLen = zip[localOff + 26] | (zip[localOff + 27] << 8);
    eq(new TextDecoder().decode(zip.slice(localOff + 30, localOff + 30 + lNameLen)), names[i], 'nome do header local ' + i);
    const lSize = (zip[localOff + 18] | (zip[localOff + 19] << 8) | (zip[localOff + 20] << 16) | (zip[localOff + 21] << 24)) >>> 0;
    eq(lSize, datas[i].length, 'tamanho no header local ' + i);
    const lData = zip.slice(localOff + 30 + lNameLen, localOff + 30 + lNameLen + lSize);
    eq(C.crc32(lData), C.crc32(datas[i]), 'dados íntegros no offset apontado ' + i);
    cd += 46 + cdNameLen;
  }
  eq(cd, cdStart + cdSize, 'CD termina exatamente no fim declarado');
}

// Várias entradas com tamanhos diferentes: cada offset do CD precisa apontar
// para o header local certo (regressão: offsets truncados/zerados corrompiam
// tudo menos a 1ª entrada).
{
  const entradas = [
    { name: 'um.png', data: new Uint8Array(1000).fill(1) },
    { name: 'dois.jpg', data: new Uint8Array(5000).fill(2) },
    { name: 'três acentuado.gif', data: new Uint8Array(123).fill(3) },
    { name: 'quatro.bmp', data: new Uint8Array(77777).fill(4) },
  ];
  const zip = C.zipStore(entradas);
  const eocd = zip.slice(zip.length - 22);
  const cdStart = (eocd[16] | (eocd[17] << 8) | (eocd[18] << 16) | (eocd[19] << 24)) >>> 0;
  let off = cdStart;
  let anterior = -1;
  for (let i = 0; i < entradas.length; i++) {
    const nameLen = zip[off + 28] | (zip[off + 29] << 8);
    const localOff = (zip[off + 42] | (zip[off + 43] << 8) | (zip[off + 44] << 16) | (zip[off + 45] << 24)) >>> 0;
    ok(localOff > anterior, 'offset crescente na entrada ' + i + ' (' + localOff + ')');
    eq([zip[localOff], zip[localOff + 1], zip[localOff + 2], zip[localOff + 3]], [0x50, 0x4b, 0x03, 0x04], 'assinatura local na entrada ' + i);
    const lNameLen = zip[localOff + 26] | (zip[localOff + 27] << 8);
    eq(new TextDecoder().decode(zip.slice(localOff + 30, localOff + 30 + lNameLen)), entradas[i].name, 'nome na entrada ' + i);
    const lSize = (zip[localOff + 18] | (zip[localOff + 19] << 8) | (zip[localOff + 20] << 16) | (zip[localOff + 21] << 24)) >>> 0;
    eq(lSize, entradas[i].data.length, 'tamanho na entrada ' + i);
    const dados = zip.slice(localOff + 30 + lNameLen, localOff + 30 + lNameLen + lSize);
    eq(C.crc32(dados), C.crc32(entradas[i].data), 'dados byte a byte na entrada ' + i);
    anterior = localOff;
    off += 46 + nameLen;
  }
}

// ZIP com nome acentuado: UTF-8 + flag, lido pelo `.NET` como texto certo.
{
  const nomeAcc = 'praia_à_noite.png';
  const zip = C.zipStore([{ name: nomeAcc, data: new TextEncoder().encode('x') }]);
  const cdStart = zip[zip.length - 6] | (zip[zip.length - 5] << 8) | (zip[zip.length - 4] << 16) | (zip[zip.length - 3] << 24);
  const flags = zip[cdStart + 8] | (zip[cdStart + 9] << 8);
  ok((flags & 0x0800) !== 0, 'nome acentuado marca UTF-8');
  const nameLen = zip[cdStart + 28] | (zip[cdStart + 29] << 8);
  eq(new TextDecoder().decode(zip.slice(cdStart + 46, cdStart + 46 + nameLen)), nomeAcc, 'nome acentuado sobrevive ao CD');
}

/* ---------------------------------------------------------
   CRC-32 e base64
   --------------------------------------------------------- */
console.log('CRC-32 / base64');
{
  const data = new TextEncoder().encode('123456789');
  eq(C.crc32(data), 0xCBF43926, 'CRC-32 de "123456789"');
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const b64 = C.toBase64(bytes);
  eq(b64, 'AQIDBAU=', 'base64 de [1..5]');
  const back = C.fromBase64(b64);
  eq(Array.from(back), [1, 2, 3, 4, 5], 'base64 round-trip');
}

console.log('\n' + passed + ' ok, ' + failed + ' falha(s)');
process.exit(failed ? 1 : 0);
