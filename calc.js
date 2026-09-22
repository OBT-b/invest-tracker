/* 純計算邏輯：與桌面版 portfolio.py 逐行對應，兩邊數字必須一致。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Calc = factory();
})(this, function () {
  "use strict";

  var TYPE_LABELS = { BUY: "買進", SELL: "賣出", DIVIDEND: "股息", INCOME: "其他收入" };
  var MARKET_LABELS = { TW: "台股", US: "美股", FUND: "基金" };

  function fxSymbol(currency) { return currency + "TWD"; }
  var FX_SYMBOL = fxSymbol("USD");

  /** 依日期排序（同日保持原本加入順序）。 */
  function sortTransactions(txs) {
    return txs.map(function (t, i) { return { t: t, i: i }; })
      .sort(function (a, b) {
        if (a.t.date !== b.t.date) return a.t.date < b.t.date ? -1 : 1;
        return a.i - b.i;
      })
      .map(function (x) { return x.t; });
  }

  function holdingFor(holdings, tx) {
    var key = tx.market + "|" + tx.symbol;
    if (!holdings[key]) {
      holdings[key] = { market: tx.market, symbol: tx.symbol, name: tx.name || "",
        quantity: 0, cost: 0, realized: 0, dividends: 0 };
    }
    if (tx.name) holdings[key].name = tx.name;
    return holdings[key];
  }

  /** 平均成本法計算持倉與已實現損益（transactions 需已依日期排序）。 */
  function computeHoldings(transactions) {
    var holdings = {}, cashFlow = 0, realizedTotal = 0, incomeTotal = 0;
    transactions.forEach(function (tx) {
      var amt = Number(tx.amount_twd), t = tx.type, h;
      if (t === "DIVIDEND" || t === "INCOME") {
        cashFlow += amt;
        incomeTotal += amt;
        if (tx.symbol && t === "DIVIDEND") holdingFor(holdings, tx).dividends += amt;
        return;
      }
      h = holdingFor(holdings, tx);
      var qty = Number(tx.quantity);
      if (t === "BUY") {
        cashFlow -= amt;
        h.quantity += qty;
        h.cost += amt;
      } else if (t === "SELL") {
        cashFlow += amt;
        var pnl;
        if (h.quantity > 0) {
          var sellQty = Math.min(qty, h.quantity);
          var costOut = h.cost / h.quantity * sellQty;
          pnl = amt - costOut;
          h.quantity -= sellQty;
          h.cost -= costOut;
          if (h.quantity < 1e-9) { h.quantity = 0; h.cost = 0; }   // 全部賣光，清掉浮點誤差
        } else {
          pnl = amt;   // 無持倉卻賣出（資料有誤），整筆視為獲利
        }
        h.realized += pnl;
        realizedTotal += pnl;
      }
    });
    return { holdings: holdings, cash_flow: cashFlow, realized: realizedTotal, income: incomeTotal };
  }

  function valueHoldings(holdings, prices) {
    var rows = Object.keys(holdings).map(function (k) {
      var h = holdings[k], row = {};
      Object.keys(h).forEach(function (f) { row[f] = h[f]; });
      row.avg_cost = h.quantity ? h.cost / h.quantity : 0;
      var p = prices[h.symbol];
      row.price = p ? p.price : null;
      row.currency = p ? p.currency : (h.market === "US" ? "USD" : "TWD");
      row.price_time = p ? p.updated_at : "";
      var mv = null;
      if (p) {
        if (row.currency !== "TWD") {
          var fx = prices[fxSymbol(row.currency)];
          mv = fx ? p.price * h.quantity * fx.price : null;
        } else {
          mv = p.price * h.quantity;
        }
      }
      if (h.quantity === 0) mv = 0;
      row.market_value = mv;
      row.unrealized = mv !== null ? mv - h.cost : null;
      row.return_pct = (mv !== null && h.cost) ? row.unrealized / h.cost * 100 : null;
      return row;
    });
    rows.sort(function (a, b) {
      var ka = [a.quantity === 0 ? 1 : 0, a.market, a.symbol], kb = [b.quantity === 0 ? 1 : 0, b.market, b.symbol];
      for (var i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
      return 0;
    });
    return rows;
  }

  /** 本息平均攤還表：[[期數, 月付金, 利息, 本金, 剩餘本金]] */
  function loanSchedule(principal, annualRatePct, months) {
    principal = Number(principal);
    months = parseInt(months, 10);
    var r = Number(annualRatePct) / 100 / 12;
    if (!(months > 0)) return [];
    var payment = r === 0 ? principal / months : principal * r / (1 - Math.pow(1 + r, -months));
    var balance = principal, rows = [];
    for (var k = 1; k <= months; k++) {
      var interest = balance * r, princ = payment - interest, paymentK = payment;
      if (k === months) { princ = balance; paymentK = princ + interest; }   // 最後一期把尾差攤掉
      balance -= princ;
      rows.push([k, paymentK, interest, princ, Math.max(balance, 0)]);
    }
    return rows;
  }

  function parseDate(s) {
    var p = s.split("-").map(Number);
    return { y: p[0], m: p[1], d: p[2] };
  }

  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  /** 日期字串加 n 個月，月底自動調整（1/31 + 1 個月 → 2/28 或 2/29）。 */
  function addMonths(dateStr, n) {
    var d = parseDate(dateStr);
    var total = d.m - 1 + n, y = d.y + Math.floor(total / 12), m = total % 12 + 1;
    var day = Math.min(d.d, daysInMonth(y, m));
    return y + "-" + pad(m) + "-" + pad(day);
  }

  function todayStr() {
    var t = new Date();
    return t.getFullYear() + "-" + pad(t.getMonth() + 1) + "-" + pad(t.getDate());
  }

  function loanStatus(settings, today) {
    today = today || todayStr();
    var sched = loanSchedule(settings.loan_principal, settings.loan_rate, settings.loan_months);
    var paid = 0;
    for (var k = 1; k <= sched.length; k++) if (addMonths(settings.loan_start, k) <= today) paid++;
    var paidRows = sched.slice(0, paid);
    var sum = function (rows, i) { return rows.reduce(function (a, r) { return a + r[i]; }, 0); };
    return {
      schedule: sched,
      start: settings.loan_start,
      monthly_payment: sched.length ? sched[0][1] : 0,
      paid_periods: paid,
      interest_paid: sum(paidRows, 2),
      principal_paid: sum(paidRows, 3),
      remaining_principal: paidRows.length ? paidRows[paidRows.length - 1][4] : Number(settings.loan_principal),
      total_interest: sum(sched, 2)
    };
  }

  function summarize(settings, transactions, prices, today) {
    var c = computeHoldings(sortTransactions(transactions));
    var rows = valueHoldings(c.holdings, prices);
    var initial = Number(settings.initial_capital);
    var cash = initial + c.cash_flow;
    var active = rows.filter(function (r) { return r.quantity > 0; });
    var missing = active.filter(function (r) { return r.market_value === null; }).map(function (r) { return r.symbol; });
    var marketValue = active.reduce(function (a, r) { return a + (r.market_value !== null ? r.market_value : 0); }, 0);
    var cost = active.reduce(function (a, r) { return a + r.cost; }, 0);
    var unrealized = active.reduce(function (a, r) { return a + (r.unrealized !== null ? r.unrealized : 0); }, 0);
    var totalAssets = cash + marketValue, totalPnl = totalAssets - initial;
    var loan = loanStatus(settings, today);
    var netPnl = totalPnl - loan.interest_paid;
    return {
      rows: rows, missing_prices: missing, initial: initial, cash: cash, market_value: marketValue,
      cost: cost, realized: c.realized, income: c.income, unrealized: unrealized,
      total_assets: totalAssets, total_pnl: totalPnl,
      total_return_pct: initial ? totalPnl / initial * 100 : 0,
      loan: loan, net_pnl: netPnl, net_return_pct: initial ? netPnl / initial * 100 : 0
    };
  }

  /** 自動報價（prices.json）與手動價格合併：手動價格比最近一次自動抓價新才採用。 */
  function mergePrices(autoPrices, manualPrices) {
    var out = {};
    Object.keys(autoPrices || {}).forEach(function (s) { out[s] = autoPrices[s]; });
    Object.keys(manualPrices || {}).forEach(function (s) {
      var m = manualPrices[s], a = out[s];
      if (!a || m.updated_at > (a.fetched_at || a.updated_at || "")) {
        out[s] = { price: m.price, currency: m.currency, updated_at: m.updated_at, source: "manual",
          ticker: a ? a.ticker : "" };
      }
    });
    return out;
  }

  /** 對 data.json 套用一個操作；可重複套用（冪等），供衝突重試使用。 */
  function applyOp(doc, op) {
    var txs = doc.transactions, i;
    var idx = function (id) { for (var j = 0; j < txs.length; j++) if (txs[j].id === id) return j; return -1; };
    switch (op.op) {
      case "add_tx":
        if (idx(op.tx.id) < 0) txs.push(op.tx);
        break;
      case "update_tx":
        i = idx(op.id);
        if (i >= 0) { var t = {}; Object.keys(op.tx).forEach(function (k) { t[k] = op.tx[k]; }); t.id = op.id; txs[i] = t; }
        break;
      case "delete_tx":
        i = idx(op.id);
        if (i >= 0) txs.splice(i, 1);
        break;
      case "save_settings":
        Object.keys(op.values).forEach(function (k) { doc.settings[k] = String(op.values[k]); });
        break;
      case "set_manual_price":
        doc.manual_prices[op.symbol] = { price: op.price, currency: op.currency, updated_at: op.updated_at };
        break;
      case "link_fund":
        doc.fund_links[op.symbol] = { fund_id: op.fund_id, fund_name: op.fund_name };
        break;
      case "unlink_fund":
        delete doc.fund_links[op.symbol];
        break;
      default:
        throw new Error("未知的操作：" + op.op);
    }
    return doc;
  }

  return {
    TYPE_LABELS: TYPE_LABELS, MARKET_LABELS: MARKET_LABELS, FX_SYMBOL: FX_SYMBOL, fxSymbol: fxSymbol,
    sortTransactions: sortTransactions, computeHoldings: computeHoldings, valueHoldings: valueHoldings,
    loanSchedule: loanSchedule, addMonths: addMonths, loanStatus: loanStatus, summarize: summarize,
    mergePrices: mergePrices, applyOp: applyOp, todayStr: todayStr
  };
});
