<div align="center">

# @nasti-toolchain/plugin-tanstack

**[Nasti](https://github.com/zixiao-labs/Nasti) 的 [TanStack Router](https://tanstack.com/router) 支持插件**

*文件式路由树生成 + 构建期自动代码分割*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

---

## 它做什么

- **文件式路由树生成** —— 扫描 `src/routes/`，复用官方 [`@tanstack/router-generator`](https://www.npmjs.com/package/@tanstack/router-generator) 生成 `src/routeTree.gen.ts`（版本对齐、格式与官方一致），dev 下文件增删改自动重新生成。
- **构建期自动代码分割** —— `nasti build` 时把每个路由的 `component` / `errorComponent` / `notFoundComponent` 拆进独立 chunk，按需懒加载（`lazyRouteComponent`），减小首屏体积。

> 目标框架：**仅 React**（v1）。TanStack Start 等 Nasti 2.0 支持 SSR 后再议。

## 安装

```bash
npm install -D @nasti-toolchain/plugin-tanstack
# peer 依赖（你的应用本来就需要）
npm install @tanstack/react-router
```

`@nasti-toolchain/nasti` 与 `@tanstack/react-router` 是 peer 依赖，由你的项目提供。

## 用法

```ts
// nasti.config.ts
import { defineConfig } from '@nasti-toolchain/nasti'
import { tanstackRouter } from '@nasti-toolchain/plugin-tanstack'

export default defineConfig({
  framework: 'react',
  plugins: [
    tanstackRouter({
      // 默认值即可直接用；以下为常用项
      routesDirectory: 'src/routes',
      generatedRouteTree: 'src/routeTree.gen.ts',
      autoCodeSplitting: true, // 开启构建期自动代码分割（默认 false）
    }),
  ],
})
```

应用入口照常引用生成的路由树：

```tsx
// src/main.tsx
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

const router = createRouter({ routeTree })
createRoot(document.getElementById('app')!).render(<RouterProvider router={router} />)
```

路由文件约定（`__root.tsx`、`index.tsx`、`$param.tsx`、`_pathlessLayout` 等）与 TanStack Router 完全一致，详见 [官方文档](https://tanstack.com/router/latest/docs/framework/react/routing/file-based-routing)。路由的 path 字面量由生成器在 `createFileRoute('/path')` 中自动写入/校正，无需手动维护。

## 选项

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `routesDirectory` | `string` | `src/routes` | 路由目录（相对项目根） |
| `generatedRouteTree` | `string` | `src/routeTree.gen.ts` | 生成的路由树文件路径 |
| `autoCodeSplitting` | `boolean` | `false` | 开启构建期自动代码分割 |
| `routeFileIgnorePrefix` | `string` | `-` | 该前缀的文件不视为路由 |
| `routeFileIgnorePattern` | `string` | — | 匹配该正则的文件被忽略 |
| `routeFilePrefix` | `string` | — | 仅该前缀的文件视为路由 |
| `quoteStyle` | `'single' \| 'double'` | `single` | 生成代码的引号风格 |
| `semicolons` | `boolean` | `false` | 生成代码是否加分号 |
| `enableRouteTreeFormatting` | `boolean` | `false` | 用 prettier 格式化路由树 |
| `disableLogging` | `boolean` | `false` | 关闭生成器自身日志 |
| `generator` | `Partial<Config>` | — | 透传给 `@tanstack/router-generator` 的高级配置（`indexToken` / `routeToken` / `virtualRouteConfig` 等） |

## 代码分割的行为与边界（请读）

### 仅在 `build` 阶段分割，`dev` 阶段内联

这是 Nasti 架构决定的，并非偷懒：

- Nasti 的 dev server 在把模块交给插件 `transform` 之前**就剥掉了 URL 上的 query**（`resolveUrlToFile` / 传给 `pluginContainer.transform` 的是纯文件路径），因此插件在 dev 下**无法**用 `?tsr-split=component` 这类 query 寻址「只含组件」的虚拟模块。
- 而 build 把插件直接挂成 Rolldown 插件，Rolldown 原生把带 query 的 id 当独立模块，`resolveId`/`load` 能接管 —— 分割链路成立。
- 好在 dev 是 native ESM 逐模块加载、本就不打包，分不分割对开发体验没有影响。

所以：**`dev` 路由组件内联（行为正确，HMR 正常），`build` 自动切 chunk。**

### 默认分组

对齐官方默认：`component`、`errorComponent`、`notFoundComponent` **各自**一个 chunk；`loader` 等留在主包。

### 保守正确：宁可不分割，也不产出错误代码

手写的分割器用 [oxc](https://oxc.rs) 做静态分析，遇到下列情况会**跳过该路由**（组件留在主包）并打印一条提示，而不是冒险产出可能出错的拆分：

- 某个被组件用到的**非导出模块级绑定**，同时也被**非分割代码**（如 `loader`）使用 —— 可能是共享的模块级状态，拆开会变成两份实例。
- 某个仅被组件使用的模块级绑定，其声明带有**副作用初始化**（如 `const x = createThing()`）—— 复制进 chunk 会执行两次副作用。

被组件用到的 **import** 和**导出的绑定**（如路由自身的 `Route`）不受此限：前者在拆分模块里重新 import，后者从原始路由文件 import 回来（单实例，安全）。

> 这意味着把组件函数写成**不导出**、且不与 `loader` 共享可变模块级状态时，能获得最佳分割效果 —— 这也正是 TanStack 官方推荐的写法。

## 示例

`examples/basic` 是一个可运行的最小示例（Home / About / 根布局三条路由）：

```bash
nasti build examples/basic   # 生成 routeTree.gen.ts，并把各路由组件切成独立 chunk
nasti dev   examples/basic   # 路由树随文件变化自动重生，组件内联
```

## 工作原理

- **路由树**：在 `configResolved` 首次调用官方 `Generator.run()`；dev 下在 `configureServer` 里挂到 `server.watcher`，文件增删改时增量 `run({ type, path })`，仅当树文件内容变化时触发整页刷新（生成器内置 `writeIfDifferent`，天然避免「写盘→触发 watcher→再写」的死循环）。
- **代码分割**（build）：
  - `transform` 把路由文件改写为「引用模块」：`component: lazyRouteComponent(() => import('./x.tsx?tsr-split=component'), 'component')`，并注入 `lazyRouteComponent` import 与 importer 常量；原组件函数失去引用，被 Rolldown tree-shake 出引用模块。
  - `resolveId` / `load` 接管 `?tsr-split=<prop>` 虚拟模块：读取原始路由文件，抽取该 prop 的值及其依赖（imports / 导出绑定 / 可移动的本地声明），用 oxc 转译后产出一个只 `export const <prop> = …` 的精简模块 —— 由 Rolldown 切成独立 chunk。

## License

[MIT](./LICENSE)
