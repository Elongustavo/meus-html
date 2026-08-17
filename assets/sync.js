/* SiteSync — sincronização de marcações via repositório GitHub.
   Como funciona:
   - O token (fine-grained, escopo Contents RW) fica no localStorage de cada aparelho.
   - As marcações de todas as páginas vivem em data/marcacoes.json no próprio repositório.
   - Cada página chama SiteSync.init({page, onStatus}), depois load() e save(data).
   - Sempre grava primeiro no localStorage (funciona offline) e envia ao GitHub com debounce.
*/
window.SiteSync = (function () {
  const TOKEN_KEY = "gh_sync_token";
  const FILE_PATH = "data/marcacoes.json";
  const DEBOUNCE_MS = 1500;

  let page = null;
  let onStatus = function () {};
  let timer = null;
  let lastSha = null;
  let pendingData = null;

  /* ---- descoberta do repositório pela URL ---- */
  function repoInfo() {
    const h = location.hostname;
    if (!h.endsWith(".github.io")) return null; // aberto localmente (file://) ou outro host
    const owner = h.split(".")[0];
    const segs = location.pathname.split("/").filter(Boolean);
    // site de projeto: /repo/arquivo.html ; site raiz: /arquivo.html
    let repo;
    if (segs.length === 0 || segs[0].endsWith(".html")) repo = h; // user.github.io (raiz)
    else repo = segs[0];
    return { owner: owner, repo: repo };
  }

  function token() { return localStorage.getItem(TOKEN_KEY) || ""; }

  function setToken(t) {
    if (t && t.trim()) localStorage.setItem(TOKEN_KEY, t.trim());
    else localStorage.removeItem(TOKEN_KEY);
  }

  function askToken() {
    const t = prompt("Cole aqui o seu token do GitHub (fica salvo só neste aparelho):");
    if (t && t.trim()) { setToken(t); status("Token salvo. Sincronizando…", "");
      if (pendingData) pushRemote(); else pullRemote().then(function(){}); return true; }
    return false;
  }

  function status(txt, cls) { try { onStatus(txt, cls || ""); } catch (e) {} }

  /* ---- base64 utf-8 ---- */
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(b64.replace(/\n/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ---- API GitHub ---- */
  function apiUrl() {
    const r = repoInfo();
    if (!r) return null;
    return "https://api.github.com/repos/" + r.owner + "/" + r.repo + "/contents/" + FILE_PATH;
  }
  function headers() {
    return {
      "Authorization": "Bearer " + token(),
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
  }

  async function fetchRemote() {
    const url = apiUrl();
    if (!url) throw new Error("local");
    if (!token()) throw new Error("sem-token");
    const res = await fetch(url + "?t=" + Date.now(), { headers: headers() });
    if (res.status === 404) { lastSha = null; return {}; }
    if (res.status === 401 || res.status === 403) throw new Error("auth");
    if (!res.ok) throw new Error("http-" + res.status);
    const j = await res.json();
    lastSha = j.sha;
    try { return JSON.parse(b64decode(j.content)) || {}; } catch (e) { return {}; }
  }

  async function putRemote(all) {
    const url = apiUrl();
    const body = {
      message: "marcações: " + page + " (" + new Date().toISOString() + ")",
      content: b64encode(JSON.stringify(all, null, 1))
    };
    if (lastSha) body.sha = lastSha;
    const res = await fetch(url, { method: "PUT", headers: headers(), body: JSON.stringify(body) });
    if (res.status === 409 || res.status === 422) throw new Error("conflito");
    if (res.status === 401 || res.status === 403) throw new Error("auth");
    if (!res.ok) throw new Error("http-" + res.status);
    const j = await res.json();
    lastSha = j.content && j.content.sha;
  }

  /* ---- cache local ---- */
  function cacheKey() { return "sync_cache_" + page; }
  function dirtyKey() { return "sync_dirty_" + page; }
  function readCache() {
    try { return JSON.parse(localStorage.getItem(cacheKey())) || null; } catch (e) { return null; }
  }
  function writeCache(entry) { localStorage.setItem(cacheKey(), JSON.stringify(entry)); }

  /* ---- envio com debounce e retentativa em conflito ---- */
  async function pushRemote() {
    if (pendingData == null) return;
    const dataToSend = pendingData;
    try {
      status("Salvando…", "salvando");
      const all = await fetchRemote();          // pega versão + sha atuais
      all[page] = { t: Date.now(), data: dataToSend };
      await putRemote(all);
      localStorage.removeItem(dirtyKey());
      if (pendingData === dataToSend) pendingData = null;
      const agora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      status("Sincronizado às " + agora, "ok");
    } catch (err) {
      if (err.message === "conflito") { setTimeout(pushRemote, 800); return; }
      if (err.message === "sem-token") { status("Salvo neste aparelho. Toque aqui para ativar a sincronização.", "aviso"); return; }
      if (err.message === "auth") { status("Token inválido ou expirado — toque aqui para colar outro.", "erro"); return; }
      if (err.message === "local") { status("Salvo neste aparelho (abra pelo site para sincronizar).", "aviso"); return; }
      status("Sem conexão — salvo neste aparelho; sincroniza quando a internet voltar.", "aviso");
      setTimeout(pushRemote, 15000);
    }
  }

  async function pullRemote() {
    const all = await fetchRemote();
    return all[page] || null;
  }

  /* ---- API pública ---- */
  return {
    init: function (opts) {
      page = opts.page;
      onStatus = opts.onStatus || onStatus;
      window.addEventListener("online", function () { if (pendingData != null) pushRemote(); });
    },
    hasToken: function () { return !!token(); },
    setToken: setToken,
    askToken: askToken,
    /* Carrega o estado: devolve o mais novo entre cache local e remoto. */
    load: async function () {
      const local = readCache();
      if (localStorage.getItem(dirtyKey()) === "1" && local) {
        pendingData = local.data; pushRemote();
        return local.data;
      }
      try {
        const remote = await pullRemote();
        if (remote && (!local || remote.t >= local.t)) {
          writeCache(remote);
          status("Sincronizado.", "ok");
          return remote.data;
        }
      } catch (err) {
        if (err.message === "sem-token") status("Toque aqui para ativar a sincronização entre aparelhos.", "aviso");
        else if (err.message === "auth") status("Token inválido ou expirado — toque aqui para colar outro.", "erro");
        else if (err.message !== "local") status("Sem conexão — usando o que está salvo neste aparelho.", "aviso");
      }
      return local ? local.data : null;
    },
    /* Salva: grava local na hora, envia ao GitHub com debounce. */
    save: function (data) {
      writeCache({ t: Date.now(), data: data });
      localStorage.setItem(dirtyKey(), "1");
      pendingData = data;
      clearTimeout(timer);
      timer = setTimeout(pushRemote, DEBOUNCE_MS);
    }
  };
})();
