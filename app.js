/* 信貸投資記帳 — 網頁版 UI。計算邏輯在 calc.js，GitHub 存取在 github.js。 */
(function () {
  "use strict";
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var TYPE_BY_LABEL = {}, MARKET_BY_LABEL = {};
  Object.keys(Calc.TYPE_LABELS).forEach(function (k) { TYPE_BY_LABEL[Calc.TYPE_LABELS[k]] = k; });
  Object.keys(Calc.MARKET_LABELS).forEach(function (k) { MARKET_BY_LABEL[Calc.MARKET_LABELS[k]] = k; });
  var AUTO_RELOAD_MS = 5 * 60 * 1000;
  var CNYES_SEARCH = "https://ess.api.cnyes.com/ess/api/v1/siteSearch/main";

  var state = {
    gh: null, doc: null, prices: {}, pricesSha: null, summary: null,
    editingId: null, pendingLink: null, polling: false
  };

  // ------------------------------------------------------------------ 格式
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmt(v, digits) { return v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits }); }
  function money(v) { return v == null ? "—" : fmt(Math.round(v) || 0, 0); }
  function signed(v) {
    if (v == null) return "—";
    var r = Math.round(v) || 0;
    return (r >= 0 ? "+" : "-") + fmt(Math.abs(r), 0);
  }
  function pct(v) { return v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(2) + "%"; }
  function qtyStr(q) { return fmt(Number(q), 4); }
  function priceStr(p) { return p == null ? "—" : fmt(Number(p), 4); }
  function cls(v) { return v == null || Math.abs(v) < 0.5 ? "" : (v > 0 ? "up" : "down"); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function nowStr() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 3 | 8)).toString(16);
    });
  }

  var toastTimer;
  function toast(msg, isError) {
    var t = $("#toast");
    t.textContent = msg;
    t.className = "toast" + (isError ? " error" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isError ? 6000 : 3000);
  }

  function errMsg(e) {
    if (e && e.status === 401) return "權杖無效或已過期，請登出後重新輸入";
    if (e && e.status === 403) return "權杖權限不足（需要 Contents 與 Actions 的讀寫權限）";
    if (e && e.status === 404) return "找不到資料 repo，或權杖沒有存取這個 repo 的權限";
    return (e && e.message) || String(e);
  }

  // ------------------------------------------------------------------ 啟動 / 連線
  function showSetup(error) {
    $("#main").hidden = true;
    $("#setup").hidden = false;
    $("#setup-error").textContent = error || "";
    var cfg = GitHubStore.loadConfig(), f = $("#setup-form");
    if (cfg) {   // 權杖過期等情況：保留帳號與 repo，只需重新輸入權杖
      f.elements.owner.value = cfg.owner;
      f.elements.repo.value = cfg.repo;
    }
  }

  function connect(cfg) {
    state.gh = new GitHubStore.GitHub(cfg);
    return state.gh.check().then(loadAll).then(function () {
      $("#setup").hidden = true;
      $("#main").hidden = false;
    });
  }

  function loadAll() {
    setSync("讀取中…");
    return Promise.all([state.gh.readJson("data.json"), state.gh.readJson("prices.json")]).then(function (r) {
      if (!r[0].data) throw new Error("資料 repo 中找不到 data.json");
      state.doc = r[0].data;
      state.prices = r[1].data || {};
      state.pricesSha = r[1].sha;
      render();
      setSync("已同步 " + nowStr().slice(11));
    }).catch(function (e) {
      setSync("同步失敗");
      throw e;
    });
  }

  function setSync(text) { $("#sync-status").textContent = text; }

  /** 寫入操作到 GitHub，成功後重新計算畫面。 */
  function commit(ops, message) {
    setSync("儲存中…");
    $$("button").forEach(function (b) { b.dataset.wasDisabled = b.disabled; b.disabled = true; });
    return state.gh.commitOps(ops, message).then(function (res) {
      state.doc = res.data;
      render();
      setSync("已同步 " + nowStr().slice(11));
    }).catch(function (e) {
      setSync("儲存失敗");
      toast("儲存失敗：" + errMsg(e), true);
      throw e;
    }).then(function (v) { restoreButtons(); return v; }, function (e) { restoreButtons(); throw e; });
  }
  function restoreButtons() {
    $$("button").forEach(function (b) { b.disabled = b.dataset.wasDisabled === "true"; });
    if (state.polling) $("#btn-prices").disabled = true;
  }

  // ------------------------------------------------------------------ 報價更新
  function requestPriceUpdate(dispatch) {
    if (state.polling) return;
    state.polling = true;
    $("#btn-prices").disabled = true;
    var startSha = state.pricesSha, tries = 0;
    setPriceStatus("正在更新報價（GitHub Actions 約需 1–2 分鐘）…", "");
    var start = dispatch ? state.gh.dispatchPrices() : Promise.resolve();
    start.then(function () {
      (function poll() {
        tries++;
        state.gh.readJson("prices.json").then(function (r) {
          if (r.sha && r.sha !== startSha) {
            state.prices = r.data || {};
            state.pricesSha = r.sha;
            finish("報價已更新 " + nowStr().slice(11));
          } else if (tries >= 24) {
            finish("報價尚未更新，可能 GitHub Actions 仍在排隊，稍後按「重新整理」即可", true);
          } else {
            setTimeout(poll, 15000);
          }
        }).catch(function () {
          if (tries >= 24) finish("讀取報價失敗", true); else setTimeout(poll, 15000);
        });
      })();
    }).catch(function (e) {
      finish("無法觸發報價更新：" + errMsg(e), true);
    });
    function finish(msg, isErr) {
      state.polling = false;
      $("#btn-prices").disabled = false;
      render();
      setPriceStatus(msg, isErr ? "up" : "muted");
    }
  }
  function setPriceStatus(text, klass) {
    var el = $("#price-status");
    el.textContent = text;
    el.className = "small " + (klass || "muted");
  }

  // ------------------------------------------------------------------ 畫面
  function mergedPrices() { return Calc.mergePrices(state.prices, state.doc.manual_prices); }

  function render() {
    state.summary = Calc.summarize(state.doc.settings, state.doc.transactions, mergedPrices());
    renderOverview();
    renderTransactions();
    renderPrices();
    renderLoan();
  }

  function renderOverview() {
    var s = state.summary, loan = s.loan, fx = state.prices[Calc.FX_SYMBOL];
    var realizedAll = s.realized + s.income;
    var cards = [
      ["總資產", money(s.total_assets), "初始資金 " + money(s.initial), null],
      ["現金", money(s.cash), s.total_assets ? "佔總資產 " + (s.cash / s.total_assets * 100).toFixed(1) + "%" : "", null],
      ["持倉市值", money(s.market_value), "持有成本 " + money(s.cost) + (fx ? "｜美元匯率 " + fx.price.toFixed(3) : ""), null],
      ["總損益", signed(s.total_pnl), "報酬率 " + pct(s.total_return_pct), s.total_pnl],
      ["已實現損益 (含股息)", signed(realizedAll), "股息/收入 " + money(s.income), realizedAll],
      ["未實現損益", signed(s.unrealized), "持倉報酬率 " + (s.cost ? pct(s.unrealized / s.cost * 100) : "—"), s.unrealized],
      ["信貸已付利息", money(loan.interest_paid),
        "已繳 " + loan.paid_periods + "/" + loan.schedule.length + " 期，月付 " + money(loan.monthly_payment), null],
      ["扣除利息後淨損益", signed(s.net_pnl), "淨報酬率 " + pct(s.net_return_pct), s.net_pnl]
    ];
    $("#cards").innerHTML = cards.map(function (c) {
      return '<div class="card"><div class="card-title">' + c[0] + '</div><div class="card-value ' +
        (c[3] == null ? "" : cls(c[3])) + '">' + c[1] + '</div><div class="card-sub">' + esc(c[2]) + "</div></div>";
    }).join("");

    var showClosed = $("#show-closed").checked;
    $("#hold-table tbody").innerHTML = s.rows.filter(function (r) { return r.quantity > 0 || showClosed; }).map(function (r) {
      var closed = r.quantity === 0, real = r.realized + r.dividends;
      var price = priceStr(r.price);
      if (r.price != null && r.currency !== "TWD") price = (r.currency === "USD" ? "US$" : r.currency + " ") + price;
      return '<tr class="' + (closed ? "closed" : cls(r.unrealized)) + '">' +
        "<td>" + Calc.MARKET_LABELS[r.market] + "</td><td>" + esc(r.symbol) + "</td><td>" + esc(r.name) + "</td>" +
        '<td class="num">' + qtyStr(r.quantity) + '</td><td class="num">' + (closed ? "—" : priceStr(Math.round(r.avg_cost * 100) / 100)) +
        '</td><td class="num">' + money(r.cost) + '</td><td class="num">' + price + '</td><td class="num">' + money(r.market_value) +
        '</td><td class="num">' + signed(r.unrealized) + '</td><td class="num">' + pct(r.return_pct) +
        '</td><td class="num">' + (real ? signed(real) : "0") + "</td><td>" + esc(r.price_time) + "</td></tr>";
    }).join("") || '<tr><td colspan="12" class="muted">尚無持倉，到「交易紀錄」新增第一筆交易。</td></tr>';

    if (s.missing_prices.length && !state.polling) {
      setPriceStatus("缺少報價：" + s.missing_prices.join("、") + "（總資產暫不含這些標的市值）", "up");
    }
  }

  function renderTransactions() {
    var txs = Calc.sortTransactions(state.doc.transactions);
    var cash = Number(state.doc.settings.initial_capital), rows = [];
    txs.forEach(function (tx, i) {
      cash += tx.type === "BUY" ? -tx.amount_twd : tx.amount_twd;
      rows.push({ tx: tx, n: i + 1, cash: cash });
    });
    rows.reverse();   // 最新的在最上面
    $("#tx-table tbody").innerHTML = rows.map(function (r) {
      var tx = r.tx, buy = tx.type === "BUY";
      return '<tr data-id="' + esc(tx.id) + '" class="' + (buy ? "down" : "up") + (tx.id === state.editingId ? " selected" : "") + '">' +
        "<td>" + r.n + "</td><td>" + tx.date + "</td><td>" + Calc.TYPE_LABELS[tx.type] + "</td><td>" + Calc.MARKET_LABELS[tx.market] +
        "</td><td>" + esc(tx.symbol) + "</td><td>" + esc(tx.name) + '</td><td class="num">' + (tx.quantity ? qtyStr(tx.quantity) : "") +
        '</td><td class="num">' + (tx.unit_price ? priceStr(tx.unit_price) : "") + '</td><td class="num">' + (buy ? "-" : "+") +
        money(tx.amount_twd) + '</td><td class="num">' + money(r.cash) + "</td><td>" + esc(tx.note) +
        '</td><td><button type="button" class="link" data-del="' + esc(tx.id) + '">刪除</button></td></tr>';
    }).join("") || '<tr><td colspan="12" class="muted">尚無交易</td></tr>';
  }

  function renderPrices() {
    var prices = mergedPrices(), links = state.doc.fund_links;
    var active = state.summary.rows.filter(function (r) { return r.quantity > 0; });
    $("#price-table tbody").innerHTML = active.map(function (r) {
      var p = prices[r.symbol] || {}, link = links[r.symbol], linkCell = "";
      if (r.market === "FUND") {
        linkCell = link
          ? esc(link.fund_name) + '（' + esc(link.fund_id) + '）<button type="button" class="link" data-unlink="' + esc(r.symbol) + '">取消連結</button>'
          : '<span class="muted">未連結</span> <button type="button" class="link" data-link="' + esc(r.symbol) + '">連結基金</button>';
      }
      var cur = p.currency || (r.market === "US" ? "USD" : "TWD");
      return "<tr><td>" + Calc.MARKET_LABELS[r.market] + "</td><td>" + esc(r.symbol) + "</td><td>" + esc(r.name) +
        '</td><td class="num">' + qtyStr(r.quantity) + '</td><td class="num">' + priceStr(p.price) + "</td><td>" + cur +
        "</td><td>" + ({ auto: "自動", manual: "手動" }[p.source] || "—") + "</td><td>" + esc(p.updated_at || "") +
        "</td><td>" + linkCell + '</td><td><span class="inline"><input inputmode="decimal" data-price-input="' + esc(r.symbol) +
        '" data-currency="' + cur + '"><button type="button" data-price-save="' + esc(r.symbol) + '">儲存</button></span></td></tr>';
    }).join("") || '<tr><td colspan="10" class="muted">尚無持倉</td></tr>';
  }

  function renderLoan() {
    var f = $("#loan-form"), st = state.doc.settings;
    ["initial_capital", "loan_principal", "loan_rate", "loan_months", "loan_start"].forEach(function (k) {
      if (document.activeElement !== f.elements[k]) f.elements[k].value = st[k];
    });
    var loan = state.summary.loan;
    $("#loan-info").textContent = "月付金 " + money(loan.monthly_payment) + "｜已繳 " + loan.paid_periods + "/" + loan.schedule.length +
      " 期｜已付利息 " + money(loan.interest_paid) + "｜已還本金 " + money(loan.principal_paid) + "｜剩餘本金 " +
      money(loan.remaining_principal) + "｜全期總利息 " + money(loan.total_interest);
    $("#loan-table tbody").innerHTML = loan.schedule.map(function (r) {
      var paid = r[0] <= loan.paid_periods;
      return '<tr class="' + (paid ? "paid" : "") + '"><td>' + r[0] + "</td><td>" + Calc.addMonths(loan.start, r[0]) +
        '</td><td class="num">' + money(r[1]) + '</td><td class="num">' + money(r[2]) + '</td><td class="num">' + money(r[3]) +
        '</td><td class="num">' + money(r[4]) + "</td><td>" + (paid ? "已繳" : "") + "</td></tr>";
    }).join("");
  }

  // ------------------------------------------------------------------ 交易表單
  var txForm = function () { return $("#tx-form"); };

  function updateHints() {
    var f = txForm(), t = f.elements.type.value, m = f.elements.market.value;
    $("#amount-label").textContent = { BUY: "花費台幣", SELL: "拿回台幣" }[t] || "收到台幣";
    $("#btn-fund-search").hidden = m !== "FUND";
    var hint = {
      BUY: "花費台幣 = 實際從帳戶扣掉的總額（含手續費）。",
      SELL: "拿回台幣 = 實際入帳的總額（已扣手續費、交易稅）。",
      DIVIDEND: "股息：填實際入帳的台幣金額，代號填配息的標的，數量可留空。",
      INCOME: "其他收入：例如利息、退款，代號可留空。"
    }[t];
    if (t === "BUY" || t === "SELL") {
      if (m === "TW") hint += " 台股代號填數字即可（如 2330、00878），數量以「股」計，一張 = 1000 股。";
      else if (m === "US") hint += " 美股代號如 AAPL、VOO；台幣金額請填實際換匯扣款金額，成交單價填美元。";
      else hint += " 按「搜尋基金」選擇基金即可自動追蹤每日淨值；數量填單位數，台幣金額填實際扣款金額。";
    }
    $("#tx-hint").textContent = hint;
  }

  function clearForm() {
    var f = txForm();
    state.editingId = null;
    state.pendingLink = null;
    ["symbol", "name", "quantity", "amount_twd", "unit_price", "note"].forEach(function (k) { f.elements[k].value = ""; });
    f.elements.date.value = Calc.todayStr();
    $("#btn-save-tx").textContent = "新增";
    $("#tx-form-title").textContent = "新增交易";
    $$("#tx-table tr.selected").forEach(function (tr) { tr.classList.remove("selected"); });
    updateHints();
  }

  function loadIntoForm(id) {
    var tx = state.doc.transactions.filter(function (t) { return t.id === id; })[0];
    if (!tx) return;
    var f = txForm();
    state.editingId = id;
    state.pendingLink = null;
    f.elements.date.value = tx.date;
    f.elements.type.value = tx.type;
    f.elements.market.value = tx.market;
    f.elements.symbol.value = tx.symbol;
    f.elements.name.value = tx.name;
    f.elements.quantity.value = tx.quantity ? Number(tx.quantity.toFixed(4)) : "";
    f.elements.amount_twd.value = tx.amount_twd;
    f.elements.unit_price.value = tx.unit_price || "";
    f.elements.note.value = tx.note;
    $("#btn-save-tx").textContent = "更新這筆";
    $("#tx-form-title").textContent = "修改交易（" + tx.date + " " + tx.symbol + "）";
    $$("#tx-table tr").forEach(function (tr) { tr.classList.toggle("selected", tr.dataset.id === id); });
    updateHints();
    txForm().scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function readForm() {
    var f = txForm(), t = f.elements.type.value, m = f.elements.market.value, d = f.elements.date.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error("請填寫日期");
    var sym = f.elements.symbol.value.trim().toUpperCase();
    if (m === "TW") sym = sym.replace(".TWO", "").replace(".TW", "");
    if ((t === "BUY" || t === "SELL" || t === "DIVIDEND") && !sym) throw new Error("請填寫代號");
    function num(name, label, required) {
      var s = f.elements[name].value.trim().replace(/,/g, "");
      if (!s) { if (required) throw new Error("請填寫" + label); return null; }
      var v = Number(s);
      if (!isFinite(v)) throw new Error(label + "必須是數字");
      if (v <= 0) throw new Error(label + "必須大於 0");
      return v;
    }
    return {
      date: d, type: t, market: m, symbol: sym, name: f.elements.name.value.trim(),
      quantity: num("quantity", "數量", t === "BUY" || t === "SELL") || 0,
      amount_twd: num("amount_twd", $("#amount-label").textContent, true),
      unit_price: num("unit_price", "成交單價", false),
      note: f.elements.note.value.trim()
    };
  }

  function saveTx(e) {
    e.preventDefault();
    var tx;
    try { tx = readForm(); } catch (err) { toast(err.message, true); return; }

    // 檢查賣出數量與現金是否足夠（以不含本筆、當日以前的交易計算）
    var before = Calc.sortTransactions(state.doc.transactions.filter(function (x) {
      return x.id !== state.editingId && x.date <= tx.date;
    }));
    var c = Calc.computeHoldings(before);
    if (tx.type === "SELL") {
      var h = c.holdings[tx.market + "|" + tx.symbol], held = h ? h.quantity : 0;
      if (tx.quantity > held + 1e-9 && !confirm(tx.date + " 時 " + tx.symbol + " 只持有 " + qtyStr(held) +
          "，卻要賣出 " + qtyStr(tx.quantity) + "。\n仍要儲存嗎？")) return;
    }
    if (tx.type === "BUY") {
      var cash = Number(state.doc.settings.initial_capital) + c.cash_flow;
      if (tx.amount_twd > cash + 0.5 && !confirm("買進金額 " + money(tx.amount_twd) + " 超過當時現金 " + money(cash) +
          "。\n仍要儲存嗎？")) return;
    }

    var ops = [], link = state.pendingLink, needPrices = false;
    if (link && tx.market === "FUND" && tx.symbol === link.symbol) {
      ops.push({ op: "link_fund", symbol: tx.symbol, fund_id: link.id, fund_name: link.name });
      needPrices = true;
    }
    if ((tx.market === "TW" || tx.market === "US") && !state.prices[tx.symbol]) needPrices = true;
    var label = Calc.TYPE_LABELS[tx.type] + " " + tx.symbol;
    if (state.editingId) {
      ops.push({ op: "update_tx", id: state.editingId, tx: tx });
    } else {
      tx.id = uuid();
      ops.push({ op: "add_tx", tx: tx });
    }
    commit(ops, (state.editingId ? "修改交易：" : "新增交易：") + label).then(function () {
      clearForm();
      toast("已儲存");
      // data.json 變動會自動觸發報價 workflow；新標的就等它抓完
      if (needPrices && tx.type === "BUY") requestPriceUpdate(false);
    }, function () {});
  }

  function deleteTx(id) {
    var tx = state.doc.transactions.filter(function (t) { return t.id === id; })[0];
    if (!tx || !confirm("確定要刪除 " + tx.date + " " + Calc.TYPE_LABELS[tx.type] + " " + tx.symbol + " 這筆交易嗎？")) return;
    commit([{ op: "delete_tx", id: id }], "刪除交易：" + tx.date + " " + tx.symbol).then(function () {
      if (state.editingId === id) clearForm();
      toast("已刪除");
    }, function () {});
  }

  // ------------------------------------------------------------------ 基金搜尋
  var fundPick = null;
  function openFundSearch(keyword, onPick) {
    fundPick = onPick;
    $("#fund-q").value = keyword || "";
    $("#fund-results").innerHTML = "";
    $("#fund-info").textContent = "";
    $("#fund-dialog").showModal();
    if (keyword) searchFunds();
  }

  function searchFunds() {
    var q = $("#fund-q").value.trim();
    if (!q) return;
    $("#fund-info").textContent = "搜尋中…";
    $("#fund-results").innerHTML = "";
    var url = CNYES_SEARCH + "?" + new URLSearchParams({ q: q, limit: 30, category: "FUND" });
    fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      var seen = {}, list = [];
      ((j.data && j.data.quoteFunds) || []).forEach(function (f) {
        if (!f.cnyesId || seen[f.cnyesId]) return;
        seen[f.cnyesId] = true;
        var strip = function (s) { return (s || "").replace(/<[^>]+>/g, ""); };
        list.push({ id: f.cnyesId, name: strip(f.displayNameLocal) || strip(f.displayName), isin: strip(f.isin) });
      });
      $("#fund-info").textContent = list.length ? "找到 " + list.length + " 筆，點選要連結的級別"
        : "找不到，請換個關鍵字（例如基金公司＋主題），或輸入 ISIN";
      $("#fund-results").innerHTML = list.map(function (f, i) {
        return '<li data-i="' + i + '"><span>' + esc(f.name) + '</span><span class="isin">' + esc(f.isin) + "</span></li>";
      }).join("");
      $("#fund-results").onclick = function (ev) {
        var li = ev.target.closest("li");
        if (!li) return;
        $("#fund-dialog").close();
        if (fundPick) fundPick(list[Number(li.dataset.i)]);
      };
    }).catch(function (e) {
      $("#fund-info").textContent = "搜尋失敗：" + e.message;
    });
  }

  function pickFundForForm() {
    var f = txForm();
    openFundSearch(f.elements.name.value.trim() || f.elements.symbol.value.trim(), function (fund) {
      var symbol = (fund.isin || fund.id).toUpperCase();
      // 若已有持倉連結到同一檔基金，沿用原本的代號，避免同一檔基金分成兩筆持倉
      Object.keys(state.doc.fund_links).forEach(function (s) {
        if (state.doc.fund_links[s].fund_id === fund.id) symbol = s;
      });
      f.elements.symbol.value = symbol;
      f.elements.name.value = fund.name;
      state.pendingLink = { symbol: symbol, id: fund.id, name: fund.name };
    });
  }

  // ------------------------------------------------------------------ 事件
  function bind() {
    $("#setup-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var f = e.target, cfg = {
        owner: f.elements.owner.value.trim(), repo: f.elements.repo.value.trim(), token: f.elements.token.value.trim()
      };
      $("#setup-error").textContent = "連線中…";
      connect(cfg).then(function () {
        GitHubStore.saveConfig(cfg);
        f.elements.token.value = "";
      }, function (err) { $("#setup-error").textContent = errMsg(err); });
    });

    $$(".tabs button").forEach(function (b) {
      b.addEventListener("click", function () {
        $$(".tabs button").forEach(function (x) { x.classList.toggle("active", x === b); });
        $$(".tab").forEach(function (t) { t.classList.toggle("active", t.id === "tab-" + b.dataset.tab); });
      });
    });

    $("#btn-prices").addEventListener("click", function () { requestPriceUpdate(true); });
    $("#btn-reload").addEventListener("click", function () {
      loadAll().then(function () { toast("已重新整理"); }, function (e) { toast(errMsg(e), true); });
    });
    $("#btn-logout").addEventListener("click", function () {
      if (!confirm("登出會清除這台裝置上儲存的權杖，確定嗎？")) return;
      GitHubStore.clearConfig();
      location.reload();
    });
    $("#show-closed").addEventListener("change", renderOverview);

    var f = txForm();
    f.elements.type.innerHTML = Object.keys(Calc.TYPE_LABELS).map(function (k) {
      return '<option value="' + k + '">' + Calc.TYPE_LABELS[k] + "</option>";
    }).join("");
    f.elements.market.innerHTML = Object.keys(Calc.MARKET_LABELS).map(function (k) {
      return '<option value="' + k + '">' + Calc.MARKET_LABELS[k] + "</option>";
    }).join("");
    f.elements.type.addEventListener("change", updateHints);
    f.elements.market.addEventListener("change", updateHints);
    f.elements.symbol.addEventListener("blur", function () {
      var sym = f.elements.symbol.value.trim().toUpperCase();
      if (!sym || f.elements.name.value.trim() || !state.summary) return;
      state.summary.rows.forEach(function (r) {
        if (r.symbol === sym && r.market === f.elements.market.value && r.name) f.elements.name.value = r.name;
      });
    });
    f.addEventListener("submit", saveTx);
    $("#btn-clear-tx").addEventListener("click", clearForm);
    $("#btn-fund-search").addEventListener("click", pickFundForForm);

    $("#tx-table").addEventListener("click", function (e) {
      var del = e.target.closest("[data-del]");
      if (del) { deleteTx(del.dataset.del); return; }
      var tr = e.target.closest("tr[data-id]");
      if (tr) loadIntoForm(tr.dataset.id);
    });

    $("#price-table").addEventListener("click", function (e) {
      var t = e.target;
      if (t.dataset.priceSave) {
        var sym = t.dataset.priceSave;
        var input = $$("[data-price-input]").filter(function (i) { return i.dataset.priceInput === sym; })[0];
        var v = Number(input.value.replace(/,/g, ""));
        if (!(v > 0)) { toast("價格必須是大於 0 的數字", true); return; }
        commit([{ op: "set_manual_price", symbol: sym, price: v, currency: input.dataset.currency, updated_at: nowStr() }],
          "手動價格：" + sym).then(function () { toast("已儲存價格"); }, function () {});
      } else if (t.dataset.link) {
        var s = t.dataset.link;
        var row = state.summary.rows.filter(function (r) { return r.symbol === s; })[0];
        openFundSearch((row && row.name) || s, function (fund) {
          commit([{ op: "link_fund", symbol: s, fund_id: fund.id, fund_name: fund.name }], "連結基金：" + s)
            .then(function () { toast("已連結，正在抓取淨值…"); requestPriceUpdate(false); }, function () {});
        });
      } else if (t.dataset.unlink) {
        var u = t.dataset.unlink;
        if (!confirm("取消 " + u + " 的自動淨值追蹤？之後需手動輸入淨值。")) return;
        commit([{ op: "unlink_fund", symbol: u }], "取消連結基金：" + u).then(function () { toast("已取消連結"); }, function () {});
      }
    });

    $("#loan-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var lf = e.target, vals = {};
      ["initial_capital", "loan_principal", "loan_rate", "loan_months", "loan_start"].forEach(function (k) {
        vals[k] = lf.elements[k].value.trim().replace(/,/g, "");
      });
      if (!(Number(vals.initial_capital) > 0) || !(Number(vals.loan_principal) > 0)) { toast("金額必須大於 0", true); return; }
      if (!(Number(vals.loan_rate) >= 0)) { toast("利率不可為負數", true); return; }
      if (!/^\d+$/.test(vals.loan_months) || Number(vals.loan_months) <= 0) { toast("期數必須是正整數", true); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(vals.loan_start)) { toast("請填寫撥款日", true); return; }
      commit([{ op: "save_settings", values: vals }], "修改信貸設定").then(function () { toast("已儲存設定"); }, function () {});
    });

    $("#btn-fund-q").addEventListener("click", searchFunds);
    $("#fund-q").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); searchFunds(); }
    });

    // 回到頁面或定時重新讀取，看到其他裝置（桌面版）的變更
    setInterval(function () {
      if (state.gh && !document.hidden && !state.polling) loadAll().catch(function () {});
    }, AUTO_RELOAD_MS);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && state.gh && !state.polling) loadAll().catch(function () {});
    });
  }

  bind();
  clearForm();
  var cfg = GitHubStore.loadConfig();
  if (cfg) {
    connect(cfg).catch(function (e) { showSetup(errMsg(e)); });
  } else {
    showSetup();
  }
})();
