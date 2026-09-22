/* 與私人資料 repo 溝通：讀寫 data.json、讀 prices.json、觸發報價更新 workflow。 */
(function () {
  "use strict";
  var API = "https://api.github.com";
  var CFG_KEY = "invest-tracker-config";
  var WORKFLOW = "update-prices.yml";

  function loadConfig() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY)) || null; } catch (e) { return null; }
  }
  function saveConfig(cfg) {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* 私密視窗等情況 */ }
  }
  function clearConfig() {
    try { localStorage.removeItem(CFG_KEY); } catch (e) { /* ignore */ }
  }

  function b64decode(s) {
    var bin = atob(s.replace(/\n/g, "")), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function b64encode(str) {
    var bytes = new TextEncoder().encode(str), bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function GitHub(cfg) { this.cfg = cfg; }

  GitHub.prototype.request = function (method, path, body) {
    return fetch(API + "/repos/" + this.cfg.owner + "/" + this.cfg.repo + path, {
      method: method,
      cache: "no-store",
      headers: {
        "Authorization": "Bearer " + this.cfg.token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (r.status === 204) return null;
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var err = new Error(j.message || ("HTTP " + r.status));
          err.status = r.status;
          throw err;
        }
        return j;
      });
    });
  };

  /** 確認 token 可以存取資料 repo。 */
  GitHub.prototype.check = function () { return this.request("GET", ""); };

  /** 讀取 JSON 檔，回傳 {data, sha}；檔案不存在回傳 {data: null, sha: null}。 */
  GitHub.prototype.readJson = function (file) {
    return this.request("GET", "/contents/" + file + "?t=" + Date.now()).then(function (j) {
      return { data: JSON.parse(b64decode(j.content)), sha: j.sha };
    }, function (e) {
      if (e.status === 404) return { data: null, sha: null };
      throw e;
    });
  };

  GitHub.prototype.writeJson = function (file, data, sha, message) {
    var body = { message: message, content: b64encode(JSON.stringify(data, null, 1) + "\n") };
    if (sha) body.sha = sha;
    return this.request("PUT", "/contents/" + file, body).then(function (j) { return j.content.sha; });
  };

  /**
   * 把操作寫進 data.json：讀最新版 → 套用 → 以 sha 寫回；
   * 若期間被其他裝置改過（409/422 衝突），重新讀取再套用，最多 3 次。
   */
  GitHub.prototype.commitOps = function (ops, message) {
    var self = this;
    function attempt(n) {
      return self.readJson("data.json").then(function (cur) {
        if (!cur.data) throw new Error("資料 repo 中找不到 data.json");
        var doc = cur.data;
        ops.forEach(function (op) { Calc.applyOp(doc, op); });
        return self.writeJson("data.json", doc, cur.sha, message).then(function (sha) {
          return { data: doc, sha: sha };
        });
      }).catch(function (e) {
        if ((e.status === 409 || e.status === 422) && n < 3) return attempt(n + 1);
        throw e;
      });
    }
    return attempt(1);
  };

  /** 觸發 GitHub Actions 更新報價。 */
  GitHub.prototype.dispatchPrices = function () {
    var self = this;
    return this.request("GET", "").then(function (repo) {
      return self.request("POST", "/actions/workflows/" + WORKFLOW + "/dispatches", { ref: repo.default_branch });
    });
  };

  window.GitHubStore = { GitHub: GitHub, loadConfig: loadConfig, saveConfig: saveConfig, clearConfig: clearConfig };
})();
