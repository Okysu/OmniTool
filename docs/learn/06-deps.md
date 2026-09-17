---
title: 使用第三方库
titleEn: Third-party libraries
chapter: 进阶
sample: text
sampleName: readme.txt
sampleText: 把我和其他文件一起打包成 ZIP。\n
---

沙盒没有网络，不能 `import` 也不能 `fetch`。那怎么用 npm 上的库？
**声明依赖，由宿主替你拉取、校验并注入。**

```js
deps: [
  { id: 'fflate', url: '/vendor/fflate.js', global: 'fflate' },
],
```

插件启动前，宿主下载 `url`，（如果提供了 `integrity` 就校验哈希），把脚本注入沙盒。
脚本定义的全局变量（这里是 `fflate`）你就可以直接用了。

- `url` 可以是本站的 `/vendor/…`（OmniTool 自带 pdf-lib、pdf.js、fflate 等），也可以是任意 https 地址；
- 跨站依赖**强烈建议**写 `integrity: 'sha384-…'`，否则 CDN 上的文件被换掉你也不知道。

## 按需加载：`lazy`

一个 14 MB 的库不该拖慢每次打开工具。加上 `lazy: true`，它就不会在启动时注入，
而是在你调用 `loadDependency(id)` 时才加载：

```js
deps: [{ id: 'fflate', url: '/vendor/fflate.js', global: 'fflate', lazy: true }],
// …
const { exports: zip } = await loadDependency('fflate')
```

`loadDependency` 只能加载清单里**声明过**的依赖——宿主按安装时用户看到的清单核对，插件没法临时加一个。

## 动手试试

当前插件在启动时就注入 fflate，把输入文件打包成 ZIP。请：

1. 改成 `lazy: true`，在 `run` 里用 `loadDependency` 取得它。
2. 加一个「压缩级别」滑块（0–9）传给 `zipSync` 的 `level`。
3. 让它接受多个文件。

```js starter
definePlugin({
  id: 'learn.deps',
  name: '打包工具',
  version: '1.0.0',
  capabilities: ['fs'],
  deps: [{ id: 'fflate', url: '/vendor/fflate.js', global: 'fflate' }],
  tools: [
    {
      id: 'zip',
      name: '打包为 ZIP',
      category: 'archive',
      async run(ctx) {
        const entries = {}
        for (const input of ctx.inputs) {
          entries[input.name] = await ctx.host.fs.readAll(input.id)
        }
        const bytes = fflate.zipSync(entries, { level: 6 })
        const out = await ctx.host.fs.writeAll('打包.zip', bytes, 'application/zip')
        return { outputs: [out.id], summary: `${ctx.inputs.length} 个文件 → ${bytes.length} 字节` }
      },
    },
  ],
})
```

```js solution
definePlugin({
  id: 'learn.deps',
  name: '打包工具',
  version: '1.0.0',
  capabilities: ['fs'],
  deps: [{ id: 'fflate', url: '/vendor/fflate.js', global: 'fflate', lazy: true }],
  tools: [
    {
      id: 'zip',
      name: '打包为 ZIP',
      category: 'archive',
      multiple: true,
      params: [{ key: 'level', type: 'slider', label: '压缩级别', min: 0, max: 9, default: 6 }],
      async run(ctx) {
        const { exports: zip } = await loadDependency('fflate')
        const entries = {}
        for (const input of ctx.inputs) {
          ctx.throwIfAborted()
          entries[input.name] = await ctx.host.fs.readAll(input.id)
        }
        const bytes = zip.zipSync(entries, { level: Number(ctx.params.level) })
        const out = await ctx.host.fs.writeAll('打包.zip', bytes, 'application/zip')
        return { outputs: [out.id], summary: `${ctx.inputs.length} 个文件 → ${bytes.length} 字节` }
      },
    },
  ],
})
```
