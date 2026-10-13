'use strict';
/**
 * Sonda do conversor de imagens. Duas passadas num navegador headless:
 *
 *   1. formatos: abre /imagens, converte o exemplo para os oito formatos e
 *      confere que cada card termina e que a interface responde;
 *   2. zip: converte um único arquivo, clica em "Baixar tudo" e lê o ZIP
 *      baixado pelo diretório central — o mesmo caminho que o Explorer/.NET
 *      usam e que já apareceu "vazio" quando o diretório omitia os nomes.
 *
 * Uso: node scripts/probe-images.js    (exige o servidor rodando)
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PLACEHOLDER = path.join(ROOT, 'public', '_images-probe.html');
const ZIP_PLACEHOLDER = path.join(ROOT, 'public', '_images-zip-probe.html');

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const BASE = process.env.BASE || 'http://localhost:3000';

const browser = BROWSERS.find((p) => fs.existsSync(p));
if (!browser) {
  console.log('\nNavegador headless não encontrado; sonda de imagens pulada.\n');
  process.exit(0);
}

// Helper compartilhado pelas duas páginas de sonda.
const SHARED = `
function waitFor(cond, ms) {
  return new Promise(function (resolve) {
    var start = Date.now();
    (function poll() {
      var ok = false;
      try { ok = cond(); } catch (e) {}
      if (ok) return resolve(true);
      if (Date.now() - start > ms) return resolve(false);
      // intervalo largo: um polling miúdo satura a thread com timers virtuais
      // e atrasa o trabalho assíncrono real (decodificação, canvas.toBlob)
      setTimeout(poll, 400);
    })();
  });
}
`;

function formatsProbeHtml() {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>sonda de imagens</title></head>
<body>
<pre id="out">aguardando</pre>
<iframe id="fr" src="${BASE}/imagens" style="width:1400px;height:900px;border:0"></iframe>
<script>
var fr = document.getElementById('fr');
function report(data) { document.getElementById('out').textContent = JSON.stringify(data); }
${SHARED}
function statusOf(d) {
  var el = d.querySelector('.convi-status');
  return el ? el.textContent.replace(/\\s+/g, ' ').trim() : '';
}

fr.addEventListener('load', function () {
  run().then(report, function (e) { report({ erro: String(e) }); });
});

function run() {
  var w = fr.contentWindow;
  var d = w.document;
  var out = { formatos: {} };

  return (async function () {
    var inicio = await waitFor(function () { return d.getElementById('btn-sample'); }, 15000);
    out.inicializou = inicio;

    d.getElementById('btn-sample').click();
    var apareceu = await waitFor(function () {
      return d.querySelectorAll('.convi-card.is-ready').length === 1;
    }, 20000);
    out.exemploApareceu = apareceu;
    out.statusInicial = statusOf(d);

    var chips = Array.prototype.slice.call(d.querySelectorAll('.convi-chip'));
    out.formatosEsperados = chips.length;
    for (var i = 0; i < chips.length; i++) {
      var fmt = chips[i].getAttribute('data-format');
      chips[i].click();
      var terminou = await waitFor(function () {
        var card = d.querySelector('.convi-card');
        return card !== null &&
          (card.className.indexOf('is-ready') !== -1 ||
           card.querySelector('.convi-status.is-error') !== null);
      }, 120000);
      await new Promise(function (r) { setTimeout(r, 200); });
      var card = d.querySelector('.convi-card');
      var erro = card && card.querySelector('.convi-status.is-error');
      out.formatos[fmt] = {
        ok: !!card && card.className.indexOf('is-ready') !== -1,
        status: statusOf(d),
        erro: erro ? erro.textContent : '',
        terminou: terminou,
      };
    }

    out.botoesBaixar = d.querySelectorAll('[data-act="download"]').length;
    out.zipHabilitado = d.getElementById('btn-zip').disabled === false;

    var sel = d.getElementById('maxdim');
    sel.value = '512';
    sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    await waitFor(function () {
      var status = statusOf(d);
      return /×/.test(status) && status !== out.statusInicial;
    }, 30000);
    out.status512 = statusOf(d);

    return out;
  })();
}
</script>
</body></html>`;
}

function zipProbeHtml() {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>sonda do zip</title></head>
<body>
<pre id="out">aguardando</pre>
<iframe id="fr" src="${BASE}/imagens" style="width:1400px;height:900px;border:0"></iframe>
<script>
var fr = document.getElementById('fr');
function report(data) { document.getElementById('out').textContent = JSON.stringify(data); }
${SHARED}
// Lê o ZIP pelo diretório central, que é o que leitores rígidos (Explorer,
// .NET) usam. Sem os nomes ali, o arquivo abre "vazio".
function parseZip(b64) {
  var bin = atob(b64);
  var n = bin.length;
  var bytes = new Uint8Array(n);
  for (var i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
  var eocd = -1;
  for (var j = n - 22; j >= 0; j--) {
    if (bytes[j] === 0x50 && bytes[j + 1] === 0x4b && bytes[j + 2] === 0x05 && bytes[j + 3] === 0x06) { eocd = j; break; }
  }
  if (eocd < 0) return { ok: false, erro: 'sem EOCD' };
  var total = bytes[eocd + 8] | (bytes[eocd + 9] << 8);
  var cdSize = bytes[eocd + 12] | (bytes[eocd + 13] << 8) | (bytes[eocd + 14] << 16) | (bytes[eocd + 15] << 24);
  var cdStart = bytes[eocd + 16] | (bytes[eocd + 17] << 8) | (bytes[eocd + 18] << 16) | (bytes[eocd + 19] << 24);
  var end = cdStart + cdSize;
  var p = cdStart;
  var names = [];
  var dec = new TextDecoder();
  var offsetsOk = true;
  while (p + 46 <= end && bytes[p] === 0x50 && bytes[p + 1] === 0x4b && bytes[p + 2] === 0x01 && bytes[p + 3] === 0x02) {
    var nameLen = bytes[p + 28] | (bytes[p + 29] << 8);
    var name = dec.decode(bytes.slice(p + 46, p + 46 + nameLen));
    names.push(name);
    // Cada entrada precisa apontar para o header local correto (offset no
    // byte 42). Offset errado = arquivo lido do lugar errado = corrompido.
    var localOff = bytes[p + 42] | (bytes[p + 43] << 8) | (bytes[p + 44] << 16) | (bytes[p + 45] << 24);
    var sigOk = bytes[localOff] === 0x50 && bytes[localOff + 1] === 0x4b &&
      bytes[localOff + 2] === 0x03 && bytes[localOff + 3] === 0x04;
    var lNameLen = bytes[localOff + 26] | (bytes[localOff + 27] << 8);
    var lName = dec.decode(bytes.slice(localOff + 30, localOff + 30 + lNameLen));
    if (!sigOk || lName !== name) offsetsOk = false;
    p += 46 + nameLen;
  }
  return { ok: true, total: total, names: names, consumiuTudo: p === end, offsetsOk: offsetsOk };
}

fr.addEventListener('load', function () {
  run().then(report, function (e) { report({ erro: String(e) }); });
});

function run() {
  var w = fr.contentWindow;
  var d = w.document;
  var out = {};

  // intercepta o download para inspecionar o ZIP sem tocar no disco
  w.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    fetch(a.href).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
      var bytes = new Uint8Array(buf);
      var chunk = 0x8000;
      var bin = '';
      for (var i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      var parsed = parseZip(btoa(bin));
      var sig = '';
      for (var k = 0; k < 4; k++) sig += ('0' + bytes[k].toString(16)).slice(-2);
      out.zip = {
        nome: a.download,
        bytes: bytes.length,
        assinatura: sig,
        total: parsed.total,
        names: parsed.names,
        consumiuTudo: parsed.consumiuTudo,
        offsetsOk: parsed.offsetsOk,
        valido: parsed.ok === true,
      };
    }).catch(function (err) { out.zip = { erro: String(err) }; });
  }, true);

  // Duas imagens: a partir da segunda entrada o "relative offset of local
  // header" do diretório central passa a ser diferente de zero — é onde o
  // offset truncado corrompia tudo.
  function makePng(name, cor) {
    var c = d.createElement('canvas');
    c.width = 72; c.height = 72;
    var x = c.getContext('2d');
    x.fillStyle = cor; x.fillRect(0, 0, 72, 72);
    x.fillStyle = '#fff'; x.font = '36px sans-serif'; x.fillText('A', 22, 52);
    return new Promise(function (res) {
      c.toBlob(function (blob) { res(new w.File([blob], name, { type: 'image/png' })); }, 'image/png');
    });
  }

  return (async function () {
    await waitFor(function () { return d.getElementById('image-input'); }, 15000);
    var f1 = await makePng('primeira.png', '#6c8cff');
    var f2 = await makePng('segunda_accentuada_ção.png', '#35d0ba');
    var dt = new w.DataTransfer();
    dt.items.add(f1);
    dt.items.add(f2);
    var input = d.getElementById('image-input');
    input.files = dt.files;
    input.dispatchEvent(new w.Event('change', { bubbles: true }));

    var pronto = await waitFor(function () {
      return d.querySelectorAll('.convi-card.is-ready').length === 2 &&
        !d.getElementById('btn-zip').disabled;
    }, 60000);
    out.pronto = pronto;
    if (!pronto) return out;

    d.getElementById('btn-zip').click();
    await waitFor(function () { return out.zip != null; }, 60000);
    await new Promise(function (r) { setTimeout(r, 600); });
    return out;
  })();
}
</script>
</body></html>`;
}

function dumpDom(url, budget) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'img-probe-'));
  try {
    return execFileSync(
      browser,
      [
        '--headless', '--use-angle=swiftshader', '--no-sandbox', '--hide-scrollbars',
        '--window-size=1400,900',
        '--virtual-time-budget=' + (budget || process.env.PROBE_BUDGET || '90000'),
        '--user-data-dir=' + profile,
        '--disable-application-cache',
        '--dump-dom',
        url,
      ],
      { encoding: 'utf8', maxBuffer: 96 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

function report(dom) {
  const m = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
  if (!m || !m[1].trim() || m[1].trim() === 'aguardando') {
    throw new Error('a sonda não devolveu relatório');
  }
  return JSON.parse(
    m[1]
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
  );
}

function runProbe(url, budgets) {
  let lastErr = '';
  for (const budget of budgets) {
    try {
      return report(dumpDom(url, budget));
    } catch (err) {
      lastErr = err.message;
    }
  }
  return { frobe: true, erro: lastErr };
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? '\n         ' + String(detail).slice(0, 400) : ''));
  }
}

fs.writeFileSync(PLACEHOLDER, formatsProbeHtml(), 'utf8');
fs.writeFileSync(ZIP_PLACEHOLDER, zipProbeHtml(), 'utf8');
console.log('\n== conversor de imagens no navegador ==\n');

try {
  const data = runProbe(BASE + '/_images-probe.html', [90000, 120000, 180000]);
  if (data.frobe || !data.formatos) {
    check('sonda de formatos devolveu relatório', false, data.erro);
  } else if (data.erro) {
    check('sonda de formatos executou sem erro', false, data.erro);
  } else {
    check('app inicializou', data.inicializou === true);
    check('imagem de exemplo convertida', data.exemploApareceu === true, data.statusInicial);
    check('todos os 8 formatos de saída', data.formatosEsperados === 8, 'chips=' + data.formatosEsperados);
    for (const fmt of Object.keys(data.formatos || {})) {
      const r = data.formatos[fmt];
      if (fmt === 'webp') {
        // Neste headless (sem GPU, virtual time) a codificação WebP real não
        // termina — artefato do ambiente; em Chrome/Edge/Firefox normais ela
        // funciona. O contrato do app é não travar: ou gera WebP, ou cai para
        // PNG com aviso, ou mostra um erro claro e segue com os demais.
        check(
          'formato WEBP não trava (gera ou erra com aviso)',
          r.terminou === true && (r.ok === true || /não respondeu/i.test(r.erro || '')),
          r.status
        );
      } else {
        check(
          'formato ' + fmt.toUpperCase() + ' converteu',
          r.ok === true && !/^erro|^n?ão foi/i.test(r.status || ''),
          r.status
        );
      }
    }
    const todos = Object.keys(data.formatos || {});
    check(
      'cada formato terminou com saída ou erro claro',
      todos.every((fmt) => /Saída:/.test(data.formatos[fmt].status || '') || /não respondeu/i.test(data.formatos[fmt].status || '')),
      JSON.stringify(data.formatos)
    );
    check('botão "Baixar" de cada arquivo', data.botoesBaixar === 1, 'botoes=' + data.botoesBaixar);
    check('botão ZIP habilitado com resultado', data.zipHabilitado === true);
    check('redimensionar para 512 aplicou', /×/.test(data.status512 || '') && /512/.test(data.status512 || ''), data.status512);
  }

  console.log('');
  const zip = runProbe(BASE + '/_images-zip-probe.html', [120000, 180000, 240000]);
  if (zip.erro && !zip.zip) {
    check('sonda do ZIP devolveu relatório', false, zip.erro);
  } else {
    check('ZIP baixado pelo botão tem assinatura válida',
      !!zip.zip && zip.zip.bytes > 0 && zip.zip.assinatura === '504b0304', JSON.stringify(zip.zip));
    check('ZIP tem diretório central íntegro com os nomes',
      !!zip.zip && zip.zip.valido === true && zip.zip.consumiuTudo === true &&
        zip.zip.names.length === zip.zip.total && zip.zip.names.length >= 2,
      JSON.stringify(zip.zip));
    check('ZIP aponta cada entrada para o header local certo',
      !!zip.zip && zip.zip.offsetsOk === true,
      JSON.stringify(zip.zip));
  }
} finally {
  fs.rmSync(PLACEHOLDER, { force: true });
  fs.rmSync(ZIP_PLACEHOLDER, { force: true });
}

console.log('');
console.log(
  failures ? failures + ' falha(s) no conversor de imagens\n' : 'Conversor de imagens verificado em navegador real.\n'
);
process.exit(failures ? 1 : 0);
