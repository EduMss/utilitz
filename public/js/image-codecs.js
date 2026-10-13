/* =========================================================
   Encoders de imagens em JavaScript puro

   Este módulo é o "motor" do conversor de imagens. Tudo acontece
   no navegador: nenhuma imagem sai do dispositivo. Os encoders
   aqui são implementações pequenas e deterministas de BMP, TIFF,
   GIF (LZW + quantização por median cut), ICO e SVG, além de um
   ZIP (método STORE) para baixar vários resultados de uma vez.

   O módulo funciona no navegador (window.ImageCodecs) e também
   em Node (module.exports), o que permite testar a matemática dos
   encoders sem um browser.
   ========================================================= */
(function (root) {
  'use strict';

  /* ---------------------------------------------------------
     Utilidades de escrita de números (little-endian)
     --------------------------------------------------------- */
  function writeU16(arr, off, v) {
    arr[off] = v & 255;
    arr[off + 1] = (v >>> 8) & 255;
  }
  function writeU32(arr, off, v) {
    arr[off] = v & 255;
    arr[off + 1] = (v >>> 8) & 255;
    arr[off + 2] = (v >>> 16) & 255;
    arr[off + 3] = (v >>> 24) & 255;
  }

  /* ---------------------------------------------------------
     CRC-32 (polinômio 0xEDB88320)
     --------------------------------------------------------- */
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c;
    }
    return table;
  })();

  function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------------------------------------------------------
     Base64
     --------------------------------------------------------- */
  function toBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function fromBase64(str) {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /* ---------------------------------------------------------
     LZW (compressão do GIF)
     --------------------------------------------------------- */

  /**
   * "LZW minimum code size" do GIF (bits por pixel): o menor M >= 2 tal
   * que 2^M >= número de cores. É este valor que vai no cabeçalho do GIF;
   * o tamanho inicial dos códigos é M + 1, pois o código de limpeza vale
   * 2^M e precisa de um bit a mais.
   */
  function minCodeSize(numColors) {
    let m = 2;
    while ((1 << m) < numColors) m++;
    return m;
  }

  /**
   * Codifica a sequência de índices de paleta com LZW (formato GIF).
   * @param {Uint8Array|number[]} indices
   * @param {number} numColors
   * @returns {Uint8Array} bytes do stream LZW (sem os sub-blocos GIF)
   */
  function lzwEncode(indices, numColors) {
    const m = minCodeSize(numColors);
    const clearCode = 1 << m;
    const endCode = clearCode + 1;
    let codeSize = m + 1;
    let nextCode = clearCode + 2;
    const dict = new Map();
    const out = [];
    let byte = 0;
    let bitPos = 7;

    /* Empacota os bits MSB-first, como exige o GIF. */
    function emit(code) {
      for (let i = codeSize - 1; i >= 0; i--) {
        const bit = (code >>> i) & 1;
        byte |= bit << bitPos;
        bitPos--;
        if (bitPos < 0) {
          out.push(byte);
          byte = 0;
          bitPos = 7;
        }
      }
    }

    /* O fluxo LZW do GIF começa sempre com um código de limpeza. */
    emit(clearCode);

    if (indices.length) {
      let last = indices[0];
      for (let i = 1; i < indices.length; i++) {
        const sym = indices[i];
        const key = last * 4096 + sym;
        if (dict.has(key)) {
          last = dict.get(key);
        } else {
          emit(last);
          dict.set(key, nextCode++);
          last = sym;
          /* Alarga quando o próximo código a atribuir não cabe mais.
             Vale ">" porque, no fluxo, o decodificador tem uma entrada
             a menos que o codificador neste ponto. */
          if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
        }
      }
      emit(last);
      /* O decodificador ADICIONA uma entrada ao ler este último código,
         então aqui as duas tabelas empatam: a comparação é ">=". */
      if (nextCode >= (1 << codeSize) && codeSize < 12) codeSize++;
    }
    emit(endCode);
    if (bitPos < 7) out.push(byte);
    return new Uint8Array(out);
  }

  /* ---------------------------------------------------------
     Quantização por median cut (para GIF, máx. 256 cores)
     --------------------------------------------------------- */

  /** Chave de cor reduzida a 5 bits por canal (15 bits no total). */
  function reduceKey(key) {
    const r = ((key >>> 16) & 255) >> 3;
    const g = ((key >>> 8) & 255) >> 3;
    const b = (key & 255) >> 3;
    return (r << 10) | (g << 5) | b;
  }

  /** Acumula um tom num balde: cor média ponderada e contagem. */
  function addBucket(buckets, list, key, rk, count) {
    let bucket = buckets.get(rk);
    if (!bucket) {
      bucket = { rk: rk, count: 0, r: 0, g: 0, b: 0 };
      buckets.set(rk, bucket);
      list.push(bucket);
    }
    bucket.count += count;
    bucket.r += (key >>> 16) * count;
    bucket.g += ((key >>> 8) & 255) * count;
    bucket.b += (key & 255) * count;
  }

  /** Canal médio de um balde (0=R, 1=G, 2=B). */
  function bucketChannel(bucket, ch) {
    if (ch === 0) return bucket.r / bucket.count;
    if (ch === 1) return bucket.g / bucket.count;
    return bucket.b / bucket.count;
  }

  /**
   * Reduz a imagem (RGBA) a uma paleta de até 256 cores.
   *
   * Devolve `indexFor(key)`, que associa a cor RGB (0xRRGGBB) de um pixel ao
   * índice na paleta. Devolver uma função em vez de um Map evita guardar uma
   * entrada por cor distinta — uma foto pode ter milhões delas; o agrupamento
   * em 5 bits por canal mantém o custo previsível.
   *
   * @returns {{palette: number[][], indexFor: (key: number) => number}}
   */
  function quantize(rgba, width, height) {
    const n = width * height;

    // Uma paleta exata cabe quando há poucas cores (ícones, capturas). O laço
    // sai cedo assim que as cores se multiplicam, antes de gastar memória.
    const MAX_EXACT = 1024;
    const exactCounts = new Map();
    let exact = true;
    for (let i = 0; i < n; i++) {
      const key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
      exactCounts.set(key, (exactCounts.get(key) || 0) + 1);
      if (exactCounts.size > MAX_EXACT) { exact = false; break; }
    }

    if (exact && exactCounts.size <= 256) {
      const palette = [];
      const index = new Map();
      for (const key of exactCounts.keys()) {
        index.set(key, palette.length);
        palette.push([(key >>> 16) & 255, (key >>> 8) & 255, key & 255]);
      }
      return { palette, indexFor: (key) => index.get(key) };
    }

    const buckets = new Map();
    const list = [];
    if (exact) {
      for (const [key, count] of exactCounts) addBucket(buckets, list, key, key, count);
    } else {
      for (let i = 0; i < n; i++) {
        const key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
        addBucket(buckets, list, key, reduceKey(key), 1);
      }
    }

    let boxes = [{ buckets: list }];
    while (boxes.length < 256) {
      let bi = -1;
      let br = -1;
      for (let i = 0; i < boxes.length; i++) {
        const bs = boxes[i].buckets;
        if (bs.length < 2) continue;
        let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
        for (const b of bs) {
          const r = bucketChannel(b, 0), g = bucketChannel(b, 1), bl = bucketChannel(b, 2);
          if (r < minR) minR = r; if (r > maxR) maxR = r;
          if (g < minG) minG = g; if (g > maxG) maxG = g;
          if (bl < minB) minB = bl; if (bl > maxB) maxB = bl;
        }
        const range = Math.max(maxR - minR, maxG - minG, maxB - minB);
        if (range > br) { br = range; bi = i; }
      }
      if (bi === -1 || br === 0) break;

      const box = boxes[bi];
      let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
      for (const b of box.buckets) {
        const r = bucketChannel(b, 0), g = bucketChannel(b, 1), bl = bucketChannel(b, 2);
        if (r < minR) minR = r; if (r > maxR) maxR = r;
        if (g < minG) minG = g; if (g > maxG) maxG = g;
        if (bl < minB) minB = bl; if (bl > maxB) maxB = bl;
      }
      const dr = maxR - minR, dg = maxG - minG, db = maxB - minB;
      const ch = (dr >= dg && dr >= db) ? 0 : (dg >= db ? 1 : 2);
      box.buckets.sort((a, b) => bucketChannel(a, ch) - bucketChannel(b, ch));
      const mid = Math.floor(box.buckets.length / 2);
      boxes.splice(bi, 1, { buckets: box.buckets.slice(0, mid) }, { buckets: box.buckets.slice(mid) });
    }

    const palette = [];
    const bucketIndex = new Map();
    for (const box of boxes) {
      let sr = 0, sg = 0, sb = 0, cnt = 0;
      for (const b of box.buckets) { sr += b.r; sg += b.g; sb += b.b; cnt += b.count; }
      const idx = palette.length;
      palette.push([Math.round(sr / cnt), Math.round(sg / cnt), Math.round(sb / cnt)]);
      for (const b of box.buckets) bucketIndex.set(b.rk, idx);
    }

    if (exact) return { palette, indexFor: (key) => bucketIndex.get(key) };
    return { palette, indexFor: (key) => bucketIndex.get(reduceKey(key)) };
  }

  /* ---------------------------------------------------------
     GIF
     --------------------------------------------------------- */
  function encodeGif(rgba, width, height) {
    const { palette, indexFor } = quantize(rgba, width, height);
    const n = width * height;
    const indices = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
      indices[i] = indexFor(key);
    }
    const lzw = lzwEncode(indices, palette.length);

    const minCode = minCodeSize(palette.length);
    const tableSize = 1 << minCode;
    const tableBits = minCode - 1;
    const packed = 0x80 | (7 << 4) | tableBits;

    const all = [];
    // GIF89a
    all.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
    // Logical Screen Descriptor
    all.push(width & 255, (width >>> 8) & 255, height & 255, (height >>> 8) & 255);
    all.push(packed, 0, 0);
    // Global Color Table
    for (let i = 0; i < tableSize; i++) {
      if (i < palette.length) {
        const c = palette[i];
        all.push(c[0], c[1], c[2]);
      } else {
        all.push(0, 0, 0);
      }
    }
    // Image Descriptor
    all.push(0x2C, 0, 0, 0, 0, width & 255, (width >>> 8) & 255, height & 255, (height >>> 8) & 255, 0);
    // LZW Min Code Size
    all.push(minCode);
    // LZW data in sub-blocks (<=255 bytes each) + terminator
    let pos = 0;
    while (pos < lzw.length) {
      const end = Math.min(pos + 255, lzw.length);
      all.push(end - pos);
      for (let i = pos; i < end; i++) all.push(lzw[i]);
      pos = end;
    }
    all.push(0); // terminador de sub-blocos
    return new Uint8Array(all);
  }

  /* ---------------------------------------------------------
     BMP (24 bits, sem compressão)
     --------------------------------------------------------- */
  function encodeBmp(rgba, width, height) {
    const rowBytes = Math.ceil((width * 3) / 4) * 4;
    const dataSize = rowBytes * height;
    const fileSize = 54 + dataSize;
    const out = new Uint8Array(fileSize);

    // BITMAPFILEHEADER
    out[0] = 0x42; out[1] = 0x4D; // 'BM'
    writeU32(out, 2, fileSize);
    writeU32(out, 6, 0);
    writeU32(out, 10, 54);
    // BITMAPINFOHEADER
    writeU32(out, 14, 40);
    writeU32(out, 18, width);
    writeU32(out, 22, height);
    writeU16(out, 26, 1);
    writeU16(out, 28, 24);
    writeU32(out, 30, 0);
    writeU32(out, 34, dataSize);
    writeU32(out, 38, 2835);
    writeU32(out, 42, 2835);
    writeU32(out, 46, 0);
    writeU32(out, 50, 0);

    // pixels: bottom-up, BGR
    for (let y = 0; y < height; y++) {
      const srcRow = height - 1 - y;
      let dst = 54 + y * rowBytes;
      for (let x = 0; x < width; x++) {
        const i = (srcRow * width + x) * 4;
        out[dst++] = rgba[i + 2]; // B
        out[dst++] = rgba[i + 1]; // G
        out[dst++] = rgba[i];     // R
      }
    }
    return out;
  }

  /* ---------------------------------------------------------
     TIFF (sem compressão, RGB 8 bits)
     --------------------------------------------------------- */
  function encodeTiff(rgba, width, height) {
    const stripSize = width * height * 3;
    const ifdOffset = 8;
    const numTags = 9;
    const ifdSize = 2 + numTags * 12 + 2;
    const poolStart = ifdOffset + ifdSize;
    const poolSize = 6; // BitsPerSample [8,8,8]
    const stripStart = poolStart + poolSize;
    const total = stripStart + stripSize;

    const out = new Uint8Array(total);
    // header: 'II' + 0x2A00 + offset do IFD
    out[0] = 0x49; out[1] = 0x49;
    out[2] = 0x2A; out[3] = 0x00;
    writeU32(out, 4, ifdOffset);

    let p = ifdOffset;
    writeU16(out, p, numTags); p += 2;

    // tags em ordem ascendente
    const tags = [
      [256, 4, 1, width],       // ImageWidth (LONG)
      [257, 4, 1, height],      // ImageLength (LONG)
      [258, 3, 1, 1],           // Compression = NONE (SHORT)
      [259, 3, 1, 2],           // PhotoInterpretation = RGB (SHORT)
      [261, 3, 3, poolStart],   // BitsPerSample (SHORT x3, offset)
      [273, 3, 1, 3],           // SamplesPerPixel (SHORT)
      [277, 4, 1, height],      // RowsPerStrip (LONG)
      [278, 4, 1, stripStart],  // StripOffsets (LONG)
      [279, 4, 1, stripSize],   // StripByteCounts (LONG)
    ];
    for (const [tag, type, count, value] of tags) {
      writeU16(out, p, tag); p += 2;
      writeU16(out, p, type); p += 2;
      writeU32(out, p, count); p += 4;
      if (type === 4 && count === 1) {
        writeU32(out, p, value); p += 4;
      } else if (type === 3 && count === 1) {
        writeU16(out, p, value); p += 2;
        writeU16(out, p, 0); p += 2;
      } else {
        writeU32(out, p, value); p += 4;
      }
    }
    writeU32(out, p, 0); // próximo IFD (nenhum)

    // pool: BitsPerSample
    writeU16(out, poolStart, 8);
    writeU16(out, poolStart + 2, 8);
    writeU16(out, poolStart + 4, 8);

    // strip: RGB
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const o = stripStart + (y * width + x) * 3;
        out[o] = rgba[i];
        out[o + 1] = rgba[i + 1];
        out[o + 2] = rgba[i + 2];
      }
    }
    return out;
  }

  /* ---------------------------------------------------------
     ICO (PNG embutido)
     --------------------------------------------------------- */
  function encodeIco(pngBytes, width, height) {
    const out = new Uint8Array(6 + 16 + pngBytes.length);
    // header: reserved(2) + count(2)
    out[0] = 0; out[1] = 0;
    out[2] = 0; out[3] = 1;
    // directory entry
    out[6] = width >= 256 ? 0 : width;
    out[7] = height >= 256 ? 0 : height;
    out[8] = 32; // bits por pixel (PNG usa 32)
    out[9] = 0; out[10] = 0;
    writeU32(out, 12, pngBytes.length);
    writeU32(out, 16, 22); // offset dos dados
    out.set(pngBytes, 22);
    return out;
  }

  /* ---------------------------------------------------------
     SVG (PNG embutido como data URL)
     --------------------------------------------------------- */
  function encodeSvg(pngBytes, width, height) {
    const b64 = toBase64(pngBytes);
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
      '" viewBox="0 0 ' + width + ' ' + height + '">' +
      '<image width="' + width + '" height="' + height +
      '" href="data:image/png;base64,' + b64 + '"/></svg>';
  }

  /* ---------------------------------------------------------
     ZIP (método STORE, sem compressão)
     --------------------------------------------------------- */
  function zipStore(files) {
    const enc = new TextEncoder();
    const entries = [];
    const parts = [];
    let offset = 0;

    // Os nomes são gravados em UTF-8; o bit 11 do "general purpose flags"
    // sinaliza isso aos leitores rígidos (Explorer/.NET tratam nomes sem o
    // flag como CP437 e podem estragar ou ignorar nomes com acento).
    const UTF8_NAMES = 0x0800;
    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const crc = crc32(f.data);
      const lh = new Uint8Array(30);
      writeU32(lh, 0, 0x04034b50);
      writeU16(lh, 4, 20);
      writeU16(lh, 6, UTF8_NAMES);
      writeU16(lh, 8, 0);
      writeU16(lh, 10, 0);
      writeU16(lh, 12, 0);
      writeU32(lh, 14, crc);
      writeU32(lh, 18, f.data.length);
      writeU32(lh, 22, f.data.length);
      writeU16(lh, 26, nameBytes.length);
      writeU16(lh, 28, 0);
      parts.push(lh, nameBytes, f.data);
      entries.push({ nameBytes: nameBytes, crc: crc, size: f.data.length, offset: offset });
      offset += 30 + f.data.length + nameBytes.length;
    }

    const cdStart = offset;
    for (const e of entries) {
      const cd = new Uint8Array(46);
      writeU32(cd, 0, 0x02014b50);
      writeU16(cd, 4, 20);
      writeU16(cd, 6, 20);
      writeU16(cd, 8, UTF8_NAMES);
      writeU16(cd, 10, 0);
      writeU16(cd, 12, 0);
      writeU16(cd, 14, 0);
      writeU32(cd, 16, e.crc);
      writeU32(cd, 20, e.size);
      writeU32(cd, 24, e.size);
      writeU16(cd, 28, e.nameBytes.length);
      writeU16(cd, 30, 0);
      writeU16(cd, 32, 0);
      writeU16(cd, 34, 0);        // disco de origem
      writeU16(cd, 36, 0);        // atributos internos
      writeU32(cd, 38, 0);        // atributos externos
      // O deslocamento do header local fica no byte 42 (os atributos externos
      // ocupam 38..41). Gravar em 40 jogava metade do valor no campo errado e
      // deixava o offset truncado — o extrator lia o arquivo no lugar errado e
      // o resultado saía corrompido (só a 1ª entrada, offset 0, escapava).
      writeU32(cd, 42, e.offset);
      // O registro de 46 bytes é seguido pelo nome — sem ele o diretório
      // central fica inválido e leitores rígidos (Explorer, .NET) abrem o
      // ZIP "vazio", ignorando os arquivos que existem nos headers locais.
      parts.push(cd, e.nameBytes);
      offset += 46 + e.nameBytes.length;
    }

    const cdSize = offset - cdStart;
    const eocd = new Uint8Array(22);
    writeU32(eocd, 0, 0x06054b50);
    writeU16(eocd, 4, 0);
    writeU16(eocd, 6, 0);
    writeU16(eocd, 8, entries.length);
    writeU16(eocd, 10, entries.length);
    writeU32(eocd, 12, cdSize);
    writeU32(eocd, 16, cdStart);
    writeU16(eocd, 20, 0);
    parts.push(eocd);

    const total = offset + 22;
    const out = new Uint8Array(total);
    let p = 0;
    for (const part of parts) {
      out.set(part, p);
      p += part.length;
    }
    return out;
  }

  const api = {
    crc32,
    toBase64,
    fromBase64,
    minCodeSize,
    lzwEncode,
    quantize,
    encodeGif,
    encodeBmp,
    encodeTiff,
    encodeIco,
    encodeSvg,
    zipStore,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.ImageCodecs = api;
})(typeof self !== 'undefined' ? self : globalThis);
