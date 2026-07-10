'use strict';

/**
 * Service worker (MV3). Orquestra o estado de captura, guarda os metadados da
 * sessão e trata a exportação via chrome.downloads.
 *
 * Também agrega o status vindo de todos os frames do Teams (o content script
 * roda com all_frames) e mantém o histórico das últimas sessões finalizadas.
 *
 * Importa o núcleo puro para reaproveitar a formatação dos arquivos exportados.
 */
importScripts('transcript-core.js');

const CAPSTATE_KEY = 'capState';
const SESSION_KEY = 'session';
const ENTRIES_KEY = 'entries';
const STATUS_KEY = 'status';
const AUTOMODE_KEY = 'autoMode';
const AUTOSAVE_KEY = 'autoSave';
const HISTORY_KEY = 'history';

const MIME = {
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
};

// Status de cada frame, chaveado por `${tabId}:${frameId}`. Volátil de propósito:
// se o SW hibernar e reiniciar, os frames reenviam no próximo scan.
const frameStatus = new Map();

function frameKey(sender) {
  const tab = sender && sender.tab && sender.tab.id != null ? sender.tab.id : 'x';
  const frame = sender && sender.frameId != null ? sender.frameId : 0;
  return tab + ':' + frame;
}

function setBadge(on) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
  } catch (_noColor) {
    // alguns canais antigos não têm a API; o texto sozinho já dá o recado
  }
  chrome.action.setBadgeText({ text: on ? 'REC' : '' });
}

// Recalcula o status global a partir de todos os frames e grava em storage.
async function recomputeStatus() {
  let capturing = false;
  let captionsDetected = false;
  let count = 0;
  let mode = null;
  for (const v of frameStatus.values()) {
    if (v.captionsDetected) captionsDetected = true;
    if (v.capturing) {
      capturing = true;
      count = v.count || 0;
      if (v.mode) mode = v.mode;
    }
  }
  await chrome.storage.local.set({ [STATUS_KEY]: { capturing, captionsDetected, count, mode } });
  setBadge(capturing);
}

// Abre uma sessão de captura. Se a anterior foi finalizada, começa buffer limpo.
async function openSession() {
  const cur = await chrome.storage.local.get([SESSION_KEY]);
  const s = cur[SESSION_KEY];
  if (!s || !s.startedAt || s.finalized) {
    const patch = {
      [SESSION_KEY]: {
        startedAt: new Date().toISOString(),
        title: s && !s.finalized ? s.title || null : null,
        finalized: false,
      },
    };
    // Sessão realmente nova (nunca aberta ou já finalizada) → zera o buffer vivo.
    if (!s || s.finalized) patch[ENTRIES_KEY] = [];
    await chrome.storage.local.set(patch);
  }
  await chrome.storage.local.set({ [CAPSTATE_KEY]: { capturing: true } });
  setBadge(true);
}

// Finaliza a sessão: arquiva o que foi capturado no histórico (últimas 10) e
// marca como finalizada. NÃO apaga `entries` — o usuário ainda pode exportar a
// sessão recém-encerrada pelo visor; o buffer só zera quando a próxima abrir.
async function finalizeSession() {
  const data = await chrome.storage.local.get([ENTRIES_KEY, SESSION_KEY, HISTORY_KEY, AUTOSAVE_KEY]);
  const entries = Array.isArray(data[ENTRIES_KEY]) ? data[ENTRIES_KEY] : [];
  const session = data[SESSION_KEY] || {};
  const wasOpen = !session.finalized; // primeira finalização desta sessão
  const endedAt = new Date().toISOString();
  const patch = { [CAPSTATE_KEY]: { capturing: false } };

  if (entries.length && wasOpen) {
    const record = {
      inicio: session.startedAt || null,
      fim: endedAt,
      titulo: session.title || 'Reunião do Teams',
      falas: entries.slice(),
    };
    patch[HISTORY_KEY] = TranscriptCore.pushSession(data[HISTORY_KEY], record, TranscriptCore.MAX_HISTORY);
  }
  const finalized = Object.assign({}, session, { finalized: true, endedAt });
  patch[SESSION_KEY] = finalized;
  await chrome.storage.local.set(patch);
  setBadge(false);

  // Salvamento automático em disco: só na primeira finalização, com o toggle
  // ligado (padrão) e ao menos 1 fala — nunca gera arquivo vazio nem duplicado.
  if (wasOpen && entries.length && data[AUTOSAVE_KEY] !== false) {
    await autoDownload(finalized, entries);
  }
}

// Grava a transcrição em Downloads/Transcricoes Teams/ sem diálogo. `uniquify`
// evita sobrescrever se duas reuniões fecharem no mesmo minuto.
async function autoDownload(session, entries) {
  const filename = TranscriptCore.buildAutoSaveFilename(session, session.startedAt);
  const url = toDataUrl(MIME.md, TranscriptCore.toMeetingMarkdown(session, entries));
  try {
    await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
  } catch (err) {
    console.error('[Transcreve Agenda] salvamento automático falhou', err);
  }
}

async function clearTranscript() {
  await chrome.storage.local.set({
    [ENTRIES_KEY]: [],
    [SESSION_KEY]: { startedAt: new Date().toISOString(), title: null, finalized: false },
    [STATUS_KEY]: { capturing: false, captionsDetected: false, count: 0, mode: null },
  });
}

async function setMeetingTitle(title) {
  const current = await chrome.storage.local.get(SESSION_KEY);
  const session = current[SESSION_KEY] || { startedAt: new Date().toISOString(), title: null };
  if (!session.title && title) {
    session.title = title;
    await chrome.storage.local.set({ [SESSION_KEY]: session });
  }
}

// Service worker MV3 não tem URL.createObjectURL — usamos data URL base64.
// Codificamos em UTF-8 antes do btoa para não corromper acentos (é, ã, ç...).
function toDataUrl(mime, text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return 'data:' + mime + ';charset=utf-8;base64,' + btoa(binary);
}

function formatFor(ext, session, entries) {
  if (ext === 'md') return TranscriptCore.toMarkdown(session, entries);
  if (ext === 'json') return TranscriptCore.toJSON(session, entries);
  return TranscriptCore.toPlainText(session, entries);
}

async function download(ext, session, entries, when) {
  const filename = TranscriptCore.buildFilename(ext, when);
  const url = toDataUrl(MIME[ext], formatFor(ext, session, entries));
  const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
  return { ok: true, downloadId, filename };
}

async function exportTranscript(format) {
  const data = await chrome.storage.local.get([ENTRIES_KEY, SESSION_KEY]);
  const entries = Array.isArray(data[ENTRIES_KEY]) ? data[ENTRIES_KEY] : [];
  if (!entries.length) return { ok: false, reason: 'empty' };
  const ext = format === 'md' || format === 'json' ? format : 'txt';
  return download(ext, data[SESSION_KEY] || {}, entries);
}

async function exportHistory(index, format) {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  const list = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
  const rec = list[index];
  if (!rec || !Array.isArray(rec.falas) || !rec.falas.length) return { ok: false, reason: 'empty' };
  const ext = format === 'md' || format === 'json' ? format : 'txt';
  const session = { startedAt: rec.inicio, title: rec.titulo };
  return download(ext, session, rec.falas, rec.inicio || undefined);
}

const HANDLERS = {
  START: async function () { await openSession(); return { ok: true }; },
  STOP: async function () { await finalizeSession(); return { ok: true }; },
  AUTO_START: async function (msg) {
    await openSession();
    if (msg && msg.title) await setMeetingTitle(msg.title);
    return { ok: true };
  },
  AUTO_END: async function () { await finalizeSession(); return { ok: true }; },
  CLEAR: async function () { await clearTranscript(); return { ok: true }; },
  EXPORT: async function (msg) { return exportTranscript(msg.format); },
  EXPORT_HISTORY: async function (msg) { return exportHistory(msg.index, msg.format); },
  SESSION_STATUS: async function (msg, sender) {
    frameStatus.set(frameKey(sender), msg.status || {});
    await recomputeStatus();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  const handler = msg && msg.type ? HANDLERS[msg.type] : null;
  if (!handler) {
    sendResponse({ ok: false, reason: 'unknown_message' });
    return false;
  }
  // A resposta é assíncrona: mantemos o canal aberto retornando true.
  handler(msg, sender)
    .then(sendResponse)
    .catch(function (err) {
      console.error('[Transcreve Agenda] falha ao tratar', msg.type, err);
      sendResponse({ ok: false, reason: String((err && err.message) || err) });
    });
  return true;
});

// Aba fechada durante a reunião: limpa os frames dela e finaliza se capturava.
chrome.tabs.onRemoved.addListener(async function (tabId) {
  let wasCapturing = false;
  for (const key of Array.from(frameStatus.keys())) {
    if (key.indexOf(tabId + ':') === 0) {
      if (frameStatus.get(key).capturing) wasCapturing = true;
      frameStatus.delete(key);
    }
  }
  if (wasCapturing) await finalizeSession();
  await recomputeStatus();
});

chrome.runtime.onInstalled.addListener(async function () {
  const data = await chrome.storage.local.get([CAPSTATE_KEY, AUTOMODE_KEY, AUTOSAVE_KEY]);
  const patch = {};
  if (!data[CAPSTATE_KEY]) patch[CAPSTATE_KEY] = { capturing: false };
  if (data[AUTOMODE_KEY] === undefined) patch[AUTOMODE_KEY] = true; // modo automático ligado por padrão
  if (data[AUTOSAVE_KEY] === undefined) patch[AUTOSAVE_KEY] = true; // salvar ao fim ligado por padrão
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});
