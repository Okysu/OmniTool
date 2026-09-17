import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

/**
 * Hash history on purpose: the app is meant to be opened straight from disk or
 * dropped behind any static host without server rewrite rules.
 */
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: () => import('@/views/HomeView.vue') },
  { path: '/t/:pluginId/:toolId', name: 'tool', component: () => import('@/views/ToolView.vue'), props: true },
  { path: '/files', name: 'files', component: () => import('@/views/FilesView.vue') },
  { path: '/flows', name: 'flows', component: () => import('@/views/PipelinesView.vue') },
  // A workflow used like a tool - what a pinned workflow opens.
  { path: '/flows/:id', name: 'flow-run', component: () => import('@/views/PipelineRunView.vue'), props: true },
  // The editor is full-screen like the tutorial: the flowchart needs the room.
  { path: '/flows/:id/edit', name: 'flow-edit', component: () => import('@/views/PipelineEditorView.vue'), props: true, meta: { layout: 'standalone' } },
  { path: '/plugins', name: 'plugins', component: () => import('@/views/PluginsView.vue') },
  // The editor pulls in Monaco, so it stays in its own lazily loaded chunk.
  { path: '/plugins/new', name: 'plugin-new', component: () => import('@/views/PluginEditorView.vue') },
  { path: '/plugins/edit/:pluginId', name: 'plugin-edit', component: () => import('@/views/PluginEditorView.vue') },
  { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
  // Pulls in Monaco and markdown-it, so it is its own chunk like the editor.
  // A standalone page: no sidebar, top bar or task queue (see App.vue).
  { path: '/learn/:lessonId?', name: 'learn', component: () => import('@/views/LearnView.vue'), props: true, meta: { layout: 'standalone' } },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})
