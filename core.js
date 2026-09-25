/* CET6 打卡应用 · 核心逻辑（纯函数，可在 Node 中测试）
   数据结构：
   state = {
     version: 1,
     history: { 'YYYY-MM-DD': { minutes: 0, done: false, floor: false, qCount: 0, right: 0 } },
     papers: { qid: { seen: n, wrong: n, right: n, lastAt: 'date', lastResult: 'right'|'wrong' } },
     wrongbook: { qid: { addedAt, box: n, due: 'YYYY-MM-DD', wrongCount: n } },
     plan: { date: 'YYYY-MM-DD', items: [ {key, type, qids, done, minutes} ] },
     essays: { 'writing': {lastAt, text}, 'translation': {...} }  // 最近一次作文/翻译草稿
   } */
(function (root) {
  'use strict';

  var CORE = {};

  // ---------- 日期 ----------
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  CORE.todayStr = function (d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };
  CORE.addDays = function (dateStr, n) {
    var p = dateStr.split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2] + n);
    return CORE.todayStr(d);
  };
  CORE.dayDiff = function (a, b) { // b - a 天数
    var pa = a.split('-').map(Number), pb = b.split('-').map(Number);
    var da = new Date(pa[0], pa[1] - 1, pa[2]), db = new Date(pb[0], pb[1] - 1, pb[2]);
    return Math.round((db - da) / 86400000);
  };

  // ---------- 题型 ----------
  CORE.TYPE_META = {
    listening: { zh: '听力', minPerQ: 1.4, group: '听力·每日一组' },
    cloze:     { zh: '选词填空', minPerQ: 0.6, group: '选词填空·整篇文章' },
    match:     { zh: '信息匹配', minPerQ: 1.3, group: '信息匹配·每日三条' },
    reading:   { zh: '仔细阅读', minPerQ: 1.6, group: '仔细阅读·每日一篇' },
    writing:   { zh: '写作', minPerQ: 15, group: '写作·隔日一练' },
    translation: { zh: '翻译', minPerQ: 12, group: '翻译·隔日一练' }
  };
  CORE.INTERVALS = [1, 2, 4, 7, 15];

  // ---------- 题库索引 ----------
  CORE.allQuestions = function (banks) {
    var out = [];
    banks.forEach(function (b) {
      (b.questions || []).forEach(function (q) {
        out.push({ q: q, paper: b });
      });
    });
    return out;
  };
  CORE.findQ = function (banks, qid) {
    for (var i = 0; i < banks.length; i++) {
      for (var j = 0; j < banks[i].questions.length; j++) {
        if (banks[i].questions[j].id === qid) return banks[i].questions[j];
      }
    }
    return null;
  };
  CORE.findPaper = function (banks, qid) {
    for (var i = 0; i < banks.length; i++) {
      for (var j = 0; j < banks[i].questions.length; j++) {
        if (banks[i].questions[j].id === qid) return banks[i];
      }
    }
    return null;
  };

  // ---------- 遗忘曲线（自适应 SM-2：间隔随答题表现动态伸缩）----------
  CORE.nextDue = function (box, dateStr) {
    var iv = CORE.INTERVALS[Math.min(box, CORE.INTERVALS.length - 1)];
    return CORE.addDays(dateStr, iv);
  };
  // 自适应间隔：ease 反映该题掌握稳固度（1.3~2.8），间隔 = 上次间隔 × ease
  CORE.nextIv = function (wb) {
    if (wb.iv <= 1) return 2;
    return Math.min(60, Math.max(1, Math.round(wb.iv * wb.ease)));
  };
  // 记录一题结果：更新 papers / wrongbook
  CORE.recordResult = function (state, qid, correct, dateStr) {
    var st = state.papers[qid] || (state.papers[qid] = { seen: 0, wrong: 0, right: 0 });
    st.seen++; st.lastAt = dateStr; st.lastResult = correct ? 'right' : 'wrong';
    if (correct) { st.right++; } else { st.wrong++; }
    if (correct) {
      var wb = state.wrongbook[qid];
      if (wb) {
        wb.ease = Math.min(2.8, (wb.ease || 2.5) + 0.1);
        wb.streak = (wb.streak || 0) + 1;
        wb.iv = CORE.nextIv(wb);
        wb.box = Math.min(wb.box + 1, CORE.INTERVALS.length - 1);
        wb.due = CORE.addDays(dateStr, wb.iv);
        if (wb.streak >= 5) { delete state.wrongbook[qid]; } // 连续答对 5 次毕业出库
      }
    } else {
      var wb2 = state.wrongbook[qid] || (state.wrongbook[qid] = { addedAt: dateStr, box: 0, wrongCount: 0 });
      wb2.ease = Math.max(1.3, (wb2.ease || 2.5) - 0.2);
      wb2.streak = 0;
      wb2.box = 0;
      wb2.iv = 1;
      wb2.wrongCount++;
      wb2.due = CORE.addDays(dateStr, 1);
    }
    return state;
  };
  // 今日到期错题（可重练）
  CORE.dueWrongIds = function (state, dateStr) {
    var out = [];
    Object.keys(state.wrongbook).forEach(function (qid) {
      if (CORE.dayDiff(state.wrongbook[qid].due, dateStr) >= 0) out.push(qid);
    });
    return out;
  };
  CORE.allWrongIds = function (state) { return Object.keys(state.wrongbook); };
  // 智能复习队列：到期错题按（逾期天数 > 错次 > ease 低）排序，越薄弱越靠前
  CORE.reviewQueue = function (state, banks, dateStr, limit) {
    var qids = [];
    Object.keys(state.wrongbook).forEach(function (qid) { qids.push(qid); });
    qids.sort(function (a, b) {
      var wa = state.wrongbook[a], wbb = state.wrongbook[b];
      var oa = CORE.dayDiff(wa.due, dateStr), ob = CORE.dayDiff(wbb.due, dateStr); // 逾期天数（正=已逾期）
      if (oa !== ob) return ob - oa;
      if (wa.wrongCount !== wbb.wrongCount) return wbb.wrongCount - wa.wrongCount;
      return (wa.ease || 2.5) - (wbb.ease || 2.5);
    });
    var out = [];
    for (var i = 0; i < qids.length; i++) {
      if (CORE.dayDiff(state.wrongbook[qids[i]].due, dateStr) >= 0) out.push(qids[i]);
      if (limit && out.length >= limit) break;
    }
    return out;
  };
  // 错题本总览统计
  CORE.wrongSummary = function (state, dateStr) {
    var ids = Object.keys(state.wrongbook), due = 0, overdue = 0, maxOver = 0, ivSum = 0;
    ids.forEach(function (qid) {
      var wb = state.wrongbook[qid];
      var od = CORE.dayDiff(wb.due, dateStr); // 逾期天数（正=已逾期）
      if (od >= 0) due++;
      if (od > 0) { overdue++; if (od > maxOver) maxOver = od; }
      ivSum += (wb.iv || 1);
    });
    return { total: ids.length, due: due, overdue: overdue, maxOverdue: maxOver, avgIv: ids.length ? Math.round(ivSum / ids.length) : 0 };
  };

  // ---------- 随机（按日期种子可复现）----------
  CORE.seedRand = function (seed) {
    var s = 0;
    for (var i = 0; i < seed.length; i++) { s = (s * 31 + seed.charCodeAt(i)) % 1000003; }
    return function () { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  };
  CORE.shuffledBy = function (arr, rand) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  };

  // ---------- 今日清单生成 ----------
  /* 规则（默认约 30 分钟）：
     1. 错题到期优先进入（听力/选词/匹配/阅读各自吸纳）
     2. 其余从未见过的新题中按日期种子抽取
     3. 写作与翻译按日期奇偶轮换，每天只出现一个
     4. 加练：在已有清单外再抽一组 */
  CORE.genPlan = function (state, banks, dateStr) {
    var all = CORE.allQuestions(banks);
    var rand = CORE.seedRand(dateStr + '|' + banks.length);
    var items = [];
    var used = {};
    function take(type, n, pool) {
      pool = pool.filter(function (x) { return !used[x.q.id]; });
      var pick = CORE.shuffledBy(pool, rand).slice(0, n);
      pick.forEach(function (x) { used[x.q.id] = 1; });
      return pick.map(function (x) { return x.q.id; });
    }
    function poolOf(type, onlyUnseen) {
      return all.filter(function (x) {
        if (x.q.type !== type) return false;
        if (onlyUnseen && state.papers[x.q.id]) return false;
        return true;
      });
    }
    var due = CORE.dueWrongIds(state, dateStr);
    function duePool(type) {
      return all.filter(function (x) { return x.q.type === type && due.indexOf(x.q.id) >= 0; });
    }
    // 听力 5 题（到期错题优先）
    var lIds = take('listening', 5, duePool('listening').length ? duePool('listening').concat(poolOf('listening', true)) : poolOf('listening', true));
    if (lIds.length) items.push({ key: 'listening', type: 'listening', qids: lIds, done: false, minutes: 0 });
    // 选词填空：半篇 5 空（同一套卷的 26-30 或 31-35）
    var cBase = duePool('cloze')[0] || poolOf('cloze', true)[0] || all.filter(function (x) { return x.q.type === 'cloze'; })[0];
    if (cBase) {
      var paper = CORE.findPaper(banks, cBase.q.id);
      var half = (CORE.dayDiff(dateStr, dateStr) + Number(dateStr.slice(-2))) % 2; // 按日号奇偶取前后半
      var start = 26 + half * 5;
      var cIds = paper.questions.filter(function (q) { return q.type === 'cloze' && q.qno >= start && q.qno < start + 5; }).map(function (q) { return q.id; });
      cIds.forEach(function (id) { used[id] = 1; });
      items.push({ key: 'cloze', type: 'cloze', qids: cIds, paperId: paper.id, done: false, minutes: 0 });
    }
    // 信息匹配 3 条
    var mIds = take('match', 3, duePool('match').length ? duePool('match').concat(poolOf('match', true)) : poolOf('match', true));
    if (mIds.length) items.push({ key: 'match', type: 'match', qids: mIds, done: false, minutes: 0 });
    // 仔细阅读：一整篇（5 题）
    var rBase = duePool('reading')[0] || poolOf('reading', true)[0] || all.filter(function (x) { return x.q.type === 'reading'; })[0];
    if (rBase) {
      var rPaper = CORE.findPaper(banks, rBase.q.id);
      var rIds = rPaper.questions.filter(function (q) { return q.type === 'reading' && Math.abs(q.qno - rBase.q.qno) <= 4; }).map(function (q) { return q.id; });
      rIds.forEach(function (id) { used[id] = 1; });
      items.push({ key: 'reading', type: 'reading', qids: rIds, paperId: rPaper.id, done: false, minutes: 0 });
    }
    // 写作 / 翻译 轮换；题面按日期在全套卷间轮换，避免永远用同一套
    var dayNum = Number(dateStr.slice(-2));
    var wtype = (dayNum % 2 === 0) ? 'writing' : 'translation';
    var wIdx = (Number(dateStr.slice(5, 7)) * 31 + dayNum) % banks.length;
    items.push({ key: wtype, type: wtype, qids: [], paperId: banks[wIdx].id, done: false, minutes: 0 });
    return { date: dateStr, items: items };
  };

  // 加练：再抽一组指定题型
  CORE.extraGroup = function (state, banks, dateStr, type) {
    var all = CORE.allQuestions(banks);
    var rand = CORE.seedRand(dateStr + '|extra|' + type + '|' + Object.keys(state.papers).length);
    var planIds = {};
    (state.plan && state.plan.items || []).forEach(function (it) { (it.qids || []).forEach(function (id) { planIds[id] = 1; }); });
    var pool = all.filter(function (x) { return x.q.type === type && !planIds[x.q.id]; });
    if (type === 'reading' && pool.length) {
      var base = CORE.shuffledBy(pool, rand)[0];
      var paper = CORE.findPaper(banks, base.q.id);
      var ids = paper.questions.filter(function (q) { return q.type === 'reading' && Math.abs(q.qno - base.q.qno) <= 4; }).map(function (q) { return q.id; });
      return { key: 'extra-' + type + '-' + Date.now(), type: type, qids: ids, paperId: paper.id, done: false, minutes: 0, extra: true };
    }
    if (type === 'cloze' && pool.length) {
      var cbase = CORE.shuffledBy(pool, rand)[0];
      var cpaper = CORE.findPaper(banks, cbase.q.id);
      var half = Math.floor(rand() * 2), start = 26 + half * 5;
      var cids = cpaper.questions.filter(function (q) { return q.type === 'cloze' && q.qno >= start && q.qno < start + 5; }).map(function (q) { return q.id; });
      return { key: 'extra-' + type + '-' + Date.now(), type: type, qids: cids, paperId: cpaper.id, done: false, minutes: 0, extra: true };
    }
    var n = type === 'listening' ? 5 : (type === 'match' ? 3 : 5);
    var ids2 = CORE.shuffledBy(pool, rand).slice(0, n).map(function (x) { return x.q.id; });
    return ids2.length ? { key: 'extra-' + type + '-' + Date.now(), type: type, qids: ids2, done: false, minutes: 0, extra: true } : null;
  };

  // ---------- 统计 ----------
  CORE.streak = function (history, todayStr) {
    var s = 0, d = todayStr;
    var th = history[todayStr];
    if (!th || !(th.done || th.floor)) d = CORE.addDays(todayStr, -1); // 今天还没打卡，从昨天数
    while (true) {
      var h = history[d];
      if (h && (h.done || h.floor)) { s++; d = CORE.addDays(d, -1); }
      else break;
    }
    return s;
  };
  CORE.heatmap = function (history, todayStr, days) {
    days = days || 84;
    var out = [];
    for (var i = days - 1; i >= 0; i--) {
      var d = CORE.addDays(todayStr, -i);
      var h = history[d];
      out.push({ date: d, minutes: h ? h.minutes : 0, done: !!(h && (h.done || h.floor)), floor: !!(h && h.floor) });
    }
    return out;
  };
  CORE.accuracyByType = function (state) {
    var by = {};
    Object.keys(state.papers).forEach(function (qid) {
      var st = state.papers[qid];
      var type = qid.split('-')[1] === 'l' ? 'listening' : (qid.split('-')[1] === 'c' ? 'cloze' : (qid.split('-')[1] === 'm' ? 'match' : 'reading'));
      // id 形如 2026-06-1-l-3
      var parts = qid.split('-');
      var t = parts[3] === 'l' ? 'listening' : (parts[3] === 'c' ? 'cloze' : (parts[3] === 'm' ? 'match' : 'reading'));
      by[t] = by[t] || { seen: 0, right: 0 };
      by[t].seen += st.seen; by[t].right += st.right;
    });
    return by;
  };

  // ---------- 存取 ----------
  CORE.STORAGE_KEY = 'cet6_p1_state_v1';
  CORE.loadState = function (storage) {
    try {
      var raw = storage.getItem(CORE.STORAGE_KEY);
      if (!raw) return CORE.newState();
      var s = JSON.parse(raw);
      if (!s.version) return CORE.newState();
      // 迁移：旧版错题条目补自适应字段（按原 box 阶梯推算 iv）
      if (s.wrongbook) {
        Object.keys(s.wrongbook).forEach(function (qid) {
          var wb = s.wrongbook[qid];
          if (wb.ease === undefined) wb.ease = 2.5;
          if (wb.streak === undefined) wb.streak = 0;
          if (wb.iv === undefined) wb.iv = CORE.INTERVALS[Math.min(wb.box || 0, CORE.INTERVALS.length - 1)];
        });
      }
      return s;
    } catch (e) { return CORE.newState(); }
  };
  CORE.newState = function () {
    return { version: 1, history: {}, papers: {}, wrongbook: {}, plan: null, essays: {} };
  };
  CORE.saveState = function (storage, state) {
    storage.setItem(CORE.STORAGE_KEY, JSON.stringify(state));
  };

  // ---------- 判题 ----------
  CORE.judge = function (q, answer) {
    if (q.type === 'match') return answer === q.answer;
    return answer === q.answer;
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = CORE; }
  else { root.CET6Core = CORE; }
})(typeof window !== 'undefined' ? window : globalThis);
