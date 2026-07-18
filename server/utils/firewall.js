/**
 * 防火墙封禁（内核层丢包）
 *
 * 应用层只负责"判定要封哪个 IP"；真正的拦截下沉到内核 ipset + iptables：
 * 被封 IP 的数据包在 INPUT 链直接 DROP，根本不会到达 Node，真正零消耗。
 *
 * 设计要点：
 * - 用裸 ipset(xhs_blocklist) + 一条 iptables INPUT DROP 规则，不动 firewalld、不 reload，
 *   避免影响同机的 Docker/nginx/其它服务。
 * - DROP 之上放行 SSH(22)，即使误把自己 IP 封了也能 SSH 进来解封，永不自锁。
 * - 规则是运行时的（重启/防火墙reload会丢），靠应用启动时 syncFromBlacklist 从 DB 自愈重建。
 * - 一切失败都静默（防火墙问题绝不能影响主业务）；只接受合法公网 IPv4，杜绝命令注入与误封内网/环回。
 */

const { execFile } = require('child_process');
const os = require('os');
const config = require('../config');

const IPSET_BIN = '/usr/sbin/ipset';
const IPTABLES_BIN = '/usr/sbin/iptables';
const IPSET_NAME = 'xhs_blocklist';

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// 永不封禁的 IP 白名单：本机所有网卡 IP（含内网）+ 环回 + config 显式配置（本服务器公网 IP）。
// 同机平台调用本接口时来源 IP 可能是环回、内网网卡 IP 或公网 IP，全部豁免，绝不封自己。
const IP_WHITELIST = new Set([
  '127.0.0.1', '::1',
  ...(config.IP_BLOCK_WHITELIST || [])
]);
try {
  for (const addrs of Object.values(os.networkInterfaces() || {})) {
    for (const a of addrs || []) {
      if (a && a.address) IP_WHITELIST.add(a.address);
    }
  }
} catch (_) {}

function isWhitelisted(ip) {
  return !!ip && IP_WHITELIST.has(ip);
}

// 仅允许"合法公网 IPv4"：排除环回/私网/链路本地，避免误封自身或内网
function isSafePublicIpv4(ip) {
  const m = IPV4_RE.exec(ip || '');
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some(x => x > 255)) return false;
  if (o[0] === 0 || o[0] === 127) return false;              // 0.x / 环回
  if (o[0] === 10) return false;                              // 私网 A
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false; // 私网 B
  if (o[0] === 192 && o[1] === 168) return false;             // 私网 C
  if (o[0] === 169 && o[1] === 254) return false;             // 链路本地
  return true;
}

function run(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, err: ((stderr || err.message) || '').toString().trim() });
      else resolve({ ok: true });
    });
  });
}

// 确保 ipset 集合与 iptables 规则存在（幂等）：DROP 规则 + 其上的 SSH(22) 放行
async function ensureFirewall() {
  await run(IPSET_BIN, ['create', IPSET_NAME, 'hash:ip', '-exist']);
  const matchDrop = ['INPUT', '-m', 'set', '--match-set', IPSET_NAME, 'src', '-j', 'DROP'];
  const matchSsh = ['INPUT', '-m', 'set', '--match-set', IPSET_NAME, 'src', '-p', 'tcp', '--dport', '22', '-j', 'ACCEPT'];
  const hasDrop = await run(IPTABLES_BIN, ['-C', ...matchDrop]);
  const hasSsh = await run(IPTABLES_BIN, ['-C', ...matchSsh]);
  // 先插 DROP，再插 SSH 放行（-I 头插，使 SSH 放行最终位于 DROP 之上，先匹配）
  if (!hasDrop.ok) await run(IPTABLES_BIN, ['-I', ...matchDrop]);
  if (!hasSsh.ok) await run(IPTABLES_BIN, ['-I', ...matchSsh]);
}

// 把一个 IP 加入内核封禁集合（立即生效）
async function firewallBlockIp(ip) {
  if (isWhitelisted(ip)) { console.warn(`[防火墙] 跳过白名单IP（本机/平台）: ${ip}`); return false; }
  if (!isSafePublicIpv4(ip)) return false;
  const r = await run(IPSET_BIN, ['add', IPSET_NAME, ip, '-exist']);
  if (!r.ok) console.error(`[防火墙] 加入封禁集合失败 ${ip}: ${r.err}`);
  return r.ok;
}

// 从内核封禁集合移除一个 IP（解封）
async function firewallUnblockIp(ip) {
  if (!IPV4_RE.test(ip || '')) return false;
  await run(IPSET_BIN, ['del', IPSET_NAME, ip]); // 不存在也无所谓
  return true;
}

// 启动时自愈：确保规则存在，并把 DB 里仍封禁的 IP 全部重新灌入集合
async function syncFirewallFromBlacklist(ipBlacklist) {
  try {
    await ensureFirewall();
    let n = 0;
    for (const [ip, info] of Object.entries(ipBlacklist || {})) {
      if (info && info.blocked && !isWhitelisted(ip) && isSafePublicIpv4(ip)) {
        const r = await run(IPSET_BIN, ['add', IPSET_NAME, ip, '-exist']);
        if (r.ok) n++;
      }
    }
    console.log(`[防火墙] 自愈完成：已同步 ${n} 个封禁IP到内核集合 ${IPSET_NAME}`);
    return n;
  } catch (e) {
    console.error(`[防火墙] 启动自愈失败: ${e.message}`);
    return 0;
  }
}

module.exports = {
  IPSET_NAME,
  isSafePublicIpv4,
  isWhitelisted,
  ensureFirewall,
  firewallBlockIp,
  firewallUnblockIp,
  syncFirewallFromBlacklist
};
