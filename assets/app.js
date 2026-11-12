/* 羅和辞典 · 网页版
   数据在 data/idx.js（索引）与 data/cN.js（正文分片），全部用 <script> 载入，
   因此可以直接双击 index.html 打开，不需要本地服务器。 */
(function () {
  'use strict';

  var IDX = window.__IDX || '';
  var STATS = window.__STATS || { entries: 0, aliases: 0, total: 0 };

  var rows = [];        // ["key","cid","idx","flag","target"]
  var keys = [];        // 原始词头
  var folded = [];      // 归一化词头（去掉长音符、大小写、æ→ae 等）
  var where = [];       // [cid, entryIndex, isAlias, target]
  var keyMap = Object.create(null);   // 词头 → 行号

  var chunks = Object.create(null);   // cid → [html,...]
  var chunkWait = Object.create(null);

  var hits = [];        // 当前结果行号
  var sel = -1;         // 列表选中项
  var current = -1;     // 当前已打开的行号
  var suppressHash = false;

  var $ = function (id) { return document.getElementById(id); };
  var q = $('q'), listEl = $('hits'), infoEl = $('hitinfo'),
      hintEl = $('modehint'), railEl = $('rail'), paneEl = $('pane'),
      entryEl = $('entry'), metaEl = $('entry-meta'), welcomeEl = $('welcome'),
      alphaEl = $('alpha'), backEl = $('back'), holderEl = $('placeholder'),
      railEmptyEl = $('railempty');

  /* ---------------- 归一化 ---------------- */
  function fold(s) {
    if (s.normalize) {
      s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }
    s = s.toLowerCase();
    return s
      .replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ø/g, 'o')
      .replace(/ł/g, 'l').replace(/đ|ð/g, 'd').replace(/þ/g, 'th')
      .replace(/['’`]/g, '');
  }
  function fold2(s) {           // 拉丁语 u/v、i/j 通用的第二套匹配
    return fold(s).replace(/v/g, 'u').replace(/j/g, 'i');
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    var t0 = Date.now();
    var lines = IDX ? IDX.split('\n') : [];
    var i, n = lines.length, p;
    rows = new Array(n);
    for (i = 0; i < n; i++) {
      p = lines[i].split('\t');
      rows[i] = p;
      keys[i] = p[0];
      folded[i] = fold(p[0]);
      where[i] = [p[1], +p[2], p[3] === '1', p[4] || ''];
      if (!(p[0] in keyMap)) keyMap[p[0]] = i;
    }
    buildAlpha();
    buildFrontMatter();
    $('wstat').textContent =
      '收录 ' + STATS.entries.toLocaleString() + ' 条词条 · ' +
      STATS.total.toLocaleString() + ' 个检索项 · 附录 ' +
      rows.filter(function (r) { return r[3] === '0' && /^[0-4]/.test(r[0]); }).length + ' 篇';

    restoreFontSize();
    runSearch('');
    bind();
    routeFromHash(true);
    console.log('[羅和辞典] 索引载入 %d ms，%d 行', Date.now() - t0, n);
    setTimeout(function () { $('boot').classList.add('done'); }, 120);
  }

  /* ---------------- 搜索 ---------------- */
  function search(raw) {
    var nq = fold(raw).trim();
    if (!nq) return { list: [], mode: '' };

    var exact = [], pre = [], i, f, LIMIT = 400;
    for (i = 0; i < folded.length; i++) {
      f = folded[i];
      if (f === nq) { if (exact.length < LIMIT) exact.push(i); }
      else if (f.lastIndexOf(nq, 0) === 0) { if (pre.length < LIMIT) pre.push(i); }
    }
    if (exact.length || pre.length) {
      return { list: exact.concat(pre), mode: exact.length ? 'exact' : 'prefix' };
    }

    var cont = [];
    for (i = 0; i < folded.length && cont.length < 200; i++) {
      if (folded[i].indexOf(nq) > -1) cont.push(i);
    }
    if (cont.length) return { list: cont, mode: 'contains' };

    // 退一步：u/v、i/j 互查（video ↔ uideo）
    var nq2 = fold2(raw).trim();
    if (nq2 && nq2 !== nq) {
      var ex2 = [], pr2 = [];
      for (i = 0; i < folded.length; i++) {
        f = fold2(folded[i]);
        if (f === nq2) { if (ex2.length < LIMIT) ex2.push(i); }
        else if (f.lastIndexOf(nq2, 0) === 0) { if (pr2.length < LIMIT) pr2.push(i); }
      }
      if (ex2.length || pr2.length) return { list: ex2.concat(pr2), mode: 'uv' };
    }
    return { list: [], mode: '' };
  }

  function runSearch(raw) {
    var res = search(raw);
    hits = res.list;
    sel = hits.length ? 0 : -1;

    infoEl.textContent = hits.length
      ? hits.length >= 400 ? '结果 400+ 条，继续输入以缩小范围' : '共 ' + hits.length + ' 条'
      : (raw.trim() ? '没有匹配' : '共 ' + rows.length.toLocaleString() + ' 个检索项');

    hintEl.textContent = res.mode === 'contains' ? '模糊匹配'
      : res.mode === 'uv' ? 'u/v · i/j 通用' : '';

    var sp = holderEl.querySelector('span'), sm = holderEl.querySelector('small');
    if (!hits.length && raw.trim()) {
      sp.textContent = '没有找到「' + raw.trim() + '」';
      sm.textContent = '可以去掉长音符，或只输入词干试试';
    } else {
      sp.textContent = '从左侧选择一个词条';
      sm.textContent = '或按 ↑ ↓ 选择、Enter 打开';
    }

    renderList();
  }

  function renderList() {
    railEmptyEl.hidden = hits.length > 0;
    if (!hits.length) {
      listEl.innerHTML = '';
      return;
    }
    var out = [], i, r, k;
    for (i = 0; i < hits.length; i++) {
      r = rows[hits[i]];
      k = r[0];
      if (r[3] === '1') {
        out.push('<li class="is-alias' + (i === sel ? ' active' : '') + '" data-i="' + hits[i] + '">' +
          '<span class="w">' + esc(k) + '</span>' +
          '<span class="arrow">→</span><span class="tgt">' + esc(shown(r[4])) + '</span></li>');
      } else {
        out.push('<li' + (i === sel ? ' class="active"' : '') + ' data-i="' + hits[i] + '">' +
          '<span class="w">' + esc(shown(k)) + '</span></li>');
      }
    }
    listEl.innerHTML = out.join('');
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* 附录词条在 mdx 里用 0/1/2/3 前缀占位，显示时去掉 */
  function shown(key) {
    return /^[0-4][^\x00-\x7F]/.test(key) ? key.slice(1) : key;
  }

  /* ---------------- 正文载入 ---------------- */
  function loadChunk(cid) {
    if (chunks[cid]) return Promise.resolve(chunks[cid]);
    if (chunkWait[cid]) return chunkWait[cid];
    chunkWait[cid] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'data/' + cid + '.js';
      s.onload = function () { resolve(chunks[cid] || []); };
      s.onerror = function () { reject(new Error('无法载入数据分片 ' + cid)); };
      document.head.appendChild(s);
    });
    return chunkWait[cid];
  }
  window.__CH = function (cid, arr) { chunks[cid] = arr; };

  function openRow(i, fromHash) {
    var m = where[i];
    if (!m) return;
    current = i;
    setActiveInList(i);
    document.body.classList.add('reading');

    loadChunk(m[0]).then(function (arr) {
      var html = arr[m[1]];
      if (html == null) { metaEl.innerHTML = ''; entryEl.innerHTML = '<p>数据缺失。</p>'; return; }

      var r = rows[i];
      var isAlias = m[2];
      metaEl.innerHTML = isAlias
        ? '<span class="tag link">跳转 ' + esc(r[0]) + ' → ' + esc(m[3]) + '</span>'
        : '';
      welcomeEl.style.display = 'none';
      holderEl.hidden = true;

      entryEl.innerHTML = html;
      wireLinks(entryEl);
      window.scrollTo(0, 0);

      if (!fromHash) {
        suppressHash = true;
        location.hash = encodeURIComponent(r[0]);
        setTimeout(function () { suppressHash = false; }, 0);
      }
    }).catch(function (e) {
      metaEl.innerHTML = '';
      entryEl.innerHTML = '<p style="color:#a33">载入失败：' + esc(e.message) + '</p>';
    });
  }

  function wireLinks(root) {
    var as = root.querySelectorAll('a[href^="entry://"]');
    for (var i = 0; i < as.length; i++) {
      var raw = as[i].getAttribute('href').slice(8);
      var key = raw.split('#')[0];
      try { key = decodeURIComponent(key); } catch (e) { /* 原样使用 */ }
      as[i].removeAttribute('href');
      as[i].setAttribute('data-entry', key);
      as[i].title = key;
    }
  }

  function openKey(key) {
    var i = keyMap[key];
    if (i === undefined) {
      var res = search(key);
      if (res.list.length) i = res.list[0];
    }
    if (i === undefined) return false;
    // 让左侧列表同步显示出这个词
    if (hits.indexOf(i) === -1) {
      q.value = key;
      document.querySelector('.searchbox').classList.add('has-value');
      runSearch(key);
      var pos = hits.indexOf(i);
      sel = pos < 0 ? 0 : pos;
    }
    openRow(i, false);
    return true;
  }

  function setActiveInList(i) {
    var items = listEl.children, k;
    for (k = 0; k < items.length; k++) items[k].classList.remove('active');
    var el = listEl.querySelector('li[data-i="' + i + '"]');
    if (el) {
      el.classList.add('active');
      var top = el.offsetTop - listEl.offsetTop;
      if (top < railEl.scrollTop + 40 || top > railEl.scrollTop + railEl.clientHeight - 60) {
        railEl.scrollTop = top - railEl.clientHeight / 2;
      }
    }
  }

  /* ---------------- 哈希路由 ---------------- */
  function routeFromHash(first) {
    var h = location.hash.replace(/^#/, '');
    if (!h) { if (first) showWelcome(); return; }
    var key;
    try { key = decodeURIComponent(h); } catch (e) { key = h; }
    var i = keyMap[key];
    if (i === undefined) { var r = search(key); if (r.list.length) i = r.list[0]; }
    if (i === undefined) { showWelcome(); return; }
    q.value = key;
    document.querySelector('.searchbox').classList.add('has-value');
    runSearch(key);
    var pos = hits.indexOf(i); sel = pos < 0 ? 0 : pos;
    renderList();
    openRow(i, true);
  }

  function showWelcome() {
    document.body.classList.remove('reading');
    entryEl.innerHTML = '';
    metaEl.innerHTML = '';
    welcomeEl.style.display = '';
    holderEl.hidden = true;
  }

  /* 没有打开词条时的右侧状态：空查询显示欢迎页，有查询显示提示 */
  function showIdle() {
    document.body.classList.remove('reading');
    entryEl.innerHTML = '';
    metaEl.innerHTML = '';
    var hasQuery = q.value.trim().length > 0;
    welcomeEl.style.display = hasQuery ? 'none' : '';
    holderEl.hidden = !hasQuery;
  }

  /* ---------------- 侧栏字母 ---------------- */
  function buildAlpha() {
    var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    var html = '';
    for (var i = 0; i < letters.length; i++) {
      html += '<button data-l="' + letters[i] + '" title="浏览 ' + letters[i] + '">' + letters[i] + '</button>';
    }
    alphaEl.innerHTML = html;
  }

  /* ---------------- 附录入口 ---------------- */
  function buildFrontMatter() {
    var box = $('frontmatter');
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][3] === '0' && /^[0-4]/.test(rows[i][0])) {
        out.push('<button data-k="' + esc(rows[i][0]) + '">' + esc(rows[i][0].replace(/^[0-4]/, '')) + '</button>');
      }
    }
    box.innerHTML = out.join('');
  }

  /* ---------------- 字号 ---------------- */
  function restoreFontSize() {
    var v;
    try { v = parseInt(localStorage.getItem('llj-font'), 10); } catch (e) { v = 0; }
    if (v >= 13 && v <= 22) document.documentElement.style.fontSize = v + 'px';
  }
  function bumpFont(d) {
    var cur = parseInt(getComputedStyle(document.documentElement).fontSize, 10) || 16;
    var next = Math.min(22, Math.max(13, cur + d));
    document.documentElement.style.fontSize = next + 'px';
    try { localStorage.setItem('llj-font', next); } catch (e) {}
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    var timer = null;
    q.addEventListener('input', function () {
      var box = document.querySelector('.searchbox');
      box.classList.toggle('has-value', q.value.length > 0);
      clearTimeout(timer);
      timer = setTimeout(function () {
        runSearch(q.value);
        showIdle();
      }, 60);
    });

    q.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!hits.length) return;
        e.preventDefault();
        sel = e.key === 'ArrowDown'
          ? Math.min(hits.length - 1, sel + 1)
          : Math.max(0, sel - 1);
        renderList();
        var el = listEl.querySelector('li[data-i="' + hits[sel] + '"]');
        if (el) el.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        if (sel >= 0) openRow(hits[sel], false);
      } else if (e.key === 'Escape') {
        q.value = ''; q.dispatchEvent(new Event('input')); q.blur();
      }
    });

    $('clear').addEventListener('click', function () {
      q.value = ''; q.dispatchEvent(new Event('input')); q.focus();
    });

    listEl.addEventListener('click', function (e) {
      var li = e.target.closest('li[data-i]');
      if (!li) return;
      var i = +li.getAttribute('data-i');
      sel = hits.indexOf(i);
      openRow(i, false);
    });

    entryEl.addEventListener('click', function (e) {
      var a = e.target.closest('a[data-entry]');
      if (a) { e.preventDefault(); openKey(a.getAttribute('data-entry')); }
    });

    alphaEl.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-l]');
      if (!b) return;
      q.value = b.getAttribute('data-l');
      document.querySelector('.searchbox').classList.add('has-value');
      runSearch(q.value);
      showIdle();
    });

    $('frontmatter').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-k]');
      if (b) openKey(b.getAttribute('data-k'));
    });

    backEl.addEventListener('click', function () {
      document.body.classList.remove('reading');
      window.scrollTo(0, 0);
    });

    $('random').addEventListener('click', function () {
      var i;
      do { i = Math.floor(Math.random() * rows.length); } while (rows[i][3] === '1' && Math.random() > 0.1);
      openRow(i, false);
    });

    $('fs-up').addEventListener('click', function () { bumpFont(1); });
    $('fs-down').addEventListener('click', function () { bumpFont(-1); });

    window.addEventListener('hashchange', function () {
      if (suppressHash) return;
      routeFromHash(false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
