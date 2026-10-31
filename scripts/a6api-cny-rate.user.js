// ==UserScript==
// @name         A6api 收益人民币换算
// @namespace    https://github.com/LR0NMAN-git/public-broswer-script
// @version      0.2.0
// @description  按实时美元汇率,在 A6api 的收益胶囊/日志行收益,以及编辑模型弹窗的「原价」下方追加等值人民币
// @author       LR
// @match        https://a6api.vip/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.exchangerate-api.com
// @connect      open.er-api.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    cacheKey: 'a6api-cny:rate',
    // 汇率缓存有效期:接口本身每天更新一次,30 分钟内不重复请求
    cacheTtlMs: 30 * 60 * 1000,
    // 接口不可用且没有缓存时,等这么久后重试
    retryMs: 3 * 60 * 1000,
    // 给页面渲染留出的时间,超过后仍无数据则显示占位
    renderWaitMs: 8000,
    // MutationObserver 全量刷新的节流间隔
    throttleMs: 150,
  };

  const ENDPOINTS = [
    {
      name: 'exchangerate-api',
      url: 'https://api.exchangerate-api.com/v4/latest/USD',
      parse: (data) => ({
        rate: Number(data.rates.CNY),
        updatedAt: (data.time_last_updated || 0) * 1000,
      }),
    },
    {
      name: 'open.er-api',
      url: 'https://open.er-api.com/v6/latest/USD',
      parse: (data) => {
        if (data.result !== 'success') throw new Error(data['error-type'] || '接口返回异常');
        return {
          rate: Number(data.rates.CNY),
          updatedAt: (data.time_last_update_unix || 0) * 1000,
        };
      },
    },
  ];

  // ---------- 汇率 ----------

  let rateState = { rate: null, updatedAt: 0, source: '', cachedAt: 0, error: '' };
  let ratePromise = null;

  function readCache() {
    try {
      const raw = GM_getValue(CONFIG.cacheKey, '');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeCache(value) {
    try {
      GM_setValue(CONFIG.cacheKey, JSON.stringify({ ...value, cachedAt: Date.now() }));
    } catch (e) {
      /* 存储不可用时只影响缓存,不影响本次显示 */
    }
  }

  function requestJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 10000,
        headers: { Accept: 'application/json' },
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            reject(new Error('HTTP ' + res.status));
            return;
          }
          try {
            resolve(JSON.parse(res.responseText));
          } catch (e) {
            reject(new Error('返回内容不是 JSON'));
          }
        },
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('请求超时')),
      });
    });
  }

  async function fetchRate() {
    const errors = [];
    for (const api of ENDPOINTS) {
      try {
        const data = await requestJson(api.url);
        const parsed = api.parse(data);
        if (!(parsed.rate > 0 && parsed.rate < 100)) {
          throw new Error('汇率值异常: ' + parsed.rate);
        }
        const value = { ...parsed, source: api.name };
        writeCache(value);
        return value;
      } catch (e) {
        errors.push(api.name + ': ' + e.message);
      }
    }
    throw new Error(errors.join('; '));
  }

  function loadRate() {
    if (ratePromise) return ratePromise;

    const cached = readCache();
    if (cached && cached.rate > 0) {
      rateState = { ...cached };
      if (Date.now() - (cached.cachedAt || 0) < CONFIG.cacheTtlMs) {
        ratePromise = Promise.resolve(rateState);
        return ratePromise;
      }
    }

    ratePromise = fetchRate()
      .then((value) => {
        rateState = { ...value };
        document.dispatchEvent(new CustomEvent('a6cny:rate'));
        return rateState;
      })
      .catch((e) => {
        rateState.error = e.message;
        // 有新数据前先用旧缓存(任意时间),保证页面仍能看到换算值
        if (!(rateState.rate > 0)) {
          ratePromise = null;
          setTimeout(reloadRate, CONFIG.retryMs);
        }
        return rateState;
      });

    return ratePromise;
  }

  function reloadRate() {
    ratePromise = null;
    loadRate().then(updateAll);
  }

  // ---------- 工具 ----------

  // "$547.009436" -> 547.009436;优先取 $ 后面的金额,没有 $ 才退回取第一个数字
  function parseUsd(text) {
    const s = String(text).replace(/,/g, '');
    const m = s.match(/\$\s*(-?\d+(?:\.\d+)?)/) || s.match(/(-?\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : null;
  }

  // 按每行的量级选择小数位:单行收益经常低于 0.01,固定 2 位会显示成 ¥0.00
  function formatCny(usd) {
    const cny = usd * rateState.rate;
    if (cny === 0) return '¥0.00';
    const abs = Math.abs(cny);
    let digits = 2;
    if (abs < 0.01) digits = 4;
    else if (abs < 1) digits = 3;
    return '¥' + cny.toFixed(digits);
  }

  function describeRate() {
    const parts = [];
    if (rateState.rate > 0) parts.push('1 USD = ' + rateState.rate.toFixed(4) + ' CNY');
    if (rateState.updatedAt) {
      const d = new Date(rateState.updatedAt);
      parts.push('汇率日期 ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()));
    }
    if (rateState.error) parts.push('最近一次获取失败:' + rateState.error);
    return parts.join('  ');
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  // 用页面自身的胶囊样式作为模板生成人民币标签,保证字体、圆角、间距与原页面一致
  function createPill(valueText) {
    const template = document.querySelector('.cl-capsules-group .cl-capsule');
    const pill = template ? template.cloneNode(false) : document.createElement('div');
    pill.classList.remove('is-active-primary');
    pill.classList.add('a6cny-pill');
    pill.removeAttribute('style');
    pill.title = describeRate();

    if (template) {
      const labelSrc = template.querySelector('.cl-capsule-label');
      const valSrc = template.querySelector('.cl-capsule-val');
      pill.appendChild(labelSrc ? labelSrc.cloneNode(true) : document.createElement('span'));
      pill.appendChild(valSrc ? valSrc.cloneNode(true) : document.createElement('strong'));
    } else {
      pill.appendChild(document.createElement('span'));
      pill.appendChild(document.createElement('strong'));
    }

    const label = pill.querySelector('.cl-capsule-label');
    const value = pill.querySelector('.cl-capsule-val');
    label.textContent = '≈ 人民币';
    value.textContent = valueText;
    return pill;
  }

  function createRatePill() {
    const pill = createPill(rateState.rate > 0 ? formatCny(1) + '/USD' : '—');
    pill.classList.add('a6cny-rate-pill');
    return pill;
  }

  // ---------- 样式 ----------

  // 页面的胶囊由全局样式表统一控制,新标签复用同一套 class;
  // 这里只补原页面没有的部分:人民币金额的颜色、行内小标签、深浅色适配
  function injectStyles() {
    if (document.getElementById('a6cny-style')) return;
    const style = document.createElement('style');
    style.id = 'a6cny-style';
    style.textContent = `
      /* 琥珀色区别于页面原有的绿色收益,同时与原样式表的选择器权重持平,靠加载顺序生效 */
      html .a6cny-pill .cl-capsule-val { color: #d97706; }
      html[data-theme="dark"] .a6cny-pill .cl-capsule-val { color: #fbbf24; }

      .a6cny-tag {
        display: inline-block;
        margin-left: 6px;
        padding: 0 5px;
        border-radius: 4px;
        font-family: var(--font-mono, monospace);
        font-size: 12px;
        font-weight: 500;
        line-height: 18px;
        letter-spacing: normal;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        vertical-align: middle;
        color: #b45309;
        background: rgba(217, 119, 6, 0.1);
      }
      html[data-theme="dark"] .a6cny-tag {
        color: #fbbf24;
        background: rgba(251, 191, 36, 0.14);
      }
      .a6cny-tag.is-pending { color: #6b7280; background: rgba(107, 114, 128, 0.12); }
      .a6cny-tag.is-error { color: #dc2626; background: rgba(220, 38, 38, 0.1); }

      /* 编辑弹窗「原价折合」行:沿用原价行的排版,只给金额上色 */
      .a6cny-price-line .a6cny-price-value { color: #b45309; font-variant-numeric: tabular-nums; }
      .a6cny-price-line .is-pending { color: #6b7280; }
      .a6cny-price-line .is-error { color: #dc2626; }
      html[data-theme="dark"] .a6cny-price-line .a6cny-price-value { color: #fbbf24; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---------- 顶部胶囊 ----------

  // 读取胶囊的金额:换算标签复用了 .cl-capsule 结构,仅从原胶囊自身的金额节点读取
  function readCapsuleUsd(capsule) {
    const value = capsule.querySelector('.cl-capsule-val');
    return value ? parseUsd(value.textContent) : null;
  }

  function decorateCapsule(capsule) {
    const label = capsule.querySelector('.cl-capsule-label');
    const value = capsule.querySelector('.cl-capsule-val');
    if (!label || !value) return;

    const name = label.textContent.trim();
    if (name !== '今日应得' && name !== '本月应得') return;

    // 先清掉胶囊内(含紧跟其后)的旧标签,再重新插入:Vue 原地复用节点时旧标签会残留
    capsule.querySelectorAll('.a6cny-pill').forEach((el) => el.remove());
    let next = capsule.nextElementSibling;
    while (next && next.classList.contains('a6cny-pill')) {
      const toRemove = next;
      next = next.nextElementSibling;
      toRemove.remove();
    }

    const usd = readCapsuleUsd(capsule);
    if (usd === null) return;
    let pill;
    if (rateState.rate > 0) {
      pill = createPill(formatCny(usd));
    } else {
      pill = createPill(rateState.error ? '汇率获取失败' : '汇率加载中');
      schedulePendingRefresh();
    }
    pill.dataset.usd = String(usd);
    // pill 是刚创建的新节点,直接插入不会发生「移动已有节点」
    capsule.insertAdjacentElement('afterend', pill);
  }

  // ---------- 编辑模型弹窗:原价 ----------

  // "输入 $2.5 / 输出 $12.5 / 缓存读 $0.25 / 缓存写 $3.125" -> [{label: '输入', usd: 2.5}, ...]
  function parseOriginalPrices(line) {
    const parts = [];
    for (const el of line.querySelectorAll('span:not(.ws-original-price-key)')) {
      const text = el.textContent.trim();
      const usd = parseUsd(text);
      if (usd === null) continue;
      const label = text.replace(/\$\s*-?\d.*$/, '').trim();
      parts.push({ label, usd });
    }
    return parts;
  }

  // 只返回值本身,单位由调用方拼接
  function formatPriceValue(part) {
    if (rateState.rate > 0) return formatCny(part.usd);
    return rateState.error ? '获取失败' : '加载中';
  }

  // 在「原价」行下方插入一行人民币换算,结构参照原价行,样式沿用页面自身的类
  function decorateOriginalPrice(line) {
    const parts = parseOriginalPrices(line);
    if (!parts.length) return;

    let row = line.nextElementSibling;
    if (!row || !row.classList.contains('a6cny-price-line')) {
      row = document.createElement('div');
      row.className = 'ws-original-price-line a6cny-price-line';
      line.insertAdjacentElement('afterend', row);
    }

    // 金额没变且汇率已就绪就不重建,避免每轮刷新都改动 DOM 触发自身观察
    const signature = (rateState.rate || (rateState.error ? 'error' : 'pending')) + '|' + parts.map((p) => p.usd).join('|');
    if (row.dataset.signature === signature) return;
    row.dataset.signature = signature;

    row.textContent = '';
    const key = document.createElement('span');
    key.className = 'ws-original-price-key';
    key.textContent = '原价折合';
    row.appendChild(key);
    parts.forEach((part, i) => {
      if (i > 0) row.appendChild(document.createTextNode(' / '));
      const value = document.createElement('span');
      value.textContent = part.label + ' ≈ ' + formatPriceValue(part);
      if (rateState.rate > 0) {
        value.classList.add('a6cny-price-value');
        value.title = describeRate();
      } else {
        value.classList.add(rateState.error ? 'is-error' : 'is-pending');
        if (!rateState.error) schedulePendingRefresh();
      }
      row.appendChild(value);
    });
  }

  // ---------- 表格行 ----------

  function decorateRowCell(cell) {
    const usd = parseUsd(cell.textContent);
    if (usd === null) return;

    let tag = cell.querySelector('.a6cny-tag');
    if (!tag) {
      tag = document.createElement('span');
      tag.className = 'a6cny-tag';
      cell.appendChild(tag);
    }
    // 单元格可能被 Vue 原地复用(文本换了、节点没换),每次都按当前金额重算
    applyTag(tag, usd);
  }

  let pendingTimer = 0;

  // 汇率尚未返回时,延迟再刷新一次,避免长时间停留在「加载中」
  function schedulePendingRefresh() {
    if (pendingTimer || rateState.rate > 0) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = 0;
      if (rateState.rate > 0) updateAll();
    }, CONFIG.renderWaitMs);
  }

  function applyTag(tag, usd) {
    if (rateState.rate > 0) {
      tag.textContent = '≈ ' + formatCny(usd);
      tag.classList.remove('is-pending', 'is-error');
      tag.title = describeRate();
    } else if (rateState.error) {
      tag.textContent = '≈ 汇率获取失败';
      tag.classList.add('is-error');
      tag.classList.remove('is-pending');
      tag.title = rateState.error;
    } else {
      tag.textContent = '≈ 加载中';
      tag.classList.add('is-pending');
      tag.classList.remove('is-error');
      tag.title = '正在获取实时汇率';
      schedulePendingRefresh();
    }
  }

  // ---------- 扫描与刷新 ----------

  // 表格按列渲染收益,单元格在首屏 DOM 快照里通常已经存在,不会触发新增节点;
  // 因此表格部分只靠 updateAll 全量处理,由 MutationObserver 的节流刷新兜底
  function decorateAllRows() {
    document.querySelectorAll('.cl-cell-earnings').forEach(decorateRowCell);
  }

  // 「汇率」兜底胶囊只用于没有数据胶囊的页面,且必须挂在表格卡片上,
  // 否则会出现在 .cl-capsules-group 里,需要在 updateAll 中清理掉
  function ensureRatePill(container) {
    const pill = container.querySelector(':scope > .a6cny-rate-pill');
    if (!pill) return;
    if (container.classList.contains('cl-capsules-group')) {
      pill.remove();
      return;
    }
    pill.querySelector('.cl-capsule-val').textContent =
      rateState.rate > 0 ? formatCny(1) + '/USD' : rateState.error ? '获取失败' : '加载中';
    pill.title = describeRate();
  }

  function updateAll() {
    const groups = document.querySelectorAll('.cl-capsules-group');
    // 只选原页面的胶囊:新标签复用了 .cl-capsule 类,不过滤会被当成源数据
    groups.forEach((group) =>
      group.querySelectorAll('.cl-capsule:not(.a6cny-pill)').forEach(decorateCapsule));

    decorateAllRows();
    document.querySelectorAll('[data-role="original-price"]').forEach(decorateOriginalPrice);

    groups.forEach(ensureRatePill);
    if (!groups.length) {
      // 未登录或页面还在加载、没有数据胶囊时,把汇率挂在表格卡片上,便于确认脚本正在运行
      const card = document.querySelector('.cl-table-card');
      if (card) {
        let pill = card.querySelector(':scope > .a6cny-rate-pill');
        if (!pill) {
          pill = createRatePill();
          card.appendChild(pill);
        }
        ensureRatePill(card);
      }
    }
  }

  // ---------- 启动 ----------

  let flushTimer = 0;

  // 页面每次变化都节流触发一次全量刷新:收益单元格可能原地改文本(不新增节点),
  // 只看 addedNodes 会漏掉。脚本自己插入的节点也会引发回调,但 decorateCapsule 会先清掉
  // 旧标签再插入,decorateRowCell 会复用已有标签,重复执行的结果不变,不会累积节点。
  function onMutations() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = 0;
      updateAll();
    }, CONFIG.throttleMs);
  }

  function init() {
    injectStyles();
    document.addEventListener('a6cny:rate', updateAll);

    const observer = new MutationObserver(onMutations);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });

    loadRate().then(updateAll);
  }

  if (document.body) {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init, { once: true });
  }
})();
