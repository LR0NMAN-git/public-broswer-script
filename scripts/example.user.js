// ==UserScript==
// @name         示例:页面右下角悬浮信息
// @name:zh-CN   示例:页面右下角悬浮信息
// @namespace    https://github.com/LR0NMAN-git/public-broswer-script
// @version      0.1.0
// @description  演示油猴/脚本猫脚本的基本结构,在页面右下角显示一个悬浮标签
// @author       LR
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const box = document.createElement('div');
  box.textContent = '示例脚本已运行';
  Object.assign(box.style, {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    zIndex: '2147483647',
    padding: '6px 12px',
    borderRadius: '6px',
    background: '#24292f',
    color: '#fff',
    fontSize: '12px',
    fontFamily: 'system-ui, sans-serif',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
    cursor: 'pointer',
  });

  // 点击隐藏
  box.addEventListener('click', () => box.remove());

  document.body.appendChild(box);
})();
