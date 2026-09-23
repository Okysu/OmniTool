import { promptForConfirmation } from '@/core/ui/prompt'

/** URL has already canonicalized decimal/octal/short IPv4 and compressed IPv6. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host.startsWith('[')) {
    const ip = host.slice(1, -1)
    // Only global-unicast IPv6 is eligible; mapped IPv4, link-local, ULA,
    // multicast, unspecified and loopback addresses are not public destinations.
    return !/^[23][0-9a-f]{3}:/.test(ip) || /^2001:(?:0:|db8:)/.test(ip) || ip.startsWith('2002:')
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19))
  }
  return !host.includes('.')
}

// Lifetime is one sandbox, not the plugin id: updates/reinstalls must ask again.
const approvals = new WeakMap<object, Map<string, Promise<boolean>>>()

export async function authorizeNetwork(
  scope: object, pluginName: string, url: URL, allowLocalNetwork: boolean, signal?: AbortSignal,
): Promise<void> {
  if (url.username || url.password) throw new Error("网络地址不能包含用户名或密码")
  if (!allowLocalNetwork && (isPrivateHost(url.hostname) || url.origin === location.origin)) {
    throw new Error("已阻止插件访问本机/内网地址。如确需放行，请在「设置 › 安全」中开启。")
  }
  signal?.throwIfAborted()
  let origins = approvals.get(scope)
  if (!origins) approvals.set(scope, origins = new Map())
  let approval = origins.get(url.origin)
  if (!approval) {
    approval = promptForConfirmation({
      title: "允许插件访问网络？",
      message: `插件「${pluginName}」请求访问 ${url.origin}`,
      detail: "此授权允许在本次插件会话中向该来源发送数据（包括输入文件）。浏览器无法验证域名是否解析到内网；只允许你信任的服务。重定向将被阻止。",
      confirmLabel: "允许此来源",
    })
    origins.set(url.origin, approval)
  }
  const accepted = await approval
  signal?.throwIfAborted()
  if (!accepted) throw new Error("用户拒绝了此插件的网络请求")
}
