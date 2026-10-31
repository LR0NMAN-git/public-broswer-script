// ==UserScript==
// @name         A6api 收益人民币换算
// @namespace    https://github.com/LR0NMAN-git/public-broswer-script
// @version      0.4.1
// @description  按实时美元汇率换算 A6api 的收益与价格(汇率取 2 位小数,结果保留完整小数)
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
    // 首屏渲染完成后再等这么久才请求汇率,错开首屏动画
    initialRefreshDelayMs: 600,
  };

  const ENDPOINTS = [
    {
      name: 'exchangerate-api',
      url: 'https://api.exchangerate-api.com/v4/latest/USD',
      parse: (data) => ({
        // 汇率统一按 2 位小数参与计算,与显示保持一致
        rate: roundRate(data.rates.CNY),
        updatedAt: (data.time_last_updated || 0) * 1000,
      }),
    },
    {
      name: 'open.er-api',
      url: 'https://open.er-api.com/v6/latest/USD',
      parse: (data) => {
        if (data.result !== 'success') throw new Error(data['error-type'] || '接口返回异常');
        return {
          rate: roundRate(data.rates.CNY),
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
        // 按 2 位小数取整后仍须在合理区间,防止接口返回异常值
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

  // 页面加载时只读缓存,不发网络请求:首屏渲染期间网络回调会打断一次帧,
  // 表现为顶部胶囊「闪」一下。请求放到首屏稳定之后,由 startRefresh 触发
  function loadCachedRate() {
    const cached = readCache();
    if (cached && cached.rate > 0) {
      // 旧版本缓存里可能是完整汇率,统一按 2 位小数使用
      rateState = { ...cached, rate: roundRate(cached.rate) };
    }
  }

  function isRateFresh() {
    return Date.now() - (rateState.cachedAt || 0) < CONFIG.cacheTtlMs;
  }

  function requestRate() {
    if (ratePromise) return ratePromise;
    ratePromise = fetchRate()
      .then((value) => {
        rateState = { ...value };
        notifyRateChanged();
        return rateState;
      })
      .catch((e) => {
        rateState.error = e.message;
        // 失败也要重绘一次,否则界面会一直停在「加载中」
        notifyRateChanged();
        // 有新数据前先用旧缓存(任意时间),保证页面仍能看到换算值
        if (!(rateState.rate > 0)) {
          ratePromise = null;
          setTimeout(reloadRate, CONFIG.retryMs);
        }
        return rateState;
      });
    return ratePromise;
  }

  function notifyRateChanged() {
    document.dispatchEvent(new CustomEvent('a6cny:rate'));
  }

  function reloadRate() {
    ratePromise = null;
    return requestRate().then(() => updateAll());
  }

  // ---------- 工具 ----------

  // "$547.009436" -> 547.009436;优先取 $ 后面的金额,没有 $ 才退回取第一个数字
  function parseUsd(text) {
    const s = String(text).replace(/,/g, '');
    const m = s.match(/\$\s*(-?\d+(?:\.\d+)?)/) || s.match(/(-?\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : null;
  }

  // 汇率统一保留 2 位小数,计算与显示使用同一个值
  function roundRate(value) {
    return Math.round(Number(value) * 100) / 100;
  }

  // 美元金额 -> 人民币文本。汇率已按 2 位小数取整,这里保留计算结果的完整小数。
  // 先把两个因子转成整数相乘(各乘以 10^n),再按整数做十进制格式化,
  // 避免 0.000156 * 6.67 得到 0.0010405199999999999 这类浮点尾数
  function formatCny(usd) {
    const rate = rateState.rate;
    if (!(rate > 0)) return '';

    const rateText = plainDecimal(rate);
    const usdText = plainDecimal(usd);
    if (!rateText || !usdText) {
      // 极端量级(科学计数法)直接交给浮点,避免拼字符串出错
      return '¥' + trimZeros(Number((usd * rate).toPrecision(15)));
    }

    const rateDecimals = decimalsOf(rateText);
    const usdDecimals = decimalsOf(usdText);
    const scale = rateDecimals + usdDecimals;
    const product = toInt(usdText, usdDecimals) * toInt(rateText, rateDecimals);
    return '¥' + trimZeros(formatInt(product, scale));
  }

  // 6.67 -> "6.67";科学计数法的值返回 null,由调用方走浮点分支
  function plainDecimal(value) {
    const text = String(value);
    if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
    return text;
  }

  function decimalsOf(text) {
    return (text.split('.')[1] || '').length;
  }

  // "2.5" 按 1 位小数 -> 25
  function toInt(text, decimals) {
    const negative = text.startsWith('-');
    const [int, frac = ''] = (negative ? text.slice(1) : text).split('.');
    const digits = (frac + '0'.repeat(decimals)).slice(0, decimals);
    const value = Number(int + digits);
    return negative ? -value : value;
  }

  // 整数 104052 配合 scale=8 -> "0.00104052"
  function formatInt(product, scale) {
    const negative = product < 0;
    let digits = String(Math.abs(product)).padStart(scale + 1, '0');
    if (scale > 0) {
      digits = digits.slice(0, -scale) + '.' + digits.slice(-scale);
    }
    return (negative ? '-' : '') + digits;
  }

  // 去掉末尾多余的 0,但至少保留 2 位小数,保证金额看起来对齐
  function trimZeros(text) {
    if (!text.includes('.')) return text + '.00';
    const trimmed = text.replace(/0+$/, '');
    const frac = trimmed.split('.')[1] || '';
    return trimmed + '0'.repeat(Math.max(0, 2 - frac.length));
  }

  function describeRate() {
    const parts = [];
    if (rateState.rate > 0) parts.push('1 USD = ' + rateState.rate.toFixed(2) + ' CNY');
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
  function makeNode(tag, className) {
    const el = document.createElement(tag);
    el.className = className;
    return el;
  }

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
      pill.appendChild(labelSrc ? labelSrc.cloneNode(true) : makeNode('span', 'cl-capsule-label'));
      pill.appendChild(valSrc ? valSrc.cloneNode(true) : makeNode('strong', 'cl-capsule-val'));
    } else {
      // 页面上还没有可参照的胶囊时,自己补出带 class 的结构,保证后续能按 class 定位
      pill.appendChild(makeNode('span', 'cl-capsule-label'));
      pill.appendChild(makeNode('strong', 'cl-capsule-val'));
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

      /* 输入价下方提示:默认沿用页面 factor-line 的灰色,折合人民币部分单独标色 */
      .a6cny-input-hint { color: #b45309; font-variant-numeric: tabular-nums; }
      .a6cny-input-hint.is-pending { color: #6b7280; }
      .a6cny-input-hint.is-error { color: #dc2626; }
      html[data-theme="dark"] .a6cny-input-hint { color: #fbbf24; }
      html[data-theme="dark"] .a6cny-input-hint.is-pending { color: #94a3b8; }
      html[data-theme="dark"] .a6cny-input-hint.is-error { color: #f87171; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---------- 顶部胶囊 ----------

  // 读取胶囊的金额:换算标签复用了 .cl-capsule 结构,仅从原胶囊自身的金额节点读取
  function readCapsuleUsd(capsule) {
    const value = capsule.querySelector('.cl-capsule-val');
    return value ? parseUsd(value.textContent) : null;
  }

  // 胶囊后紧跟的换算标签:存在且唯一时直接复用,避免每轮刷新都删掉重建导致闪烁
  function takePillSlot(capsule) {
    let next = capsule.nextElementSibling;
    if (!next || !next.classList.contains('a6cny-pill')) {
      const fresh = createPill('');
      capsule.insertAdjacentElement('afterend', fresh);
      return fresh;
    }
    // 多余的重复标签(Vue 克隆旧节点时可能带出来)一并清理
    let extra = next.nextElementSibling;
    while (extra && extra.classList.contains('a6cny-pill')) {
      const toRemove = extra;
      extra = extra.nextElementSibling;
      toRemove.remove();
    }
    return next;
  }

  function decorateCapsule(capsule) {
    const label = capsule.querySelector('.cl-capsule-label');
    const value = capsule.querySelector('.cl-capsule-val');
    if (!label || !value) return;

    const name = label.textContent.trim();
    if (name !== '今日应得' && name !== '本月应得') return;

    // Vue 原地复用节点时,标签可能被塞进胶囊内部,移除即可
    capsule.querySelectorAll('.a6cny-pill').forEach((el) => el.remove());

    const usd = readCapsuleUsd(capsule);
    if (usd === null) return;

    let text;
    if (rateState.rate > 0) {
      text = formatCny(usd);
    } else {
      text = rateState.error ? '汇率获取失败' : '汇率加载中';
      schedulePendingRefresh();
    }

    const pill = takePillSlot(capsule);
    // 文本没变就什么都不做:改动 DOM 会触发自身的 MutationObserver,形成反复刷新的循环
    if (pill.dataset.usd === String(usd) && pill.dataset.text === text) return;
    pill.dataset.usd = String(usd);
    pill.dataset.text = text;
    const valueEl = pill.querySelector('.cl-capsule-val');
    if (valueEl.textContent !== text) valueEl.textContent = text;
    pill.title = describeRate();
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

  // 同一份 DOM 里只保留一行折合价:快照里可能已经带着上一次运行留下的行,
  // 胶囊组被整体重建时也可能把旧行克隆过来
  function removeDuplicatePriceLines(line) {
    const next = line.nextElementSibling;
    if (!next || !next.classList.contains('a6cny-price-line')) return null;
    let row = next;
    let extra = row.nextElementSibling;
    while (extra && extra.classList.contains('a6cny-price-line')) {
      const toRemove = extra;
      extra = extra.nextElementSibling;
      toRemove.remove();
    }
    return row;
  }

  // 在「原价」行下方插入一行人民币换算,结构参照原价行,样式沿用页面自身的类
  function decorateOriginalPrice(line) {
    const parts = parseOriginalPrices(line);
    if (!parts.length) return;

    let row = removeDuplicatePriceLines(line);
    if (!row) {
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

  // ---------- 编辑模型弹窗:输入价 ----------

  // 提价上限按页面公示的 20% 计算
  const MAX_RAISE_FACTOR = 1.2;

  // 价格输入区只有一个可编辑输入框(输入价),自动输出的几项均为 readonly
  function findInputPriceField() {
    const grid = document.querySelector('.ws-price-inputs-grid');
    if (!grid) return null;
    return Array.from(grid.querySelectorAll('input.ws-price-text-input')).filter((el) => !el.readOnly)[0] || null;
  }

  function readInputPrice(input) {
    const raw = String(input.value).replace(/,/g, '').trim();
    // 只接受十进制数;输入过程中的 "1." 也按 1 处理,单独的 "." 或空值不显示提示
    if (!/^\d+(\.\d*)?$/.test(raw)) return null;
    return Number(raw);
  }

  // 输入框下方追加提示:提价上限 1.2 倍,并把上限、当前值都折合为人民币
  function decorateInputPriceHint(input) {
    const col = input.closest('.ws-price-input-col') || input.parentElement;
    if (!col) return;

    let hint = col.querySelector('.a6cny-input-hint');
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'ws-price-factor-line a6cny-input-hint';
      const factor = col.querySelector('.ws-price-factor-line');
      if (factor) factor.insertAdjacentElement('afterend', hint);
      else col.appendChild(hint);
    }

    const value = readInputPrice(input);
    const signature = (rateState.rate || (rateState.error ? 'error' : 'pending')) + '|' + value;
    if (hint.dataset.signature === signature) return;
    hint.dataset.signature = signature;

    hint.textContent = '';
    hint.classList.remove('is-pending', 'is-error');
    hint.removeAttribute('title');
    // 清空或输入了非数字时不显示提示
    if (value === null) return;

    const capped = value * MAX_RAISE_FACTOR;
    const cnyOf = (usd) => (rateState.rate > 0 ? '（' + formatCny(usd) + '）' : '');
    hint.append('× 1.2 = $' + formatUsd(capped) + cnyOf(capped));

    if (rateState.rate > 0) {
      hint.title = '提价上限 = 输入价 × 1.2;括号内为按实时汇率折合的人民币';
    } else if (rateState.error) {
      hint.classList.add('is-error');
      hint.title = rateState.error;
    } else {
      hint.classList.add('is-pending');
      schedulePendingRefresh();
    }
  }

  // 去掉浮点尾数:2.5 × 1.2 会得到 3.0000000000000004,输入 1.234567 则保留到 6 位小数
  function formatUsd(value) {
    if (!String(value).includes('.')) return String(value);
    const text = value.toFixed(6).replace(/0+$/, '');
    return text.endsWith('.') ? text.slice(0, -1) : text;
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
    let text;
    let state;
    if (rateState.rate > 0) {
      text = '≈ ' + formatCny(usd);
      state = 'ok';
    } else if (rateState.error) {
      text = '≈ 汇率获取失败';
      state = 'error';
    } else {
      text = '≈ 加载中';
      state = 'pending';
    }

    // 内容和状态都没变就不碰 DOM,否则每次刷新都会触发自身的 MutationObserver
    const signature = state + '|' + usd;
    if (tag.dataset.signature === signature) return;
    tag.dataset.signature = signature;

    tag.textContent = text;
    tag.classList.toggle('is-pending', state === 'pending');
    tag.classList.toggle('is-error', state === 'error');
    if (state === 'ok') tag.title = describeRate();
    else if (state === 'error') tag.title = rateState.error;
    else {
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
    const text =
      rateState.rate > 0 ? formatCny(1) + '/USD' : rateState.error ? '获取失败' : '加载中';
    const valueEl = pill.querySelector('.cl-capsule-val');
    if (valueEl.textContent !== text) valueEl.textContent = text;
    const title = describeRate();
    if (pill.title !== title) pill.title = title;
  }

  // 各 decorate 函数内部比较签名,内容没变就不改 DOM,所以这里可以放心全量调用
  function updateAll() {
    const groups = document.querySelectorAll('.cl-capsules-group');
    // 只选原页面的胶囊:新标签复用了 .cl-capsule 类,不过滤会被当成源数据
    groups.forEach((group) =>
      group.querySelectorAll('.cl-capsule:not(.a6cny-pill)').forEach(decorateCapsule));

    decorateAllRows();
    document.querySelectorAll('[data-role="original-price"]').forEach(decorateOriginalPrice);

    const inputPrice = findInputPriceField();
    if (inputPrice) decorateInputPriceHint(inputPrice);

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
  // 只看 addedNodes 会漏掉。脚本自己插入的节点也会引发回调,但各 decorate 函数
  // 文本未变时不改动 DOM,所以不会形成「改动 → 回调 → 再改动」的自激循环。
  function onMutations() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = 0;
      updateAll();
    }, CONFIG.throttleMs);
  }

  // 首屏渲染完成后(load 事件 + 一小段静默期)再拉汇率,避免网络回调正好落在首屏渲染中间造成闪动
  function startRefresh() {
    const begin = () => {
      setTimeout(() => {
        if (isRateFresh()) {
          updateAll();
          return;
        }
        requestRate();
      }, CONFIG.initialRefreshDelayMs);
    };
    if (document.readyState === 'complete') begin();
    else window.addEventListener('load', begin, { once: true });
  }

  function init() {
    injectStyles();
    // 汇率到达后强制重算一次(与缓存的汇率不同时内容需要更新)
    // 汇率到达(或失败)后重绘一次;内容未变的节点不会被改动
    document.addEventListener('a6cny:rate', updateAll);

    // 输入框的值不体现在 HTML 属性上,MutationObserver 观察不到,需要单独监听输入事件
    document.addEventListener(
      'input',
      (event) => {
        if (event.target && event.target.matches && event.target.matches('.ws-price-inputs-grid input')) {
          const inputPrice = findInputPriceField();
          if (inputPrice) decorateInputPriceHint(inputPrice);
        }
      },
      true,
    );

    loadCachedRate();
    // 先按缓存渲染首屏(无网络回调,不会打断帧),再在首屏稳定后更新汇率
    updateAll();

    const observer = new MutationObserver(onMutations);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });

    startRefresh();
  }

  if (document.body) {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init, { once: true });
  }
})();
