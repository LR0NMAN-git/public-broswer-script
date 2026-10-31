# public-browser-script

存放个人使用的油猴(Tampermonkey / Violentmonkey)与脚本猫(ScriptCat)用户脚本。

## 目录结构

```
.
├── scripts/
│   ├── _template.user.js   # 新建脚本时复制的模板
│   └── example.user.js     # 示例脚本
├── .gitignore
└── README.md
```

本项目为**纯原生 UserScript**:每个脚本是独立的 `.user.js` 单文件,不依赖构建工具,可直接安装运行。

## 脚本列表

| 脚本 | 说明 |
| --- | --- |
| [`a6api-cny-rate.user.js`](scripts/a6api-cny-rate.user.js) | A6api 人民币换算:汇率取 2 位小数、结果保留完整小数;覆盖日志页收益、编辑弹窗「原价」与输入价 ×1.2 提价上限 |
| [`example.user.js`](scripts/example.user.js) | 示例脚本,在页面右下角显示悬浮标签 |

## 新建脚本

复制模板并改名,然后修改文件头元数据:

```bash
cp scripts/_template.user.js scripts/my-script.user.js
```

必填的元数据:

| 字段 | 说明 |
| --- | --- |
| `@name` | 脚本名 |
| `@namespace` | 命名空间,统一用仓库地址 |
| `@version` | 版本号,更新脚本时需递增 |
| `@match` | 生效页面,可写多行;如 `*://*.example.com/*` |
| `@grant` | 使用的 GM API,如 `GM_setValue`、`GM_xmlhttpRequest`;不用则写 `none` |
| `@run-at` | 运行时机:`document-start` / `document-end` / `document-idle` |

可选常用字段:`@description`、`@author`、`@icon`、`@require`、`@connect`(配合 `GM_xmlhttpRequest`)、`@updateURL` / `@downloadURL`。

## 安装与调试

**本地文件**

1. 打开油猴/脚本猫的管理面板 → 新建脚本,或者直接把 `.user.js` 文件拖进浏览器。
2. 脚本猫可在「脚本仓库」中直接导入本地文件。

**从 GitHub 安装**

将下面的地址在油猴中打开即可安装,变更后重新访问该地址可检查更新:

```
https://raw.githubusercontent.com/LR0NMAN-git/public-broswer-script/main/scripts/<脚本文件名>.user.js
```

**调试**

- 在浏览器开发者工具的 Console 中确认脚本日志(建议给日志加统一前缀,如 `[my-script]`)。
- `@run-at document-start` 的脚本执行时 DOM 尚未就绪,需要操作页面时用 `DOMContentLoaded` 或 `MutationObserver` 等待。

## 兼容性说明

油猴与脚本猫在通用元数据上兼容。如需使用脚本猫专属 API(如 `CAT_` 前缀的接口),应在脚本内做存在性判断,避免在其他管理器下报错:

```js
if (typeof CAT_userConfig !== 'undefined') {
  // 仅脚本猫环境下执行
}
```

## 约定

- 每个脚本一个文件,文件名使用小写短横线命名,如 `github-wide-screen.user.js`。
- 版本迭代时同步更新 `@version`。
- 不提交任何密钥、Token、个人账号密码到仓库。
