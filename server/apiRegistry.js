/**
 * 接口集中注册表（新增接口的唯一入口）
 * ============================================================
 * 在本文件 ENDPOINTS 里加一条声明，即可自动完成：
 *   1) 对外路由 /api/<type>           （userApi.js 自动注册）
 *   2) 计费价格                        （合并进 config.DEFAULT_PRICES）
 *   3) 后台接口列表/定价/频率/统计下拉  （合并进 adminApi 的 ENDPOINT_META）
 *   4) 上游请求/响应适配              （按 upstream 字段走对应适配器）
 *
 * 现有 13 个老接口仍在 userApi.js / config.js 中硬编码，不在此表内，互不影响。
 * 新接口（含 Matcha）统一写在这里。
 *
 * ---------------- 字段说明 ----------------
 *   type       对外接口名，决定 URL（/api/<type>）与计费 key，必须全局唯一
 *   name       中文全称（后台/文档展示）
 *   shortName  简称（图表用）
 *   price      单价（元/次）
 *   method     客户调用方式 'GET' | 'POST'
 *   upstream   走哪个上游：'matcha' | 'xingyin' | 'tikhub' | 'datadrifter'（对应 config.UPSTREAMS 的 key；
 *              datadrifter 内部是小红书 V5/V4 两版 APP 接口，具体版本看 path）
 *   apiId      仅 upstream==='matcha' 时必填：Matcha 的 api_id
 *   path       upstream==='xingyin' / 'tikhub' / 'datadrifter' 时必填：上游路径，如 '/xhsapi/note'；TikHub 也可写完整 URL
 *   unwrap     可选 (data)=>业务核心：仅 upstream==='datadrifter' 用。V5 各接口包装层级不一，
 *              用它把外层 data 剥到业务核心（如详情升级版 d=>d.data.result.data），保证与同构接口返回一致
 *   chain      可选，多上游候选链（故障切换）。声明后走 userApi.sendChainRequest，忽略单上游派发。
 *              数组元素：{ upstream, path/apiId, mapParams, extractCore, timeoutMs?, unitCost?, supports? }
 *                supports(input) 可选：候选是否支持本次请求的参数组合，返回 false 直接跳过该候选
 *                （如 Matcha 搜索不支持时间筛选，带 filterNoteTime 的请求不进它）
 *                extractCore(上游原始响应) => { ok, core, msg?, raw? }：ok=false 表示上游失败（切下一候选）；
 *                ok=true 且 core 为空 = 资源不存在（确定性结论：直接 404 且照常计费，不切换）；
 *                raw 为可选的原始载荷（星河透传字符串用）。unitCost 是该上游接口成本的出厂默认值，
 *                实际记账单价以后台「系统设置 → 上游接口成本」表为准（可覆盖）；>0 时也作为
 *                "资源不存在也计费"的触发标记（上游对"查了但没有"同样收我们的钱）。
 *              切换条件：网络错误/超时/上游失败 → 下一候选；候选连续失败3次熔断跳过60秒。
 *   shapeData  可选 (core, raw)=>data：chain 专用，把核心数据包装成该接口对客户的既有格式（保证契约不变）
 *   params     参数声明数组：[{ name, required, desc, pattern?, patternDesc? }]，name 是“客户传入”的字段名
 *              pattern 为可选正则，格式不符直接 400（且自动退费），patternDesc 是给客户的格式说明
 *   oneOfRequired 可选参数名数组：数组内至少传一个，例如 ['user_id', 'keyword']
 *   mapParams  可选 (input)=>({上游参数})：把客户参数映射成上游参数。
 *              不写则默认按 params 里的 name 原样透传给上游。
 *
 * ---------------- 示例（Matcha 小红书商品详情，api_id=7）----------------
 *   {
 *     type: 'xhs_goods_detail_web', name: '小红书商品详情', shortName: '商品详情',
 *     price: 0.06, method: 'GET', upstream: 'matcha', apiId: '7',
 *     params: [{ name: 'goods_id', required: true, desc: '商品ID或商品短链' }],
 *     // 客户字段名与 Matcha 一致，无需 mapParams
 *   }
 *
 * ---------------- 示例（客户字段名与上游不同，用 mapParams）----------------
 *   {
 *     type: 'xhs_note_detail_v2', name: '小红书笔记详情', shortName: '笔记详情',
 *     price: 0.04, method: 'GET', upstream: 'matcha', apiId: '10',
 *     params: [{ name: 'note_id', required: true, desc: '笔记ID' }],
 *     mapParams: (q) => ({ noteid: q.note_id }),  // 客户传 note_id → Matcha 要 noteid
 *   }
 */

// 笔记"墓碑"判定：笔记已删除/被屏蔽时，上游仍返回 200 成功，但 note_list 是占位符
// （model_type:'error'，text:"当前内容无法展示"，无 user 节）。视为笔记不存在：
// 404 + 照常计费 + 不切换（内容在小红书侧已没了，换哪家上游都拿不到）。三家 APP 协议同源，判定通用。
// 评论翻页游标归一化：整串 JSON 游标 → 内层 hex；已是 hex / 解析失败则原样返回
function normalizeCommentCursor(v) {
  if (typeof v !== 'string' || !v.trim().startsWith('{')) return v;
  try {
    const o = JSON.parse(v);
    if (o && typeof o.cursor === 'string') return o.cursor;
  } catch (_) {}
  return v;
}

function isNoteTombstone(core) {
  if (!Array.isArray(core)) return false;
  return core.some(it => (it && Array.isArray(it.note_list) ? it.note_list : [])
    .some(n => n && n.model_type === 'error'));
}

// 视频笔记详情链的核心是单个笔记对象（非上面的 [{note_list}] 包一层结构），墓碑判定直接看 model_type。
function isVideoNoteTombstone(core) {
  return !!(core && core.model_type === 'error');
}

// 蒲公英（pgy_api/*，2026-07-12 接入，同 datadrifter 账号同服务器）比其余 V5 接口多包一层：
// buildV5Response 已剥到 d.data = {code:0, msg, guid, success, data:{...真实业务数据}}，这里再剥一层拿到真实数据。
// 失败时上游走的是另一套信封（{code:"500", message, data:{}}），success 判定在 buildV5Response 里已按外层 code!=200 处理，不会走到这个 unwrap。
const _pgyUnwrap = (d) => (d && d.data) || null;

// ==================== 笔记详情多上游候选链（V5 → 星河 → Matcha） ====================
// 三家核心数据同构：[{user, note_list, comment_list}]，note_list 60 字段逐键一致（2026-07-02 实测同一笔记验证）。
// extractCore 把各家外壳剥到这个核心；接口层 shapeData 决定对客户的最终包装（保证既有契约不变）。
// 切换/计费规则见 userApi.sendChainRequest 与文件头 chain 字段说明。
const NOTE_DETAIL_CHAIN = [
  {
    // swagger 主力（2026-07-11 加，成本 0.008，全链最便宜）。data 直接是核心数组[{note_list,user,
    // comment_list,model_type,track_id}]，跟现有三家逐键同构（note对象60vs61键仅3个边缘字段差异，
    // user对象13键完全一致），不用转换。node_type(images/video) 是供应商 API 文档里原生就这么拼的
    // 参数名，客户端契约沿用同名透传即可。
    upstream: 'swagger', path: '/api/v1/detail', unitCost: 0.008,
    mapParams: (q) => ({ note_id: q.note_id, node_type: q.node_type || 'images' }),
    extractCore: (outer) => {
      const o = outer || {};
      if (Number(o.code) !== 0) return { ok: false, msg: o.msg || o.message };
      return { ok: true, core: o.data };
    },
  },
  {
    // V5 笔记详情升级版（成本最低 0.025 元，swagger 挂时顶上）。正常 ~2s、偶发 10s+；
    // 链内单独压超时 20s（独立接口 get_note_detail_v5 仍是 60s），避免拖垮整条链。
    upstream: 'datadrifter', path: '/xhs_app_api/note_detail_sync_v5_upgrade', timeoutMs: 20000, unitCost: 0.025,
    mapParams: (q) => { const p = { note_id: q.note_id }; if (q.xsec_token) p.xsec_token = q.xsec_token; return p; },
    extractCore: (outer) => {
      const o = outer || {};
      if (Number(o.code) !== 200) return { ok: false, msg: o.msg || o.message };
      return { ok: true, core: (((o.data || {}).data || {}).result || {}).data };
    },
  },
  {
    // 星河 /xhsapi/note。10200=成功；body 是 JSON 字符串，解析后 {code, data, msg, success}。
    // raw 保留原始字符串：老接口 get_note_detail 由星河服务时原样透传，保证字节级契约不变。
    upstream: 'xingyin', path: '/xhsapi/note', unitCost: 0.04,
    mapParams: (q) => ({ noteId: q.note_id }),
    extractCore: (outer) => {
      const o = outer || {};
      if (Number(o.code) !== 10200) return { ok: false, msg: o.message };
      let obj = o.body;
      if (typeof obj === 'string') {
        try { obj = JSON.parse(obj); } catch (_) { return { ok: false, msg: '上游数据解析失败' }; }
      }
      // 星河明确回了"没拿到"（success=false）→ 视为笔记不存在（确定性结论）
      if (!obj || obj.success === false) return { ok: true, core: null };
      return { ok: true, core: obj.data, raw: typeof o.body === 'string' ? o.body : undefined };
    },
  },
  {
    // Matcha APP端 api_id=102（原 get_note_detail_v1 的主上游，现为兜底）。code=200 时 data 即核心数组。
    upstream: 'matcha', apiId: '102', unitCost: 0.04,
    mapParams: (q) => { const p = { note_id: q.note_id }; if (q.node_type) p.node_type = q.node_type; return p; },
    extractCore: (outer) => {
      const o = outer || {};
      if (Number(o.code) !== 200) return { ok: false, msg: o.msg || o.message };
      return { ok: true, core: o.data };
    },
  },
];

// ==================== 视频笔记详情多上游候选链（Swagger → datadrifter V4 → 星河） ====================
// 2026-07-07 实测（同一批真实视频 note_id）：
//   - datadrifter V1(video_note_detail_sync_v1)：3/3 全部 code:500，判定报废，不入链。
//   - datadrifter V2(video_note_detail_sync_v2)：3个真实视频里2个 500、1个"成功"但 data 为空对象，判定不可靠，不入链。
//   - datadrifter V4(note_detail_video_sync_v4)：3/3 全部成功，字段完整（含 video_info_v2.media.stream 真实播放地址）。
//   - 星河 /xhsapi/video_note：高频撞风控(10503)；唯一一次成功时对已确认是视频的笔记回了 type:"normal" 且无视频字段，
//     数据可信度存疑，但按用户要求仍作为 V4 失败时的兜底候选（成功率低于预期，留意后续 call_logs 里的切换记录）。
// 三家核心统一成"单个笔记对象"（而非笔记详情链的 [{note_list}] 包一层）：
//   Swagger 详情固定 node_type=video 后返回视频笔记数组，取与请求对应的第一条 data[0]；V4 的 data 本就是扁平数组，取 data[0]；
//   星河仍是老三家同构的 {comment_list, model_type, note_list:[note]}，剥到 note_list[0]。
// shapeData 统一包回星河原始契约壳 {code, data:[{comment_list, model_type, note_list:[note]}], msg, success}（JSON 字符串），
// 保证不管实际由谁服务，客户侧 JSON.parse 后结构不变（老接口 get_note_detail_video 的既有契约）。
const VIDEO_NOTE_DETAIL_CHAIN = [
  {
    // Swagger 与普通详情共用 /api/v1/detail；视频接口由后端固定补 node_type=video，客户只传 note_id。
    upstream: 'swagger', path: '/api/v1/detail', unitCost: 0.008,
    mapParams: (q) => ({ note_id: q.note_id, node_type: 'video' }),
    extractCore: (outer) => {
      const o = outer || {};
      if (Number(o.code) !== 0) return { ok: false, msg: o.msg || o.message };
      if (!Array.isArray(o.data)) return { ok: false, msg: '上游返回结构异常' };
      return { ok: true, core: o.data[0] || null };
    },
  },
  {
    // datadrifter 视频笔记详情 V4（主力，同账号成本 0.025）。
    upstream: 'datadrifter', path: '/xhs_app_api/note_detail_video_sync_v4', timeoutMs: 20000, unitCost: 0.025,
    mapParams: (q) => ({ note_id: q.note_id }),
    extractCore: (outer) => {
      const o = outer || {};
      if (Number(o.code) !== 0 || !Array.isArray(o.data)) return { ok: false, msg: o.msg || o.message };
      return { ok: true, core: o.data[0] || null };
    },
  },
  {
    // 星河 /xhsapi/video_note（兜底）。10200=成功；body 为 JSON 字符串，解析后剥到 note_list[0]。
    upstream: 'xingyin', path: '/xhsapi/video_note', unitCost: 0.03,
    mapParams: (q) => ({ noteId: q.note_id }),
    extractCore: (outer) => {
      const o = outer || {};
      if (Number(o.code) !== 10200) return { ok: false, msg: o.message };
      let obj = o.body;
      if (typeof obj === 'string') {
        try { obj = JSON.parse(obj); } catch (_) { return { ok: false, msg: '上游数据解析失败' }; }
      }
      if (!obj || obj.success === false) return { ok: true, core: null };
      const note = (((obj.data || [])[0] || {}).note_list || [])[0];
      return { ok: true, core: note || null, raw: typeof o.body === 'string' ? o.body : undefined };
    },
  },
];

// ==================== 用户信息多上游候选链（V5 → 星河 → Matcha） ====================
// 三家核心同构：扁平用户对象（nickname/red_id/性别/简介/各统计数，2026-07-02 同一用户实测）。
// V5 63键为另两家67键的严格子集（Matcha/星河多 block_view_from_user/block_view_to_user/
// mute_view_to_user/real_name_info 4个字段，V5 服务时这4个字段缺失）。
// "用户不存在"在三家都表现为上游错误（V5 code:"500"、Matcha code:-1，均不扣我们的钱），
// 没有"空成功"信号 → 走切换→全失败→客户退费；核心为空的兜底仍走 404+计费。
const USER_INFO_CHAIN = [
  {
    // swagger 主力（2026-07-11 加，成本 0.008）：扁平用户对象，实测65vs64键仅3个边缘字段差异，
    // 不用转换直接透传。user_id 支持24位真实ID和29位评论区脱敏ID两种输入。
    upstream: 'swagger', path: '/api/v1/user_info', unitCost: 0.008,
    mapParams: (q) => ({ user_id: q.user_id }),
    extractCore: (outer) => {
      const o = outer || {};
      if (Number(o.code) !== 0) return { ok: false, msg: o.msg || o.message };
      return { ok: true, core: o.data };
    },
  },
  {
    // V5 user_info_sync_v4（成本 0.025，swagger 挂时顶上）。成功约定 code:0 + success:true（与笔记详情的 200 不同）
    upstream: 'datadrifter', path: '/xhs_app_api/user_info_sync_v4', timeoutMs: 20000, unitCost: 0.025,
    mapParams: (q) => ({ userid: q.user_id }),
    extractCore: (outer) => {
      const o = outer || {};
      const code = Number(o.code);
      if (!(code === 0 || code === 200) || o.success === false) return { ok: false, msg: o.msg || o.message };
      return { ok: true, core: o.data };
    },
  },
  {
    // 星河 /xhsapi/v2/app_user_info。10200=成功；body 为 JSON 字符串 {code, data, msg, success}，
    // raw 保留原始字符串供老接口 get_user_info 原样透传
    upstream: 'xingyin', path: '/xhsapi/v2/app_user_info', unitCost: 0.04,
    mapParams: (q) => ({ userId: q.user_id }),
    extractCore: (outer) => {
      const o = outer || {};
      if (Number(o.code) !== 10200) return { ok: false, msg: o.message };
      let obj = o.body;
      if (typeof obj === 'string') {
        try { obj = JSON.parse(obj); } catch (_) { return { ok: false, msg: '上游数据解析失败' }; }
      }
      if (!obj || obj.success === false) return { ok: true, core: null };
      return { ok: true, core: obj.data, raw: typeof o.body === 'string' ? o.body : undefined };
    },
  },
  {
    // Matcha APP端 api_id=106（原 get_user_info_v1 主上游，现为兜底）。code=200 时 data 即用户对象
    upstream: 'matcha', apiId: '106', unitCost: 0.04,
    mapParams: (q) => ({ user_id: q.user_id }),
    extractCore: (outer) => {
      const o = outer || {};
      if (Number(o.code) !== 200) return { ok: false, msg: o.msg || o.message };
      return { ok: true, core: o.data };
    },
  },
];

// ==================== 用户笔记列表多上游候选链（V5 → 星河 → Matcha） ====================
// 契约（v1/老接口一致）：core = { notes:[笔记项], tags:[], has_more }，翻页游标在笔记项的 cursor 字段，
// 客户翻页传上页最后一条的 cursor。三家笔记项同族（2026-07-02 实测：V5 31键 ⊃ Matcha 29键，
// 仅多 ip_location/video_preview_type 两个增量字段）；V5 也支持 cursor 翻页（实测跨页零重复）。
// V5 原始载荷是 {list, cursor, has_more, page, total_pages}，extractCore 归一化成 {notes, tags, has_more}。
// 星河内层结构未能实测（该接口当前对所有 IP 持续 10503），按同协议假定，extractCore 做结构校验：
// 不含 notes 数组就按失败处理切下一家，绝不把异常结构吐给客户。
// 注意：零笔记用户返回 {notes:[], has_more:false} 是合法成功（照常计费），不是"不存在"。
const USER_NOTE_LIST_CHAIN = [
  {
    // swagger 主力（2026-07-11 加，成本 0.008）：data 原生就是 {notes, tags, has_more}，跟本链契约
    // 逐键一致，不用转换。cursor 直接透传（swagger 自己的翻页游标格式）。
    upstream: 'swagger', path: '/api/v1/user_post', unitCost: 0.008,
    mapParams: (q) => { const p = { user_id: q.user_id }; if (q.cursor) p.cursor = q.cursor; return p; },
    extractCore: (outer) => {
      const o = outer || {};
      if (Number(o.code) !== 0) return { ok: false, msg: o.msg || o.message };
      const d = o.data || {};
      if (!Array.isArray(d.notes)) return { ok: false, msg: '上游返回结构异常' };
      return { ok: true, core: d };
    },
  },
  {
    // V5 user_posted_sync_v5（成本 0.025，swagger 挂时顶上）。首页传 page:1，翻页传 cursor
    upstream: 'datadrifter', path: '/xhs_app_api/user_posted_sync_v5', timeoutMs: 20000, unitCost: 0.025,
    mapParams: (q) => q.cursor ? { user_id: q.user_id, cursor: q.cursor } : { user_id: q.user_id, page: 1 },
    extractCore: (outer) => {
      const o = outer || {};
      if (Number(o.code) !== 200) return { ok: false, msg: o.msg || o.message };
      const d = o.data || {};
      if (!Array.isArray(d.list)) return { ok: false, msg: '上游返回结构异常' };
      return { ok: true, core: { notes: d.list, tags: Array.isArray(d.tags) ? d.tags : [], has_more: !!d.has_more } };
    },
  },
  {
    // 星河 /xhsapi/v2/app_user_posted。10200=成功；body 为 JSON 字符串，内层 data 应为 {notes, tags, has_more}
    upstream: 'xingyin', path: '/xhsapi/v2/app_user_posted', unitCost: 0.04,
    mapParams: (q) => ({ userId: q.user_id, cursor: q.cursor || '' }),
    extractCore: (outer) => {
      const o = outer || {};
      if (Number(o.code) !== 10200) return { ok: false, msg: o.message };
      let obj = o.body;
      if (typeof obj === 'string') {
        try { obj = JSON.parse(obj); } catch (_) { return { ok: false, msg: '上游数据解析失败' }; }
      }
      if (!obj || obj.success === false) return { ok: true, core: null };
      const d = obj.data;
      if (!d || !Array.isArray(d.notes)) return { ok: false, msg: '上游返回结构异常' };
      return { ok: true, core: d, raw: typeof o.body === 'string' ? o.body : undefined };
    },
  },
  {
    // Matcha APP端 api_id=105（原 user_note_list_v1 主上游，现为兜底）。data = {notes, tags, has_more}
    upstream: 'matcha', apiId: '105', unitCost: 0.04,
    mapParams: (q) => { const p = { user_id: q.user_id }; if (q.cursor) p.cursor = q.cursor; return p; },
    extractCore: (outer) => {
      const o = outer || {};
      if (Number(o.code) !== 200) return { ok: false, msg: o.msg || o.message };
      const d = o.data;
      if (!d || !Array.isArray(d.notes)) return { ok: false, msg: '上游返回结构异常' };
      return { ok: true, core: d };
    },
  },
];

// ==================== 话题笔记候选链（V5 → V4，2026-07-10 加）====================
// 星河老接口(/xhsapi/tag_notes)排除在外：连续测试全部撞风控(10503)拿不到一次成功响应，且它的翻页
// 参数(last_note_ct/last_note_id/cursor_score/session_id 四个字段一起用)结构未知、无法安全验证，
// 贸然接入翻页很可能是错的还不容易发现——所以只在 datadrifter 自己的 V5/V4 两个版本间做候选，不碰星河。
// V5(topic_sync_v5) 结构干净：data.list[] + data.cursor(简单字符串) + data.has_more，user 是 userid/images。
// V4(topic_feed_sync_v4) 结构不同：data.items[] + data.has_more，但【没有】统一的 data.cursor——翻页要用
// 每条 item 自带的 cursor_score/id(=last_note_id)/create_time(=last_note_ct) 三个字段一起拼，缺一不可
// （实测：只传 cursor_score+last_note_id 会 500 失败；last_note_ct 还必须是字符串，传数字会 422，
// 传毫秒时间戳字符串才对——这三点都是实测踩出来的，文档没写清楚）。user 字段也不同名，是 user_id/avatar_url。
// 用 C端契约统一成 V5 的样子：extractCore 把 V4 的 items 桥接成 list，user 字段名对齐(userid/images)，
// 并把 V4 的翻页三要素编码成一个 JSON 字符串塞进 core.cursor（打上 v4:true 标记）；mapParams 侧识别到这个
// 标记就拆包还原成 cursor_score/last_note_id/last_note_ct 喂给 V4。局限：如果翻页途中从 V5 切到 V4（游标
// 是 V5 原生不透明字符串，不是我们打的 v4 标记），没法转换会从第一页重新翻——这是已知且可接受的降级，
// 不会返回错数据。
// 2026-07-10 补充：光统一 list/cursor/has_more 骨架 + user 核心字段还不够——实测同一话题下 V5/V4
// 逐条笔记对比，两家字段集合只有8个共有(create_time/desc/id/images_list/title/type/user/video_info)，
// V5独有12个(likes/collects/collected_count/video_id/deeplink/...)，V4独有7个(interaction_info/
// hash_tags/note_time/share_info/...)——点赞数这种客户大概率要用的字段，V5是平铺的`likes`，V4却
// 藏在`interaction_info.like_count`里，字段名对不上。这里把V4的互动数据别名成V5风格的平铺字段：
// likes/collects/collected_count/inlikes 对应V5同名字段；comment_count/share_count 是V5压根没有
// 的新增数据，V4候选服务时客户能多拿到，V5服务时没有（如实反映，不伪造成0）。
const _aliasV4TopicItemFields = (items) => {
  if (!Array.isArray(items)) return;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const u = it.user;
    if (u && typeof u === 'object') {
      if (u.userid == null && u.user_id != null) u.userid = u.user_id;
      if (u.images == null && u.avatar_url != null) u.images = u.avatar_url;
    }
    const inter = it.interaction_info;
    if (inter && typeof inter === 'object') {
      if (it.likes == null && inter.like_count != null) it.likes = inter.like_count;
      if (it.collects == null && inter.collect_count != null) it.collects = inter.collect_count;
      if (it.collected_count == null && inter.collect_count != null) it.collected_count = inter.collect_count;
      if (it.inlikes == null && inter.liked != null) it.inlikes = inter.liked;
      if (it.comment_count == null && inter.comment_count != null) it.comment_count = inter.comment_count;
      if (it.share_count == null && inter.share_count != null) it.share_count = inter.share_count;
    }
    // V5 没有话题标签数据，这里不伪造；V5 那边补的是空数组占位（见下方 V5 candidate 的 extractCore）
    if (it.hash_tags == null) it.hash_tags = [];
  }
};
// V5 原生没有 hash_tags/comment_count/share_count，占位补齐字段存在性（不伪造数值，只有 hash_tags
// 给空数组占位——因为它是"列表"语义，空数组=没有标签，跟"没这个字段"客户端代码处理起来是一回事；
// comment_count/share_count 是"数字"语义，补 0 会被误读成"真的是0"，这两个就不补，如实缺失）
const _padV5TopicItemFields = (items) => {
  if (!Array.isArray(items)) return;
  for (const it of items) {
    if (it && typeof it === 'object' && it.hash_tags == null) it.hash_tags = [];
  }
};
const _extractV4TopicCore = (outer) => {
  const o = outer || {};
  const code = Number(o.code);
  if (!(code === 0 && o.success !== false)) return { ok: false, msg: o.msg || o.message };
  const d = o.data || {};
  const items = Array.isArray(d.items) ? d.items : [];
  _aliasV4TopicItemFields(items);
  const last = items[items.length - 1];
  const cursor = last ? JSON.stringify({
    v4: true,
    cursor_score: last.cursor_score || '',
    last_note_id: last.id || '',
    last_note_ct: String(last.create_time || ''),
  }) : '';
  return { ok: true, core: { list: items, cursor, has_more: !!d.has_more } };
};
// 两个客户端接口共用这条链：tag_notes_v5 用 page_id，老接口 tag_notes 历史上用 pageId(驼峰)——
// mapParams 里两个都认，任一个传了都能用，不用在链外面再包一层归一化。
// 2026-07-10：V4 改为首选——虽然实测没有V5稳（会500），但数据更完整（desc正文内容/互动数据V5基本没有），
// 优先给客户更全的数据，V4 真挂了再落到V5兜底（不是没有数据，是没有desc/comment_count等这几个字段）。
const TAG_NOTES_CHAIN = [
  {
    // datadrifter V4（首选，成本 0.025）：数据比V5完整（desc/hash_tags/interaction_info齐全），代价是不如V5稳
    upstream: 'datadrifter', path: '/xhs_app_api/topic_feed_sync_v4', timeoutMs: 20000, unitCost: 0.025,
    mapParams: (q) => {
      const p = { page_id: q.page_id || q.pageId, sort: q.sort === 'time' ? 'time' : 'trend' };
      if (q.cursor) {
        try {
          const parsed = JSON.parse(q.cursor);
          if (parsed && parsed.v4) {
            if (parsed.cursor_score) p.cursor_score = parsed.cursor_score;
            if (parsed.last_note_id) p.last_note_id = parsed.last_note_id;
            if (parsed.last_note_ct) p.last_note_ct = String(parsed.last_note_ct);
          }
          // 非 v4 标记（如 V5 原生游标字符串）：转换不了，忽略，V4 从第一页开始翻——已知降级，不返回错数据
        } catch (_) { /* 不是 JSON，同样忽略 */ }
      }
      return p;
    },
    extractCore: _extractV4TopicCore,
  },
  {
    // datadrifter V5 兜底（成本 0.025）：V4 挂时顶上，数据完整度不如V4（没有desc/comment_count等）但更稳。
    // sort 词表：hot/time，跟客户参数一致直接透传
    upstream: 'datadrifter', path: '/xhs_app_api/topic_sync_v5', timeoutMs: 20000, unitCost: 0.025,
    mapParams: (q) => {
      const p = { page_id: q.page_id || q.pageId };
      if (q.sort) p.sort = q.sort;
      if (q.cursor) {
        // 客户上一页可能是V4served的，游标是v4标记的JSON串，V5认不了——跳过，从第一页开始翻（已知降级）
        let isV4Cursor = false;
        try { const parsed = JSON.parse(q.cursor); isV4Cursor = !!(parsed && parsed.v4); } catch (_) { /* 不是JSON，当V5原生游标 */ }
        if (!isV4Cursor) p.cursor = q.cursor;
      }
      return p;
    },
    extractCore: (outer) => {
      const o = outer || {};
      if (Number(o.code) !== 200) return { ok: false, msg: o.msg || o.message };
      const d = o.data || {};
      if (!Array.isArray(d.list)) return { ok: false, msg: '上游返回结构异常' };
      _padV5TopicItemFields(d.list);
      return { ok: true, core: d };
    },
  },
];

// ==================== 笔记搜索多上游候选链（V5 → 星河 → Matcha101） ====================
// 三家载荷同一 APP 协议（data.items[{model_type,note}] + search_request_id，note 字段 2026-07-03 实测逐键一致）。
// 【C端契约不变】老接口 search_note 与 v1 的客户参数原样保留，两套命名（sortType/filterNoteType vs
// sort/note_type）在这里统一读入，再按各上游的词表映射：
//   排序: 客户传英文枚举(general/time_descending/popularity_descending/comment_descending/collect_descending)
//         → V5 要中文(综合/最新/最多点赞/最多评论/最多收藏)，星河/Matcha 原样
//   笔记类型: 老接口中文(视频笔记/普通笔记，与V5词表相同)，v1 英文(video/image) → 互相映射
//   时间筛选: 仅老接口有；V5 无"半年内"档→放宽映射为"一年内"；Matcha 101 不支持时间筛选，
//             带 filterNoteTime 的请求经 supports() 直接跳过 Matcha 候选（不返回未过滤的结果）
//   翻页: V5 纯 page 翻页(实测跨页零重复)忽略令牌；searchId/sessionId(老)/search_id/session_id(v1) 原样传给星河/Matcha
// 2026-07-13 补：swagger /openapi.json 显示 sort 官方一共支持6个值，此前词表只收了5个，漏了"英文优先"
// （search_note_v5 独立端点的文档其实早就知道这第6个值，只是 v1/老接口这套英文枚举词表没跟上）。
const _SEARCH_SORT_EN2CN = { general: '综合', time_descending: '最新', popularity_descending: '最多点赞', comment_descending: '最多评论', collect_descending: '最多收藏', english_preferred: '英文优先' };
// 2026-07-13 补：核对 swagger 官方 /openapi.json 才发现 note_type 实际支持"不限/视频笔记/普通笔记/直播笔记"
// 4个值，此前词表只收了3个，客户传 live/直播笔记 时 cnType 查表落空、筛选条件被静默丢弃（不报错，只是没生效）。
const _SEARCH_TYPE_TO_CN = { video: '视频笔记', image: '普通笔记', live: '直播笔记', '视频笔记': '视频笔记', '普通笔记': '普通笔记', '直播笔记': '直播笔记', '不限': '不限' };
// Matcha（api_id=101）官方文档只写了 video/image 两个英文值，未证实支持直播笔记筛选，故不加 live 映射——
// 该候选在 mapParams 里查不到值就不传 note_type，等于对 live 请求返回未过滤结果，所以额外加 supports() 直接跳过。
const _SEARCH_TYPE_TO_EN = { '视频笔记': 'video', '普通笔记': 'image', video: 'video', image: 'image' };
const _V5_NOTE_TIME = new Set(['不限', '一天内', '一周内', '一个月内', '一年内']);

// 统一读客户参数（兼容老接口与 v1 两套命名，客户侧无感）
function searchInput(q) {
  return {
    keyword: q.keyword,
    page: q.page,
    pageSize: q.page_size || q.pageSize || '',
    sort: q.sort || q.sortType || '',
    noteType: q.note_type || q.filterNoteType || '',
    noteTime: q.note_time || q.filterNoteTime || '',
    noteRange: q.note_range || q.filterNoteRange || '',
    filterHot: q.filter_hot || '',
    searchId: q.search_id || q.searchId || '',
    sessionId: q.session_id || q.sessionId || ''
  };
}

// datadrifter（供应商侧是其 v4 版本接口 search_sync_v4，内部标识改叫 datadrifter 避免和 v5 候选混淆；
// 新增兜底，2026-07-06 实测：5/5 成功，含复现 V5 故障场景；成本 0.03）。
// 中文词表同 V5；判成功用 code:0 && success:true（与 V5 的 code:200 不同）。
// 字段名与 V5/星河/Matcha 天然一致（items[].note，真实客户端 spider.py 按此解析），原样透传即可，
// 不需要改名（曾误以为要归一化成 note_card，已确认那是不相关文档示例，实际字段一直是 note）。
// 提成命名常量，方便被多条候选链引用。
const SEARCH_V4_CANDIDATE = {
  upstream: 'datadrifter', path: '/xhs_app_api/search_sync_v4', timeoutMs: 20000, unitCost: 0.03,
  mapParams: (q) => {
    const s = searchInput(q);
    const p = { keyword: s.keyword, page: Number(s.page) || 1 };
    const cnSort = _SEARCH_SORT_EN2CN[s.sort];
    if (cnSort) p.sort_type = cnSort;
    const cnType = _SEARCH_TYPE_TO_CN[s.noteType];
    if (cnType && cnType !== '不限') p.note_type = cnType;
    const t = s.noteTime === '半年内' ? '不限' : s.noteTime;
    if (t) p.note_time = t;
    return p;
  },
  extractCore: (outer) => {
    const o = outer || {};
    if (Number(o.code) !== 0 || o.success !== true) return { ok: false, msg: o.msg || o.message };
    const d = o.data || {};
    if (!Array.isArray(d.items)) return { ok: false, msg: '上游返回结构异常' };
    return { ok: true, core: d };
  },
};

const SEARCH_NOTE_CHAIN = [
  {
    // swagger 主力（2026-07-11 加，成本 0.008，全链最便宜）：中文词表跟V5一致，复用同一套
    // _SEARCH_SORT_EN2CN/_SEARCH_TYPE_TO_CN/_V5_NOTE_TIME 映射；search_id/session_id 翻页透传。
    // 2026-07-11 核对供应商 /apidocs 完整参数表，补上此前漏传的 page_size / note_range
    // （供应商原生支持这两个，此前 mapParams 没接，客户传了也不会生效）。
    // 已知差异：data.items[].note 实测比现有契约少4个字段(niced/nice_count/shared_count/
    // update_time)，如果客户依赖点赞数/分享数这几个字段，swagger服务时会拿不到，其余字段完整。
    upstream: 'swagger', path: '/api/v1/search', unitCost: 0.008,
    mapParams: (q) => {
      const s = searchInput(q);
      const p = { keyword: s.keyword, page: Number(s.page) || 1 };
      if (s.pageSize) p.page_size = Number(s.pageSize) || undefined;
      const cnSort = _SEARCH_SORT_EN2CN[s.sort];
      if (cnSort) p.sort = cnSort;
      const cnType = _SEARCH_TYPE_TO_CN[s.noteType];
      if (cnType && cnType !== '不限') p.note_type = cnType;
      if (s.noteRange && s.noteRange !== '不限') p.note_range = s.noteRange;
      const t = s.noteTime === '半年内' ? '一年内' : s.noteTime;
      if (t && _V5_NOTE_TIME.has(t) && t !== '不限') p.note_time = t;
      if (s.searchId) p.search_id = s.searchId;
      if (s.sessionId) p.session_id = s.sessionId;
      return p;
    },
    extractCore: (outer) => {
      const o = outer || {};
      if (Number(o.code) !== 0) return { ok: false, msg: o.msg || o.message };
      const d = o.data || {};
      if (!Array.isArray(d.items)) return { ok: false, msg: '上游返回结构异常' };
      return { ok: true, core: d };
    },
  },
  {
    // V5 search_sync_v5（成本 0.025，swagger 挂时顶上）。中文词表；page 翻页；未知枚举值不传（避免上游 422）
    upstream: 'datadrifter', path: '/xhs_app_api/search_sync_v5', timeoutMs: 20000, unitCost: 0.025,
    mapParams: (q) => {
      const s = searchInput(q);
      const p = { keyword: s.keyword, page: Number(s.page) || 1 };
      const cnSort = _SEARCH_SORT_EN2CN[s.sort];
      if (cnSort) p.sort = cnSort;
      const cnType = _SEARCH_TYPE_TO_CN[s.noteType];
      if (cnType && cnType !== '不限') p.note_type = cnType;
      const t = s.noteTime === '半年内' ? '一年内' : s.noteTime;
      if (t && _V5_NOTE_TIME.has(t) && t !== '不限') p.note_time = t;
      return p;
    },
    extractCore: (outer) => {
      const o = outer || {};
      if (Number(o.code) !== 200) return { ok: false, msg: o.msg || o.message };
      const d = o.data || {};
      // V5 偶发返回 data:{}（限流波动，文档注明重试即可）→ 按上游失败切换；items:[] 才是"真没搜到"
      if (!Array.isArray(d.items)) return { ok: false, msg: '上游返回结构异常(限流波动)' };
      return { ok: true, core: d };
    },
  },
  {
    // 星河 /xhsapi/app_search。10200=成功；body 为 JSON 字符串；老接口的全部筛选参数原生支持。
    // extra 捕获星河外层的 searchId/sessionId（老接口契约：顶层回带翻页令牌）
    upstream: 'xingyin', path: '/xhsapi/app_search', unitCost: 0.05,
    mapParams: (q) => {
      const s = searchInput(q);
      return {
        keyword: s.keyword, page: s.page || '1',
        searchId: s.searchId, sessionId: s.sessionId,
        sortType: s.sort,
        filterNoteType: _SEARCH_TYPE_TO_CN[s.noteType] || s.noteType,
        filterNoteTime: s.noteTime, filterNoteRange: s.noteRange, filter_hot: s.filterHot
      };
    },
    extractCore: (outer) => {
      const o = outer || {};
      if (Number(o.code) !== 10200) return { ok: false, msg: o.message };
      let obj = o.body;
      if (typeof obj === 'string') {
        try { obj = JSON.parse(obj); } catch (_) { return { ok: false, msg: '上游数据解析失败' }; }
      }
      if (!obj || obj.success === false) return { ok: true, core: null };
      const d = obj.data;
      if (!d || !Array.isArray(d.items)) return { ok: false, msg: '上游返回结构异常' };
      return {
        ok: true, core: d,
        raw: typeof o.body === 'string' ? o.body : undefined,
        extra: { searchId: o.searchId, sessionId: o.sessionId }
      };
    },
  },
  {
    // Matcha APP端 api_id=101（原 search_note_v1 主上游，现为兜底）。英文词表。
    // 不支持时间筛选：带时间筛选的请求跳过本候选（宁可少一家兜底，也不返回未按时间过滤的结果）
    // 直播笔记筛选同理跳过：Matcha 官方文档只写了 video/image，没证实支持 live，_SEARCH_TYPE_TO_EN
    // 没给它配映射，宁可跳过也不要在客户明确要"只看直播笔记"时悄悄返回未过滤结果
    upstream: 'matcha', apiId: '101', unitCost: 0.04,
    supports: (q) => {
      const s = searchInput(q);
      if (s.noteTime && s.noteTime !== '不限') return false;
      if (s.noteType === 'live' || s.noteType === '直播笔记') return false;
      return true;
    },
    mapParams: (q) => {
      const s = searchInput(q);
      const p = { keyword: s.keyword };
      if (s.page) p.page = s.page;
      if (s.sort) p.sort = s.sort;
      const enType = _SEARCH_TYPE_TO_EN[s.noteType];
      if (enType) p.note_type = enType;
      if (s.searchId) p.search_id = s.searchId;
      if (s.sessionId) p.session_id = s.sessionId;
      return p;
    },
    extractCore: (outer) => {
      const o = outer || {};
      if (Number(o.code) !== 200) return { ok: false, msg: o.msg || o.message };
      const d = o.data;
      if (!d || !Array.isArray(d.items)) return { ok: false, msg: '上游返回结构异常' };
      return { ok: true, core: d };
    },
  },
  SEARCH_V4_CANDIDATE,
];

// ==================== 评论多上游候选链（星河 → Matcha，2026-07-06 同一笔记实测）====================
// 一级评论：data 层 9 键一致，单条评论 84 键零差异；二级评论：data 层 4 键一致，单条 56 键零差异，
// 同笔记同条评论 id 相同——两家都是小红书 APP 协议原样代理，核心可直接互换。
// 游标为小红书原生 JSON 串 {"cursor":"<hex>","index":..}，跨家续页已验证（星河游标喂 Matcha = 星河自己续页）。
// 星河请求（参数名 start）整串/内层 hex 都认；Matcha（参数名 cursor）只认内层 hex，
// 整串会被静默忽略回第一页 → Matcha 候选必须 normalizeCommentCursor。
// datadrifter V5（comment_sync_v5，无排序版）2026-07-08 加为第三候选：一级评论已验证同构可用，
// 但它不支持排序，只有客户没选排序（走默认序）时才参与；带排序的请求维持星河→Matcha 原样，不受影响。
// datadrifter V2（comment_v2_sync）2026-07-09 加为第三候选（无排序版让位到第四）：真支持三种排序，
// 星河+Matcha 都挂时也能兜住带排序的请求，不用像无排序版那样只能兜默认序。
const _extractXingyinCommentCore = (outer) => {
  const o = outer || {};
  if (Number(o.code) !== 10200) return { ok: false, msg: o.message };
  let obj = o.body;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch (_) { return { ok: false, msg: '上游数据解析失败' }; }
  }
  // success=false 语义不明确（笔记没了/风控都可能）→ 按上游失败处理切下一家，全失败则退费，不误计费
  if (!obj || obj.success === false) return { ok: false, msg: (obj && obj.msg) || '上游返回失败' };
  // raw 保留原始字符串：老接口由星河服务时原样透传，保证字节级契约不变（_v1 的 shapeData 不用它）
  return { ok: true, core: obj.data, raw: typeof (outer || {}).body === 'string' ? outer.body : undefined };
};
const _extractMatchaCommentCore = (outer) => {
  const o = outer || {};
  if (Number(o.code) !== 200) return { ok: false, msg: o.msg || o.message };
  return { ok: true, core: o.data };
};
// datadrifter V5 一级评论端点（排序版/无排序版共用）：code===200 或 (code===0 且 success!==false) 判成功，
// payload 取 data 字段，与非候选链时代 buildV5Response 的判定规则一致。
const _extractV5CommentCore = (outer) => {
  const o = outer || {};
  const code = Number(o.code);
  const success = code === 200 || (code === 0 && o.success !== false);
  if (!success) return { ok: false, msg: o.msg || o.message };
  return { ok: true, core: o.data };
};
// datadrifter V5 无排序版(comment_sync_v5) 单独有三个数据坑，跟星河/Matcha/swagger/排序版/
// sub_comment_sync_v5(二级评论，这个是干净的) 都不一样，2026-07-13 实测同一条评论(456赞)逐字段对比发现：
//   1) user 字段名是 user_id/image（其余全部是 userid/images）——原有别名逻辑。
//   2) like_count 恒为 0，真实点赞数被塞在 like_view_count（字符串）里——不是没赞，是这个端点的
//      like_count 字段本身就没实现，客户按 like_count 取值会全部看到 0 赞。
//   3) time 是毫秒级时间戳（13位），其余全部是秒级（10位）——不做换算的话，客户端不管是当秒处理
//      还是不处理直接存，都会得到一个错误的时间（换算成年份会跑到公元几万年）。
// 三个坑对同一条评论的 sub_comments（该端点原生就内嵌了子评论，其余端点这里通常是空数组）同样成立，递归处理。
// 凡是候选链里落到无排序版的候选（NOTE_COMMENT_CHAIN/OLD_NOTE_COMMENT_CHAIN 的兜底，以及 COMMENT_V5_CHAIN
// 排序版失败/熔断后落到无排序版那个候选）都会经过这个函数修补，保证客户拿到的字段不因命中哪个候选而错。
const _aliasV5CommentUserFields = (list) => {
  if (!Array.isArray(list)) return;
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const u = c.user;
    if (u && typeof u === 'object') {
      if (u.userid == null && u.user_id != null) u.userid = u.user_id;
      if (u.images == null && u.image != null) u.images = u.image;
    }
    if (!c.like_count && c.like_view_count != null) {
      const n = Number(c.like_view_count);
      if (Number.isFinite(n)) c.like_count = n;
    }
    if (typeof c.time === 'number' && c.time > 1e12) c.time = Math.round(c.time / 1000);
    if (Array.isArray(c.sub_comments)) _aliasV5CommentUserFields(c.sub_comments);
  }
};
const _extractV5CommentCoreChained = (outer) => {
  const r = _extractV5CommentCore(outer);
  if (r.ok && r.core) _aliasV5CommentUserFields(r.core.comments || r.core.comment_list);
  return r;
};
// datadrifter 一级评论V2(comment_v2_sync，2026-07-09 实测可用加入候选)：判成功规则同 V5（code==200/"200"
// 或 code==0 且 success!==false），payload 取 data 字段，形状（comments/comment_count/cursor JSON串）
// 与 V5 一致；user 字段原生就是 userid/images，跟星河/Matcha 一致，不用别名。比 V5 无排序版强的地方是
// 真支持三种排序(default/latest_v2/like_count，实测翻页/排序均生效)，星河+Matcha 都挂时也能接住带排序的请求，
// 不用像无排序版那样只能兜默认序。crawler_type 文档写选填，实测必填，固定传 'comment_v2'。
// unitCost 暂按同上游其他评论端点（0.025）估，无独立计费文档，后续如有实际扣费差异需回来调整。
const _extractV2CommentCore = (outer) => {
  const o = outer || {};
  const code = Number(o.code);
  const success = code === 200 || (code === 0 && o.success !== false);
  if (!success) return { ok: false, msg: o.msg || o.message };
  return { ok: true, core: o.data };
};
// datadrifter 二级评论V2(sub_comment_v2_sync)：判成功规则同一级评论V2，crawler_type 同样实测必填('sub_comment_v2')。
// 2026-07-09 实测：当时跟一级评论V2一样在抖动(连续500)，按"熔断机制会自然挡住不稳定候选，不会拖累主链路"
// 的原则直接接入——放最后兜底位，短超时，稳定与否交给熔断/探活机制自己处理，不需要等它先稳定再接。
const _extractV2SubCommentCore = (outer) => {
  const o = outer || {};
  const code = Number(o.code);
  const success = code === 200 || (code === 0 && o.success !== false);
  if (!success) return { ok: false, msg: o.msg || o.message };
  return { ok: true, core: o.data };
};
// datadrifter 二级评论V5(sub_comment_sync_v5，2026-07-10 实测稳定加入候选)：判成功规则同其余V5/V2系。
// data 层 4 键(comments/cursor/has_more/page_context)跟星河/Matcha 二级评论核心逐键一致（同为84/56键
// 同构的一路），user 字段原生就是 userid/images，不需要别名——跟"一级评论无排序版"user_id/image 那个坑
// 不是一回事，C端拿到的字段名/结构在这个候选切换时不会变。实测目前稳定，排在V2前面（V2还不稳）。
const _extractV5SubCommentCore = (outer) => {
  const o = outer || {};
  const code = Number(o.code);
  const success = code === 200 || (code === 0 && o.success !== false);
  if (!success) return { ok: false, msg: o.msg || o.message };
  return { ok: true, core: o.data };
};
// swagger 一级评论(/api/v1/comments，2026-07-11 加)：判成功规则最简单，成功统一 code===0（这家没有
// 200/"200"混用那些历史包袱）。data 层 9 键(comment_count/comments/has_more/page_context/
// all_sort_strategies/current_sort_strategy/user_id/comment_count_l1/cursor)跟星河/Matcha/V2
// 逐键一致，user 也原生 userid/images——形状完全对得上 get_note_comment_v1 现有契约，不用做任何
// 别名/结构转换，data 直接原样透传即可。sort 词表(默认/最新/最多点赞)跟客户参数原生一致，直接透传。
// 2026-07-12 更正：此前记录的"折叠评论区中断，完整度11%~72%"是误判——根源是当时拿去对比的分母用
// 错了(comment_count，一二级合计)，不是真的翻页会断。用正确分母(comment_count_l1，纯一级)复测：
// 外部文档(《Swagger评论接口使用文档.md》)33页拿到635/635一级评论零重复零遗漏；本仓库直连上游
// +过自己产线 get_note_comment_v1 双重复测(同一笔记 comment_count_l1=184)均拿到182/184——差的2条
// 是最后一页 has_more 仍为true但游标已提取不出下一页值，是正常的"到底"信号，不是中断丢数据。
// 结论：翻页基本可靠，客户端按"游标提取不到值就停止"处理即可，不需要"折叠区兜不住"这个顾虑。
const _extractSwaggerCommentCore = (outer) => {
  const o = outer || {};
  if (Number(o.code) !== 0) return { ok: false, msg: o.msg || o.message };
  return { ok: true, core: o.data };
};

const NOTE_COMMENT_CHAIN = [
  {
    // swagger 主力（2026-07-11 提到第一位，成本 0.008，全链最便宜）：真支持三种排序，sort 词表跟客户
    // 参数原生一致直接透传；12小时测试850次调用成功率99.9%，是目前实测最稳的候选。cursor 只认裸hex，
    // 用 normalizeCommentCursor 归一化(同 Matcha)。翻页完整度：见下方 _extractSwaggerCommentCore 处
    // 2026-07-12 更正说明——此前"折叠区中断"的判断是分母用错(误拿comment_count而非comment_count_l1)，
    // 实测翻页基本可靠(182/184，差的2条是has_more仍true但游标已提取不出下一页值的正常到底信号)。
    upstream: 'swagger', path: '/api/v1/comments', unitCost: 0.008,
    mapParams: (q) => {
      const p = { note_id: q.note_id };
      if (q.num) p.num = q.num;
      if (q.sort) p.sort = q.sort;
      if (q.cursor) p.cursor = normalizeCommentCursor(q.cursor);
      return p;
    },
    extractCore: _extractSwaggerCommentCore,
  },
  {
    // 星河 /xhsapi/comment（成本 0.02，swagger 挂时顶上）。客户传的 sort 是 Matcha 词表(默认/最新/最多点赞)，
    // 2026-07-08 起反向映射成星河自己的 sortStrategy(1/2/3，见 /docs 说明)，不再跳过本候选；
    // 未命中映射表的值不透传 sortStrategy，走星河自身默认序。num 星河不支持，忽略（页大小固定，游标不受影响）
    upstream: 'xingyin', path: '/xhsapi/comment', unitCost: 0.02,
    mapParams: (q) => {
      const sortMap = { '默认': '1', '最新': '2', '最多点赞': '3' };
      return { noteId: q.note_id, start: q.cursor || '', sortStrategy: (q.sort && sortMap[q.sort]) || '' };
    },
    extractCore: _extractXingyinCommentCore,
  },
  {
    // Matcha api_id=103（原主上游，现为兜底，成本 0.02）。APP端 data 直接是业务对象
    upstream: 'matcha', apiId: '103', unitCost: 0.02,
    mapParams: (q) => {
      const p = { note_id: q.note_id };
      if (q.num) p.num = q.num;
      if (q.sort) p.sort = q.sort;
      if (q.cursor) p.cursor = normalizeCommentCursor(q.cursor);
      return p;
    },
    extractCore: _extractMatchaCommentCore,
  },
  {
    // datadrifter V5 排序版(comment_sort_sync_v5，2026-07-11 接入本链)：真支持三种排序，user 字段原生
    // 就是 userid/images（跟星河/Matcha/swagger一致），不像下面的无排序版需要补别名。sort 中文词表
    // 映射到该端点自己的英文值(default/latest/like_count)——注意跟下面 V2 的 latest_v2 不是同一套。
    upstream: 'datadrifter', path: '/xhs_app_api/comment_sort_sync_v5', unitCost: 0.025,
    mapParams: (q) => {
      const sortMap = { '默认': 'default', '最新': 'latest', '最多点赞': 'like_count' };
      const p = { note_id: q.note_id };
      if (q.sort && sortMap[q.sort]) p.sort_strategy = sortMap[q.sort];
      if (q.cursor) p.cursor = normalizeCommentCursor(q.cursor);
      return p;
    },
    extractCore: _extractV5CommentCore,
  },
  {
    // datadrifter 无排序版再兜底（成本 0.025）：swagger+星河+Matcha+V5排序版 都挂时顶上，"默认"排序本来就等于不排序，一并放行。
    // 2026-07-09：实测这条一直稳定(100%成功)，放在 V2 前面——V2 目前不稳（见下），别让它挡住这条稳定路径
    upstream: 'datadrifter', path: '/xhs_app_api/comment_sync_v5', unitCost: 0.025,
    supports: (q) => !q.sort || q.sort === '默认',
    // 客户上一页可能是星河served的，cursor 是星河的 JSON 串包装；datadrifter 只认内层 hex，需 normalize
    mapParams: (q) => { const p = { note_id: q.note_id }; if (q.cursor) p.cursor = normalizeCommentCursor(q.cursor); return p; },
    extractCore: _extractV5CommentCoreChained,
  },
  {
    // datadrifter V2 最后兜底：前面全挂（多为带排序请求，swagger/无排序版都对不上）时最后试一把。
    // 2026-07-09 实测：上线当天 0/8 成功且经常拖到超时，放最后 + 短超时，避免它拖累/挡住前面稳定候选
    upstream: 'datadrifter', path: '/xhs_app_api/comment_v2_sync', unitCost: 0.025, timeoutMs: 15000,
    mapParams: (q) => {
      const sortMap = { '默认': 'default', '最新': 'latest_v2', '最多点赞': 'like_count' };
      const p = { note_id: q.note_id, crawler_type: 'comment_v2' };
      if (q.cursor) p.cursor = normalizeCommentCursor(q.cursor);
      if (q.sort && sortMap[q.sort]) p.sort_strategy = sortMap[q.sort];
      return p;
    },
    extractCore: _extractV2CommentCore,
  },
];

const SUB_COMMENT_CHAIN = [
  {
    // swagger 主力（2026-07-11 加，成本 0.008，全链最便宜）：二级评论翻页实测100%完整可靠，
    // data 层4键(comments/cursor/has_more/page_context)跟星河/Matcha逐键一致，user 也原生
    // userid/images，不用做任何转换。cursor 只认裸hex，同 Matcha 处理方式。
    upstream: 'swagger', path: '/api/v1/sub_comments', unitCost: 0.008,
    mapParams: (q) => {
      const p = { note_id: q.note_id, comment_id: q.comment_id };
      if (q.num) p.num = q.num;
      if (q.cursor) p.cursor = normalizeCommentCursor(q.cursor);
      return p;
    },
    extractCore: _extractSwaggerCommentCore,
  },
  {
    // 星河 /xhsapi/sub_comments（成本 0.02，swagger 挂时顶上）。num 星河不支持，忽略
    upstream: 'xingyin', path: '/xhsapi/sub_comments', unitCost: 0.02,
    mapParams: (q) => ({ noteId: q.note_id, commentId: q.comment_id, start: q.cursor || '' }),
    extractCore: _extractXingyinCommentCore,
  },
  {
    // Matcha api_id=104（原主上游，现为兜底，成本 0.02）
    upstream: 'matcha', apiId: '104', unitCost: 0.02,
    mapParams: (q) => {
      const p = { note_id: q.note_id, comment_id: q.comment_id };
      if (q.num) p.num = q.num;
      if (q.cursor) p.cursor = normalizeCommentCursor(q.cursor);
      return p;
    },
    extractCore: _extractMatchaCommentCore,
  },
  {
    // datadrifter 二级评论V5再兜底（成本 0.025）：swagger+星河+Matcha 都挂时顶上，2026-07-10 实测稳定，排在V2前面
    upstream: 'datadrifter', path: '/xhs_app_api/sub_comment_sync_v5', unitCost: 0.025,
    mapParams: (q) => { const p = { note_id: q.note_id, comment_id: q.comment_id }; if (q.cursor) p.cursor = normalizeCommentCursor(q.cursor); return p; },
    extractCore: _extractV5SubCommentCore,
  },
  {
    // datadrifter 二级评论V2最后兜底：前面全挂时最后试一把
    upstream: 'datadrifter', path: '/xhs_app_api/sub_comment_v2_sync', unitCost: 0.025, timeoutMs: 15000,
    mapParams: (q) => {
      const p = { note_id: q.note_id, comment_id: q.comment_id, crawler_type: 'sub_comment_v2' };
      if (q.cursor) p.cursor = normalizeCommentCursor(q.cursor);
      return p;
    },
    extractCore: _extractV2SubCommentCore,
  },
];

// 老评论接口（无后缀）保持原参数名和响应壳：翻页游标叫 start、排序叫 sortStrategy（星河词表：1/2/3）。
// Swagger 通过参数映射接到首位；shapeData 仍把非星河候选统一包装成旧接口要求的 JSON 字符串。
const OLD_NOTE_COMMENT_CHAIN = [
  {
    upstream: 'swagger', path: '/api/v1/comments', unitCost: 0.008,
    mapParams: (q) => {
      const p = { note_id: q.note_id };
      if (q.start) p.cursor = normalizeCommentCursor(q.start);
      const sortMap = { '1': '默认', '2': '最新', '3': '最多点赞' };
      if (q.sortStrategy && sortMap[q.sortStrategy]) p.sort = sortMap[q.sortStrategy];
      return p;
    },
    extractCore: _extractSwaggerCommentCore,
  },
  {
    upstream: 'xingyin', path: '/xhsapi/comment', unitCost: 0.02,
    mapParams: (q) => ({ noteId: q.note_id, start: q.start || '', sortStrategy: q.sortStrategy || '' }),
    extractCore: _extractXingyinCommentCore,
  },
  {
    // 星河 sortStrategy(1=默认/2=最新评论/3=点赞最多，见 /docs 说明) → Matcha 自己的中文取值(默认/最新/最多点赞)。
    // 未命中映射表的值（如客户传了非 1/2/3）不透传 sort，走 Matcha 自身默认序，不报错、不误伤这次请求。
    upstream: 'matcha', apiId: '103', unitCost: 0.02,
    mapParams: (q) => {
      const p = { note_id: q.note_id };
      if (q.start) p.cursor = normalizeCommentCursor(q.start);
      const sortMap = { '1': '默认', '2': '最新', '3': '最多点赞' };
      if (q.sortStrategy && sortMap[q.sortStrategy]) p.sort = sortMap[q.sortStrategy];
      return p;
    },
    extractCore: _extractMatchaCommentCore,
  },
  {
    // 无排序版兜底：不支持真排序，但 sortStrategy=1(默认) 本来就等于不排序，一并放行。
    // 2026-07-09：实测一直稳定(100%成功)，放在 V2 前面——V2 目前不稳（见下），别让它挡住这条稳定路径
    upstream: 'datadrifter', path: '/xhs_app_api/comment_sync_v5', unitCost: 0.025,
    supports: (q) => !q.sortStrategy || q.sortStrategy === '1',
    // 客户上一页可能是星河served的，start 是星河的 JSON 串包装；datadrifter 只认内层 hex，需 normalize
    mapParams: (q) => { const p = { note_id: q.note_id }; if (q.start) p.cursor = normalizeCommentCursor(q.start); return p; },
    extractCore: _extractV5CommentCoreChained,
  },
  {
    // datadrifter V2 再兜底：唯一支持真排序的候选，星河+Matcha+无排序版都不行（多为带排序请求）时最后试一把。
    // 2026-07-09 实测：上线当天 0/8 成功且经常拖到超时，放最后 + 短超时，避免它拖累/挡住前面稳定候选
    upstream: 'datadrifter', path: '/xhs_app_api/comment_v2_sync', unitCost: 0.025, timeoutMs: 15000,
    mapParams: (q) => {
      const sortMap = { '1': 'default', '2': 'latest_v2', '3': 'like_count' };
      const p = { note_id: q.note_id, crawler_type: 'comment_v2' };
      if (q.start) p.cursor = normalizeCommentCursor(q.start);
      if (q.sortStrategy && sortMap[q.sortStrategy]) p.sort_strategy = sortMap[q.sortStrategy];
      return p;
    },
    extractCore: _extractV2CommentCore,
  },
];

const OLD_SUB_COMMENT_CHAIN = [
  {
    upstream: 'swagger', path: '/api/v1/sub_comments', unitCost: 0.008,
    mapParams: (q) => {
      const p = { note_id: q.note_id, comment_id: q.comment_id };
      if (q.start) p.cursor = normalizeCommentCursor(q.start);
      return p;
    },
    extractCore: _extractSwaggerCommentCore,
  },
  {
    upstream: 'xingyin', path: '/xhsapi/sub_comments', unitCost: 0.02,
    mapParams: (q) => ({ noteId: q.note_id, commentId: q.comment_id, start: q.start || '' }),
    extractCore: _extractXingyinCommentCore,
  },
  {
    upstream: 'matcha', apiId: '104', unitCost: 0.02,
    mapParams: (q) => {
      const p = { note_id: q.note_id, comment_id: q.comment_id };
      if (q.start) p.cursor = normalizeCommentCursor(q.start);
      return p;
    },
    extractCore: _extractMatchaCommentCore,
  },
  {
    // datadrifter 二级评论V5兜底（成本 0.025）：星河+Matcha 都挂时顶上，2026-07-10 实测稳定，排在V2前面
    upstream: 'datadrifter', path: '/xhs_app_api/sub_comment_sync_v5', unitCost: 0.025,
    mapParams: (q) => { const p = { note_id: q.note_id, comment_id: q.comment_id }; if (q.start) p.cursor = normalizeCommentCursor(q.start); return p; },
    extractCore: _extractV5SubCommentCore,
  },
  {
    // datadrifter 二级评论V2再兜底：V5还挂不住时最后试一把
    upstream: 'datadrifter', path: '/xhs_app_api/sub_comment_v2_sync', unitCost: 0.025, timeoutMs: 15000,
    mapParams: (q) => {
      const p = { note_id: q.note_id, comment_id: q.comment_id, crawler_type: 'sub_comment_v2' };
      if (q.start) p.cursor = normalizeCommentCursor(q.start);
      return p;
    },
    extractCore: _extractV2SubCommentCore,
  },
];

// 一级评论V5候选链（2026-07-08 加，07-08 改为排序版优先）：排序版是主力、任何请求都先尝试；
// 无排序版不支持排序参数，只有「不传排序/传default」时才允许作为兜底顶上——显式要 latest/like_count
// 时没有第二候选，排序版挂了就如实失败退费，不会拿无排序版的默认序悄悄糊弄客户。
// 排序版持续失败时，chain 自带的熔断（连续3次失败跳过60秒）会让「不传排序」的请求自动跳过它直接
// 打无排序版，避免每次都白等一次必败请求；熔断到期后仍会探活，供应商修复后自动切回排序版。
const COMMENT_V5_CHAIN = [
  {
    // 排序版 user 字段原生就是 userid/images（见《社媒数据采集API接口文档》响应示例），无需别名
    upstream: 'datadrifter', path: '/xhs_app_api/comment_sort_sync_v5', unitCost: 0.025,
    mapParams: (q) => { const p = { note_id: q.note_id }; if (q.sort_strategy) p.sort_strategy = q.sort_strategy; if (q.cursor) p.cursor = normalizeCommentCursor(q.cursor); return p; },
    extractCore: _extractV5CommentCore,
  },
  {
    // 无排序版兜底：user 字段是 user_id/image（跟排序版不同！），链内从排序版熔断/失败切到这里时
    // 同样要补别名，否则 get_note_comment_v5 的响应会随命中哪个候选而字段名不一致
    upstream: 'datadrifter', path: '/xhs_app_api/comment_sync_v5', unitCost: 0.025,
    supports: (q) => !q.sort_strategy || q.sort_strategy === 'default',
    mapParams: (q) => { const p = { note_id: q.note_id }; if (q.cursor) p.cursor = normalizeCommentCursor(q.cursor); return p; },
    extractCore: _extractV5CommentCoreChained,
  },
];

const ENDPOINTS = [
  // 小红书商品详情（Matcha api_id=7）：通过商品 id 或商品短链获取商品详情
  {
    type: 'xhs_goods_detail_web',
    name: '小红书商品详情(Web)',
    shortName: '商品详情Web',
    price: 0.07,  // 2026-07-13 更正：后台价格覆盖表实际生效值是0.07，出厂默认这里之前一直是0.06
    method: 'GET',
    upstream: 'matcha',
    apiId: '7',
    params: [{ name: 'goods_id', required: true, desc: '商品 ID 或商品短链', example: '682162d0791e9400151e7200', pattern: /^([0-9a-fA-F]{24}|https?:\/\/\S+|\S*xhslink\.com\S*)$/i, patternDesc: '24位商品ID或商品短链(http链接)' }],
  },
  // 小红书笔记详情（Matcha api_id=10）。加 _web 后缀以区别于已有的 get_note_detail（星河上游）。
  {
    type: 'get_note_detail_web',
    name: '小红书笔记详情(Web)',
    shortName: '笔记详情Web',
    price: 0.05,
    method: 'GET',
    upstream: 'matcha',
    apiId: '10',
    notFoundMsg: '笔记不存在或已删除',
    params: [{ name: 'note_id', required: true, desc: '笔记 ID', example: '6a2942320000000016025071', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' }],
    mapParams: (q) => ({ noteid: q.note_id }),  // 客户传 note_id → Matcha 要 noteid
  },
  // 小红书笔记详情 APP端 V1。多上游候选链：V5 → 星河 → Matcha(102，原主上游)。
  // 契约不变：data 为数组 [{user, note_list, comment_list}]，三家核心同构，shapeData 原样返回。
  {
    type: 'get_note_detail_v1',
    name: '小红书笔记详情V1',
    shortName: '笔记详情V1',
    price: 0.03,  // 2026-07-13 更正：后台价格覆盖表实际生效值是0.03（call_logs 实测），这里之前一直写着出厂默认0.04，跟客户文档的0.05都是错的，三处对不上
    method: 'GET',
    upstream: 'datadrifter',                                        // 主上游（后台"上游API测试"直连它）
    path: '/xhs_app_api/note_detail_sync_v5_upgrade',
    chain: NOTE_DETAIL_CHAIN,
    shapeData: (core) => core,                             // v1 契约：data 直接是核心数组
    coreNotFound: isNoteTombstone,                         // 墓碑占位（内容无法展示）→ 404 且照常计费
    notFoundMsg: '笔记不存在或已删除',
    params: [
      { name: 'note_id', required: true, desc: '笔记 ID', example: '6a2942320000000016025071', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
      { name: 'node_type', required: false, desc: '笔记类型：images=图文笔记(默认)，video=视频笔记；图文笔记不要传video，否则可能返回随机数据', example: 'images' },
    ],
  },
  // 获取笔记详情（老接口，自 userApi.js 硬编码迁入）。多上游候选链同上。
  // 契约不变：data 是 JSON 字符串（客户先 JSON.parse）。星河服务时原样透传其 body 字符串；
  // V5/Matcha 服务时按星河的壳回包，解析后结构一致 {code:0, data:[核心数组], msg:"成功", success:true}。
  {
    type: 'get_note_detail',
    name: '获取笔记详情',
    shortName: '笔记详情',
    price: 0.03,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/xhs_app_api/note_detail_sync_v5_upgrade',
    chain: NOTE_DETAIL_CHAIN,
    shapeData: (core, raw) => raw != null ? raw : JSON.stringify({ code: 0, data: core, msg: '成功', success: true }),
    coreNotFound: isNoteTombstone,                         // 墓碑占位（内容无法展示）→ 404 且照常计费
    notFoundMsg: '笔记不存在或已删除',
    params: [
      { name: 'note_id', required: true, desc: '笔记 ID', example: '6a2942320000000016025071', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
    ],
  },
  // 获取视频笔记详情（老接口，自 userApi.js 硬编码迁入，2026-07-07）。多上游候选链：Swagger → datadrifter V4 → 星河。
  // 契约不变：data 是 JSON 字符串（客户先 JSON.parse），结构 {code, data:[{comment_list, model_type, note_list:[note]}], msg, success}，
  // 与老接口星河单上游时代的原始透传格式一致。
  {
    type: 'get_note_detail_video',
    name: '获取视频笔记详情',
    shortName: '视频详情',
    price: 0.04,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/xhs_app_api/note_detail_video_sync_v4',
    chain: VIDEO_NOTE_DETAIL_CHAIN,
    shapeData: (core, raw) => raw != null ? raw : JSON.stringify({ code: 0, data: [{ comment_list: [], model_type: 'note', note_list: [core] }], msg: '成功', success: true }),
    coreNotFound: isVideoNoteTombstone,
    notFoundMsg: '笔记不存在或已删除',
    params: [
      { name: 'note_id', required: true, desc: '笔记 ID', example: '6a0ae55400000000350212e6', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
    ],
  },
  // 小红书用户信息 APP端 V1。多上游候选链：V5 → 星河 → Matcha(106，原主上游)。
  // 契约不变：data 为扁平用户对象（昵称/红薯号/性别/简介/统计等），三家核心同构。
  {
    type: 'get_user_info_v1',
    name: '小红书用户信息V1',
    shortName: '用户信息V1',
    price: 0.03,  // 2026-07-13 更正：后台价格覆盖表实际生效值是0.03，之前写的出厂默认0.04和客户文档的0.05都对不上
    method: 'GET',
    upstream: 'datadrifter',                                        // 主上游（后台"上游API测试"直连它）
    path: '/xhs_app_api/user_info_sync_v4',
    chain: USER_INFO_CHAIN,
    shapeData: (core) => core,                             // v1 契约：data 直接是用户对象
    notFoundMsg: '用户不存在或已注销',
    params: [
      { name: 'user_id', required: true, desc: '用户 ID（24位真实ID 或 29位评论区脱敏ID，三家上游均支持）', example: '5b7445a64115e0000101b952', pattern: /^([0-9a-fA-F]{24}|[0-9a-fA-F]{29})$/, patternDesc: '24位用户ID或29位脱敏ID', patternMsg: '输入用户ID格式错误,请检查后重新输入,本次请求不扣费' },
    ],
  },
  // 获取用户信息（老接口，自 userApi.js 硬编码迁入）。多上游候选链同上。
  // 契约不变：data 是 JSON 字符串（客户先 JSON.parse）。星河服务时原样透传其 body 字符串；
  // V5/Matcha 服务时按星河的壳回包，解析后结构一致 {code:0, data:{用户对象}, msg:"成功", success:true}。
  {
    type: 'get_user_info',
    name: '获取用户信息',
    shortName: '用户信息',
    price: 0.04,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/xhs_app_api/user_info_sync_v4',
    chain: USER_INFO_CHAIN,
    shapeData: (core, raw) => raw != null ? raw : JSON.stringify({ code: 0, data: core, msg: '成功', success: true }),
    notFoundMsg: '用户不存在或已注销',
    params: [
      { name: 'user_id', required: true, desc: '用户 ID（24位真实ID 或 29位评论区脱敏ID，三家上游均支持）', example: '5b7445a64115e0000101b952', pattern: /^([0-9a-fA-F]{24}|[0-9a-fA-F]{29})$/, patternDesc: '24位用户ID或29位脱敏ID', patternMsg: '输入用户ID格式错误,请检查后重新输入,本次请求不扣费' },
    ],
  },
  // 小红书用户作品列表 APP端 V1。多上游候选链：V5 → 星河 → Matcha(105，原主上游)。
  // 契约不变：data = { notes, tags, has_more }，has_more=true 时翻页（游标在笔记项 cursor 字段）。
  {
    type: 'user_note_list_v1',
    name: '小红书用户作品列表V1',
    shortName: '用户作品列表V1',
    price: 0.03,  // 2026-07-13 更正：后台价格覆盖表实际生效值是0.03，之前写的出厂默认0.04和客户文档的0.05都对不上
    method: 'GET',
    upstream: 'datadrifter',                                        // 主上游（后台"上游API测试"直连它）
    path: '/xhs_app_api/user_posted_sync_v5',
    chain: USER_NOTE_LIST_CHAIN,
    shapeData: (core) => core,                             // v1 契约：data 直接是 {notes, tags, has_more}
    notFoundMsg: '用户不存在或已注销',
    params: [
      { name: 'user_id', required: true, desc: '用户 ID', example: '5b7445a64115e0000101b952', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制用户ID' },
      { name: 'cursor', required: false, desc: '分页游标，首次留空，翻页传上页最后一条笔记的 cursor' },
    ],
  },
  // 获取用户笔记列表（老接口，自 userApi.js 硬编码迁入）。多上游候选链同上。
  // 契约不变：data 是 JSON 字符串（客户先 JSON.parse）。星河服务时原样透传其 body 字符串；
  // V5/Matcha 服务时按星河的壳回包，解析后结构一致 {code:0, data:{notes,tags,has_more}, msg:"成功", success:true}。
  {
    type: 'user_note_list',
    name: '获取用户笔记列表',
    shortName: '笔记列表',
    price: 0.05,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/xhs_app_api/user_posted_sync_v5',
    chain: USER_NOTE_LIST_CHAIN,
    shapeData: (core, raw) => raw != null ? raw : JSON.stringify({ code: 0, data: core, msg: '成功', success: true }),
    notFoundMsg: '用户不存在或已注销',
    params: [
      { name: 'user_id', required: true, desc: '用户 ID', example: '5b7445a64115e0000101b952', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制用户ID' },
      { name: 'cursor', required: false, desc: '分页游标，首次留空，翻页传上页最后一条笔记的 cursor' },
    ],
  },
  // 小红书搜索笔记 APP端 V1。多上游候选链：V5 → 星河 → Matcha(101，原主上游)。
  // 【C端契约不变】参数与返回格式原样：data 为对象，笔记列表在 data.items[]，data.search_request_id 为翻页标识。
  {
    type: 'search_note_v1',
    name: '小红书笔记搜索V1',
    shortName: '笔记搜索V1',
    price: 0.03,  // 2026-07-13 更正：后台价格覆盖表实际生效值是0.03，之前写的出厂默认0.04和客户文档的0.05都对不上
    method: 'GET',
    upstream: 'datadrifter',                                        // 主上游（后台"上游API测试"直连它）
    path: '/xhs_app_api/search_sync_v5',
    chain: SEARCH_NOTE_CHAIN,
    shapeData: (core) => core,                             // v1 契约：data 直接是 APP 搜索对象
    params: [
      { name: 'keyword', required: true, desc: '搜索关键词', example: '旅游' },
      { name: 'page', required: false, desc: '页数，默认 1' },
      { name: 'page_size', required: false, desc: '每页数量，默认20' },
      { name: 'sort', required: false, desc: '排序：general=综合（默认），time_descending=最新，popularity_descending=最多点赞，comment_descending=最多评论，collect_descending=最多收藏，english_preferred=英文优先', example: 'general' },
      { name: 'note_type', required: false, desc: '笔记类型：不传=全部，video=只看视频笔记，image=只看图文笔记，live=只看直播笔记', example: 'video' },
      { name: 'note_range', required: false, desc: '搜索范围：不限（默认）/已看过/未看过/已关注', example: '不限' },
      { name: 'note_time', required: false, desc: '发布时间：不限（默认）/一天内/一周内/一个月内/一年内（半年内会放宽按一年内处理）' },
      { name: 'search_id', required: false, desc: '搜索标识，翻页时使用' },
      { name: 'session_id', required: false, desc: '会话标识' },
    ],
  },
  // 搜索笔记（老接口，自 userApi.js 硬编码迁入）。多上游候选链同上。
  // 【C端契约不变】data 是 JSON 字符串（星河服务时原样透传，否则按星河壳回包）；
  // 顶层回带 searchId/sessionId 翻页令牌：星河服务时用它原生令牌，V5/Matcha 服务时以 search_request_id 兜底
  // （客户回传后：V5 走 page 翻页忽略令牌，星河/Matcha 视为新搜索，搜索结果本身非确定性，影响可忽略）。
  {
    type: 'search_note',
    name: '搜索笔记',
    shortName: '搜索笔记',
    price: 0.05,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/xhs_app_api/search_sync_v5',
    chain: SEARCH_NOTE_CHAIN,
    shapeData: (core, raw) => raw != null ? raw : JSON.stringify({ code: 0, data: core, msg: '成功', success: true }),
    shapeExtra: (ex) => {
      if (ex.extra && ex.extra.searchId != null) return { searchId: ex.extra.searchId, sessionId: ex.extra.sessionId };
      const rid = (ex.core && ex.core.search_request_id) || '';
      return { searchId: rid, sessionId: rid };
    },
    params: [
      { name: 'keyword', required: true, desc: '搜索关键词', example: '咖啡' },
      { name: 'page', required: false, desc: '页码，默认 1' },
      { name: 'page_size', required: false, desc: '每页数量，默认20' },
      { name: 'sortType', required: false, desc: '排序：general(综合)/time_descending(最新)/popularity_descending(最多点赞)/comment_descending(最多评论)/collect_descending(最多收藏)/english_preferred(英文优先)' },
      { name: 'filterNoteType', required: false, desc: '笔记类型：不限/视频笔记/普通笔记/直播笔记' },
      { name: 'filterNoteTime', required: false, desc: '发布时间：不限/一天内/一周内/半年内' },
      { name: 'filterNoteRange', required: false, desc: '搜索范围：不限/已看过/未看过/已关注' },
      { name: 'filter_hot', required: false, desc: '筛选标签，如：可购买/品牌/测评' },
      { name: 'searchId', required: false, desc: '搜索令牌，翻页时回传上次响应顶层 searchId' },
      { name: 'sessionId', required: false, desc: '会话令牌，翻页时回传上次响应顶层 sessionId' },
    ],
  },
  // 小红书笔记评论(一级) APP端 V1。多上游候选链：星河 → Matcha(103，原主上游)。
  // 契约不变：data = {comments[], cursor, has_more, comment_count, ...}，两家核心同构（84键零差异），shapeData 原样返回。
  // 游标整串/内层 hex 都可回传（链候选各自归一化，见 NOTE_COMMENT_CHAIN 注释）。
  {
    type: 'get_note_comment_v1',
    name: '小红书一级评论V1',
    shortName: '一级评论V1',
    price: 0.03,  // 2026-07-13 更正：后台价格覆盖表实际生效值是0.03，之前写的出厂默认0.02和客户文档的0.04都对不上
    method: 'GET',
    upstream: 'xingyin',                                   // 主上游（后台"上游API测试"直连它）
    path: '/xhsapi/comment',
    chain: NOTE_COMMENT_CHAIN,
    shapeData: (core) => core,
    notFoundMsg: '笔记不存在或评论不可见',
    params: [
      { name: 'note_id', required: true, desc: '笔记 ID', example: '6718e886000000001b02c67c', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
      { name: 'num', required: false, desc: '每页数量，默认15' },
      { name: 'sort', required: false, desc: '排序：默认/最新/最多点赞' },
      { name: 'cursor', required: false, desc: '翻页游标（回传上次响应的 cursor，整串或内层值均可）' },
    ],
  },
  // 小红书二级评论 APP端 V1。多上游候选链：星河 → Matcha(104，原主上游)。comment_id 取自一级评论的 id。
  // 契约不变：data = {comments[], cursor, has_more, page_context}，两家核心同构（56键零差异），shapeData 原样返回。
  {
    type: 'get_note_sub_comment_v1',
    name: '小红书二级评论V1',
    shortName: '二级评论V1',
    price: 0.03,  // 2026-07-13 更正：后台价格覆盖表实际生效值是0.03，之前写的出厂默认0.02和客户文档的0.04都对不上
    method: 'GET',
    upstream: 'xingyin',                                   // 主上游（后台"上游API测试"直连它）
    path: '/xhsapi/sub_comments',
    chain: SUB_COMMENT_CHAIN,
    shapeData: (core) => core,
    notFoundMsg: '评论不存在或已删除',
    params: [
      { name: 'note_id', required: true, desc: '笔记 ID', example: '6718e886000000001b02c67c', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
      { name: 'comment_id', required: true, desc: '上级评论 ID（来自一级评论的 id）', example: '6722db7d000000001a0127c4', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制评论ID' },
      { name: 'num', required: false, desc: '返回数量' },
      { name: 'cursor', required: false, desc: '分页游标（回传上次响应的 cursor，整串或内层值均可）' },
    ],
  },
  // 获取笔记评论（老接口，自 userApi.js 硬编码迁入，2026-07-06）。多上游候选链：星河 → Matcha(103)。
  // 契约不变：data 是 JSON 字符串（客户先 JSON.parse）。星河服务时原样透传其 body 字符串；
  // Matcha 服务时按星河的壳回包 {"success":true,"msg":"","data":核心,"code":0}。
  {
    type: 'get_note_comment',
    name: '获取笔记评论',
    shortName: '笔记评论',
    price: 0.04,
    method: 'GET',
    upstream: 'xingyin',                                   // 主上游（后台"上游API测试"直连它）
    path: '/xhsapi/comment',
    chain: OLD_NOTE_COMMENT_CHAIN,
    shapeData: (core, raw) => raw != null ? raw : JSON.stringify({ success: true, msg: '', data: core, code: 0 }),
    notFoundMsg: '笔记不存在或评论不可见',
    params: [
      { name: 'note_id', required: true, desc: '笔记 ID', example: '6718e886000000001b02c67c', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
      { name: 'start', required: false, desc: '翻页游标，回传上次响应里的 cursor' },
      { name: 'sortStrategy', required: false, desc: '排序策略（星河词表，选填）' },
    ],
  },
  // 获取子评论（老接口，自 userApi.js 硬编码迁入，2026-07-06）。多上游候选链：星河 → Matcha(104)。契约同上。
  {
    type: 'get_note_sub_comment',
    name: '获取子评论',
    shortName: '子评论',
    price: 0.04,
    method: 'GET',
    upstream: 'xingyin',
    path: '/xhsapi/sub_comments',
    chain: OLD_SUB_COMMENT_CHAIN,
    shapeData: (core, raw) => raw != null ? raw : JSON.stringify({ success: true, msg: '', data: core, code: 0 }),
    notFoundMsg: '评论不存在或已删除',
    params: [
      { name: 'note_id', required: true, desc: '笔记 ID', example: '6718e886000000001b02c67c', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
      { name: 'comment_id', required: true, desc: '上级评论 ID', example: '6722db7d000000001a0127c4', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制评论ID' },
      { name: 'start', required: false, desc: '翻页游标，回传上次响应里的 cursor' },
    ],
  },
  // 小红书用户搜索（Matcha api_id=9）
  {
    type: 'search_user_web',
    name: '小红书用户搜索(Web)',
    shortName: '用户搜索Web',
    price: 0.05,
    method: 'GET',
    upstream: 'matcha',
    apiId: '9',
    params: [
      { name: 'keyword', required: true, desc: '关键词', example: '旅游' },
      { name: 'page', required: false, desc: '页数，默认 1' },
      { name: 'search_id', required: false, desc: '搜索标识，页数 >1 时必传' },
    ],
  },
  // 小红书笔记搜索 V2（Matcha api_id=19）。通过关键词搜索笔记，支持分页与类型筛选。
  {
    type: 'search_note_web',
    name: '小红书笔记搜索(Web)',
    shortName: '笔记搜索Web',
    price: 0.05,
    method: 'GET',
    upstream: 'matcha',
    apiId: '19',
    params: [
      { name: 'keyword', required: true, desc: '搜索关键词', example: '旅游' },
      { name: 'page', required: false, desc: '页数，第一页为 1' },
      { name: 'note_type', required: false, desc: '笔记类型：1=图文，2=视频' },
    ],
  },
  // 小红书搜索关联词（Matcha api_id=16）
  {
    type: 'search_related_words_web',
    name: '小红书关联词搜索(Web)',
    shortName: '关联词Web',
    price: 0.03,
    method: 'GET',
    upstream: 'matcha',
    apiId: '16',
    params: [{ name: 'keyword', required: true, desc: '关键词', example: '旅游' }],
  },
  // 小红书更新 xsec_token（Matcha api_id=18，评论接口需要）
  {
    type: 'update_xsec_token_web',
    name: '小红书更新xsec_token(Web)',
    shortName: '更新TokenWeb',
    price: 0.05,
    method: 'GET',
    upstream: 'matcha',
    apiId: '18',
    params: [{ name: 'note_id', required: true, desc: '笔记 ID', example: '6a02c5a4000000003700dff0', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' }],
    mapParams: (q) => ({ noteid: q.note_id }),
  },
  // 小红书一级评论（Matcha api_id=11）。首屏用 update_xsec_token 返回的 xsec_token，翻页用上一次评论响应返回的 xsec_token。
  {
    type: 'get_note_comment_web',
    name: '小红书一级评论(Web)',
    shortName: '一级评论Web',
    price: 0.04,
    method: 'GET',
    upstream: 'matcha',
    apiId: '11',
    params: [
      { name: 'note_id', required: true, desc: '笔记 ID', example: '6a02c5a4000000003700dff0', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
      { name: 'xsec_token', required: true, desc: '首次用更新 xsec_token 接口返回值；翻页用上一次一级评论响应返回值', example: 'MBW1R-1ysYzoHhvurSSzhy6iMCe7FesKtW5KjxJ38a1to=' },
      { name: 'cursor', required: false, desc: '分页游标，首次为空' },
    ],
    mapParams: (q) => {
      const p = { noteid: q.note_id, xsec_token: q.xsec_token };
      if (q.cursor) p.cursor = q.cursor;
      return p;
    },
  },
  // 小红书笔记评论-子评论（Matcha api_id=12）。需一级评论/上一次子评论响应返回的 xsec_token + 上级评论 cursor/root_comment_id。
  {
    type: 'get_note_sub_comment_web',
    name: '小红书笔记二级评论(Web)',
    shortName: '二级评论Web',
    price: 0.04,
    method: 'GET',
    upstream: 'matcha',
    apiId: '12',
    params: [
      { name: 'note_id', required: true, desc: '笔记 ID', example: '6a06c2ec000000003701c99d', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
      { name: 'xsec_token', required: true, desc: '一级评论或上一次二级评论响应返回的 Token', example: 'ABquNzf-DSV20_H_bT2lY342maQVlTemDU6kpj36WU2eE=' },
      { name: 'cursor', required: true, desc: '上级评论的 sub_comment_cursor', example: '6a101bce000000002900db80' },
      { name: 'root_comment_id', required: true, desc: '上级评论的 ID', example: '6a100c7400000000280356c0' },
    ],
    mapParams: (q) => ({ noteid: q.note_id, xsec_token: q.xsec_token, cursor: q.cursor, root_comment_id: q.root_comment_id }),
  },
  // 小红书达人商品笔记列表（Matcha api_id=20）。获取指定达人全部商品笔记，支持分页。
  {
    type: 'get_user_posts_web',
    name: '达人商品笔记列表(Web)',
    shortName: '达人商品笔记Web',
    price: 0.05,
    method: 'GET',
    upstream: 'matcha',
    apiId: '20',
    params: [
      { name: 'user_id', required: true, desc: '用户 ID', example: '5b7445a64115e0000101b952', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制用户ID' },
      { name: 'page', required: false, desc: '页数，首页为 1' },
    ],
    mapParams: (q) => {
      const p = { userid: q.user_id };
      if (q.page) p.page = q.page;
      return p;
    },
  },
  // ===== TikHub 上游（小红书商城/电商，GET + Bearer）。统一后缀 _rnote、显示名后缀 (rNote)。path 为上游真实路径，不带后缀。 =====
  {
    type: 'search_products_rnote',
    name: '小红书商品搜索(rNote)',
    shortName: '商品搜索rNote',
    price: 0.09,
    method: 'GET',
    upstream: 'tikhub',
    path: '/search_products',
    params: [
      { name: 'keyword', required: true, desc: '搜索关键词', example: '手机壳' },
      { name: 'page', required: false, desc: '页码，从1开始，默认1', example: '1' },
      { name: 'search_id', required: false, desc: '搜索ID(分页用)，首次为空' },
      { name: 'source', required: false, desc: '来源，默认 explore_feed' },
    ],
  },
  {
    type: 'get_product_detail_rnote',
    name: '小红书商品详情(rNote)',
    shortName: '商品详情rNote',
    price: 0.09,
    method: 'GET',
    upstream: 'tikhub',
    path: '/get_product_detail',
    params: [
      { name: 'sku_id', required: true, desc: '商品 SKU ID', example: '669ddd44e05f3700011067ed', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制SKU ID' },
      { name: 'source', required: false, desc: '来源，默认 mall_search' },
      { name: 'pre_page', required: false, desc: '上一页来源，默认 mall_search' },
    ],
  },
  {
    type: 'get_product_reviews_rnote',
    name: '小红书商品评论(rNote)',
    shortName: '商品评论rNote',
    price: 0.09,
    method: 'GET',
    upstream: 'tikhub',
    path: '/get_product_reviews',
    params: [
      { name: 'sku_id', required: true, desc: '商品 SKU ID', example: '669ddd44e05f3700011067ed', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制SKU ID' },
      { name: 'page', required: false, desc: '页码，从0开始', example: '0' },
      { name: 'sort_strategy_type', required: false, desc: '排序策略，0=默认' },
      { name: 'share_pics_only', required: false, desc: '仅看有图，0=全部' },
      { name: 'from_page', required: false, desc: '来源页面，默认 score_page' },
    ],
  },
  // 用户信息（TikHub App V2 get_user_info）。产品侧归 rNote，对客户只开放 user_id。
  {
    type: 'get_user_info_rnote',
    name: '小红书用户信息(rNote)',
    shortName: '用户信息rNote',
    price: 0.09,
    method: 'GET',
    upstream: 'tikhub',
    path: 'https://api.tikhub.io/api/v1/xiaohongshu/app_v2/get_user_info',
    params: [
      { name: 'user_id', required: true, desc: '用户 ID', example: '61b46d790000000010008153', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制用户ID' },
    ],
  },
  // 用户笔记列表（TikHub get_user_posted_notes）。获取指定博主发布的全部笔记，游标翻页。
  {
    type: 'get_user_notes_rnote',
    name: '用户作品列表(rNote)',
    shortName: '用户作品rNote',
    price: 0.09,
    method: 'GET',
    upstream: 'tikhub',
    path: '/get_user_posted_notes',
    params: [
      { name: 'user_id', required: true, desc: '用户 ID', example: '61b46d790000000010008153', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制用户ID' },
      { name: 'cursor', required: false, desc: '分页游标，首次留空，翻页传上页最后一条笔记的 cursor' },
    ],
  },
  // 话题详情（TikHub get_topic_info）。获取话题名称、浏览量、讨论数、分享信息等。
  {
    type: 'get_topic_info_rnote',
    name: '小红书话题详情(rNote)',
    shortName: '话题详情rNote',
    price: 0.09,
    method: 'GET',
    upstream: 'tikhub',
    path: '/get_topic_info',
    params: [
      { name: 'page_id', required: true, desc: '话题页面 ID', example: '5c1cc866febed9000184b7c1', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制话题页面ID' },
      { name: 'source', required: false, desc: '来源，默认 normal' },
    ],
  },
  // 图文笔记详情（TikHub get_image_note_detail）。获取图文笔记完整详情（内容/图片/作者/互动）。
  {
    type: 'get_image_note_detail_rnote',
    name: '小红书图文笔记详情(rNote)',
    shortName: '图文详情rNote',
    price: 0.09,
    method: 'GET',
    upstream: 'tikhub',
    path: '/get_image_note_detail',
    notFoundMsg: '笔记不存在或已删除',
    params: [
      { name: 'note_id', required: true, desc: '笔记 ID', example: '697c0eee000000000a03c308', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
    ],
  },
  // 视频笔记详情（TikHub get_video_note_detail）。note_id 与 share_text 二选一，优先 note_id。
  {
    type: 'get_video_note_detail_rnote',
    name: '小红书视频笔记详情(rNote)',
    shortName: '视频笔记rNote',
    price: 0.09,
    method: 'GET',
    upstream: 'tikhub',
    path: '/get_video_note_detail',
    notFoundMsg: '笔记不存在或已删除',
    oneOfRequired: ['note_id', 'share_text'],
    params: [
      { name: 'note_id', required: false, desc: '笔记 ID（与 share_text 二选一，优先用此项）', example: '697c0eee000000000a03c308', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
      { name: 'share_text', required: false, desc: '小红书分享链接（与 note_id 二选一），支持 APP/Web' },
    ],
  },
  // 笔记评论（TikHub get_note_comments，App V2，https://docs.tikhub.io/420136394e0）。
  // note_id 与 share_text 二选一，优先 note_id；sort_strategy 支持 latest_v2/like_count/default；
  // cursor/index/pageArea 用于翻页及展开某条评论下折叠(FOLDED)的子评论区。
  {
    type: 'get_note_comments_rnote',
    name: '小红书笔记评论(rNote)',
    shortName: '笔记评论rNote',
    price: 0.1,
    method: 'GET',
    upstream: 'tikhub',
    path: '/get_note_comments',
    oneOfRequired: ['note_id', 'share_text'],
    params: [
      { name: 'note_id', required: false, desc: '笔记 ID（与 share_text 二选一，优先用此项）', example: '697c0eee000000000a03c308', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
      { name: 'share_text', required: false, desc: '小红书分享链接（与 note_id 二选一），支持 APP/Web', example: 'http://xhslink.com/o/8GqargIxrko' },
      { name: 'cursor', required: false, desc: '分页游标，首次留空' },
      { name: 'index', required: false, desc: '评论索引，首次传0', example: '0' },
      { name: 'pageArea', required: false, desc: '折叠状态：UNFOLDED(展开)或FOLDED(折叠)', example: 'UNFOLDED' },
      { name: 'sort_strategy', required: false, desc: '排序策略：latest_v2(最新)、like_count(点赞数)、default(默认)', example: 'latest_v2' },
    ],
  },
  // 笔记二级评论（TikHub get_note_sub_comments，App V2，https://docs.tikhub.io/420748830e0）。
  // comment_id(一级评论ID) 必填；note_id 与 share_text 二选一，优先 note_id；
  // 首次请求 cursor 留空、index 传 1，翻页时从上次响应 data.data.cursor/index 取值原样回传。
  {
    type: 'get_note_sub_comments_rnote',
    name: '小红书笔记二级评论(rNote)',
    shortName: '二级评论rNote',
    price: 0.1,
    method: 'GET',
    upstream: 'tikhub',
    path: '/get_note_sub_comments',
    oneOfRequired: ['note_id', 'share_text'],
    params: [
      { name: 'comment_id', required: true, desc: '一级评论 ID（指定获取这条评论下的子评论）', example: '699fb9930000000008030db6', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制评论ID' },
      { name: 'note_id', required: false, desc: '笔记 ID（与 share_text 二选一，优先用此项）', example: '699916e6000000001d0253da', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
      { name: 'share_text', required: false, desc: '小红书分享链接（与 note_id 二选一），支持 APP/Web', example: 'http://xhslink.com/o/8GqargIxrko' },
      { name: 'cursor', required: false, desc: '分页游标，首次留空' },
      { name: 'index', required: false, desc: '分页索引，首次传1', example: '1' },
    ],
  },
  // 用户收藏笔记列表（TikHub get_user_faved_notes）。user_id 与 share_text 二选一；cursor 游标翻页。
  {
    type: 'get_user_faved_notes_rnote',
    name: '小红书用户收藏笔记(rNote)',
    shortName: '收藏笔记rNote',
    price: 0.09,
    method: 'GET',
    upstream: 'tikhub',
    path: '/get_user_faved_notes',
    oneOfRequired: ['user_id', 'share_text'],
    params: [
      { name: 'user_id', required: false, desc: '用户 ID（与 share_text 二选一，优先用此项）', example: '5a8cf39111be10466d285d6b', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制用户ID' },
      { name: 'share_text', required: false, desc: '小红书分享链接（与 user_id 二选一），支持 APP/Web' },
      { name: 'cursor', required: false, desc: '分页游标，首次留空，翻页传上页最后一条笔记的 note_id' },
    ],
  },
  // 话题笔记列表（TikHub get_topic_feed）。获取话题下笔记，支持最热/最新排序，游标翻页。
  {
    type: 'get_topic_feed_rnote',
    name: '小红书话题笔记列表(rNote)',
    shortName: '话题笔记rNote',
    price: 0.09,
    method: 'GET',
    upstream: 'tikhub',
    path: '/get_topic_feed',
    params: [
      { name: 'page_id', required: true, desc: '话题页面 ID', example: '5c1cc866febed9000184b7c1', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制话题页面ID' },
      { name: 'sort', required: false, desc: '排序：trend(最热，默认)、time(最新)' },
      { name: 'cursor_score', required: false, desc: '分页游标分数，翻页时传入' },
      { name: 'last_note_id', required: false, desc: '上一页最后一条笔记 ID' },
      { name: 'last_note_ct', required: false, desc: '上一页最后一条笔记创建时间' },
      { name: 'session_id', required: false, desc: '会话 ID，翻页保持一致' },
      { name: 'first_load_time', required: false, desc: '首次加载时间戳，翻页保持一致' },
      { name: 'source', required: false, desc: '来源，默认 normal' },
    ],
  },
  // 搜索笔记（TikHub search_notes）。关键词搜索，支持排序/类型/时间筛选，分页。
  {
    type: 'search_notes_rnote',
    name: '小红书笔记搜索(rNote)',
    shortName: '笔记搜索rNote',
    price: 0.09,
    method: 'GET',
    upstream: 'tikhub',
    path: '/search_notes',
    params: [
      { name: 'keyword', required: true, desc: '搜索关键词', example: '美食推荐' },
      { name: 'page', required: false, desc: '页码，从 1 开始' },
      { name: 'sort_type', required: false, desc: '排序：general/time_descending/popularity_descending/comment_descending/collect_descending/english_preferred' },
      { name: 'note_type', required: false, desc: '笔记类型：不限/视频笔记/普通笔记/直播笔记' },
      { name: 'time_filter', required: false, desc: '发布时间：不限/一天内/一周内/半年内' },
      { name: 'search_id', required: false, desc: '搜索 ID，翻页传入首次搜索返回值' },
      { name: 'search_session_id', required: false, desc: '搜索会话 ID，翻页传入首次搜索返回值' },
      { name: 'source', required: false, desc: '来源，默认 explore_feed' },
      { name: 'ai_mode', required: false, desc: 'AI 模式：0=关闭(默认)，1=开启' },
    ],
  },
  // 搜索用户（TikHub search_users）。关键词搜索用户，每页 20 条，分页。
  {
    type: 'search_users_rnote',
    name: '小红书用户搜索(rNote)',
    shortName: '用户搜索rNote',
    price: 0.09,
    method: 'GET',
    upstream: 'tikhub',
    path: '/search_users',
    params: [
      { name: 'keyword', required: true, desc: '搜索关键词', example: '美食博主' },
      { name: 'page', required: false, desc: '页码，从 1 开始' },
      { name: 'search_id', required: false, desc: '搜索 ID，翻页传入首次搜索返回值' },
      { name: 'source', required: false, desc: '来源，默认 explore_feed' },
    ],
  },
  // ===== 抖音（TikHub 上游，App V3，GET + Bearer）。path 用完整 URL（与小红书 rNote 不同 base）。客户字段名与上游一致，无需 mapParams。 =====
  // 抖音作品详情 V3（fetch_one_video_v3，无版权限制），支持图文/视频/文章。
  {
    type: 'douyin_video_detail',
    name: '抖音视频详情',
    shortName: '抖音视频详情',
    price: 0.04,
    method: 'GET',
    upstream: 'tikhub',
    path: 'https://api.tikhub.io/api/v1/douyin/app/v3/fetch_one_video_v3',
    params: [
      { name: 'aweme_id', required: true, desc: '抖音作品/文章 ID', example: '7448118827402972455', pattern: /^\d+$/, patternDesc: '纯数字作品ID' },
    ],
  },
  // 抖音视频一级评论（fetch_video_comments）。cursor 翻页，count 每页数量默认20。
  {
    type: 'douyin_video_comments',
    name: '抖音视频评论',
    shortName: '抖音评论',
    price: 0.04,
    method: 'GET',
    upstream: 'tikhub',
    path: 'https://api.tikhub.io/api/v1/douyin/app/v3/fetch_video_comments',
    params: [
      { name: 'aweme_id', required: true, desc: '抖音作品 ID', example: '7448118827402972455', pattern: /^\d+$/, patternDesc: '纯数字作品ID' },
      { name: 'cursor', required: false, desc: '翻页游标，默认 0' },
      { name: 'count', required: false, desc: '每页数量，默认 20' },
    ],
  },
  // 抖音视频二级评论/评论回复（fetch_video_comment_replies）。注意上游参数是 item_id（不是 aweme_id）+ comment_id。
  {
    type: 'douyin_comment_replies',
    name: '抖音视频二级评论',
    shortName: '抖音二级评论',
    price: 0.04,
    method: 'GET',
    upstream: 'tikhub',
    path: 'https://api.tikhub.io/api/v1/douyin/app/v3/fetch_video_comment_replies',
    params: [
      { name: 'item_id', required: true, desc: '抖音作品 ID', example: '7448118827402972455', pattern: /^\d+$/, patternDesc: '纯数字作品ID' },
      { name: 'comment_id', required: true, desc: '一级评论 ID', example: '7448331808838320959', pattern: /^\d+$/, patternDesc: '纯数字评论ID' },
      { name: 'cursor', required: false, desc: '翻页游标，默认 0' },
      { name: 'count', required: false, desc: '每页数量，默认 20' },
    ],
  },
  // 抖音用户信息（handler_user_profile）。参数为 sec_user_id。
  {
    type: 'douyin_user_profile',
    name: '抖音用户信息',
    shortName: '抖音用户信息',
    price: 0.04,
    method: 'GET',
    upstream: 'tikhub',
    path: 'https://api.tikhub.io/api/v1/douyin/app/v3/handler_user_profile',
    params: [
      { name: 'sec_user_id', required: true, desc: '用户 sec_user_id', example: 'MS4wLjABAAAAY3J1P0y5w7hzttTyvZiLjhMu3iOzF-1yFi6yNtXVHzkmVGFIx7T8s-nRmGNusfh1' },
    ],
  },
  // 抖音用户主页作品列表（fetch_user_post_videos）。max_cursor 翻页，count 每页≤20，sort_type 0=最新/1=最热。
  {
    type: 'douyin_user_videos',
    name: '抖音用户作品列表',
    shortName: '抖音作品列表',
    price: 0.04,
    method: 'GET',
    upstream: 'tikhub',
    path: 'https://api.tikhub.io/api/v1/douyin/app/v3/fetch_user_post_videos',
    params: [
      { name: 'sec_user_id', required: true, desc: '用户 sec_user_id', example: 'MS4wLjABAAAAY3J1P0y5w7hzttTyvZiLjhMu3iOzF-1yFi6yNtXVHzkmVGFIx7T8s-nRmGNusfh1' },
      { name: 'max_cursor', required: false, desc: '翻页游标，默认 0' },
      { name: 'count', required: false, desc: '每页数量，默认 20（不超过 20）' },
      { name: 'sort_type', required: false, desc: '排序：0=最新（默认），1=最热' },
    ],
  },
  // 抖音综合搜索 V2（fetch_general_search_v2）。注意：POST，参数走 JSON body；结果在 data.business_data[]。
  {
    type: 'douyin_general_search',
    name: '抖音综合搜索',
    shortName: '抖音搜索',
    price: 0.15,
    method: 'POST',
    upstream: 'tikhub',
    path: 'https://api.tikhub.io/api/v1/douyin/search/fetch_general_search_v2',
    params: [
      { name: 'keyword', required: true, desc: '搜索关键词', example: '猫咪' },
      { name: 'cursor', required: false, desc: '翻页游标，首次传 0' },
      { name: 'sort_type', required: false, desc: '排序：0=综合，1=最多点赞，2=最新发布' },
      { name: 'publish_time', required: false, desc: '发布时间：0=不限，1=最近一天，7=最近一周，180=最近半年' },
      { name: 'filter_duration', required: false, desc: '视频时长：0=不限，0-1=1分钟内，1-5=1-5分钟，5-10000=5分钟以上' },
      { name: 'content_type', required: false, desc: '内容类型：0=不限，1=视频，2=图片，3=文章' },
      { name: 'search_id', required: false, desc: '搜索ID，翻页时从上次响应获取' },
      { name: 'backtrace', required: false, desc: '翻页回溯标识，翻页时从上次响应获取' },
    ],
    // 上游对 sort_type/publish_time/content_type 要求字符串，整数会 422；统一强制转字符串避免客户踩坑
    mapParams: (q) => {
      const out = { ...q };
      ['sort_type', 'publish_time', 'content_type', 'filter_duration', 'cursor'].forEach((k) => {
        if (out[k] !== undefined && out[k] !== null && out[k] !== '') out[k] = String(out[k]);
      });
      return out;
    },
  },
  // 聚光关键词规划（Matcha api_id=31）。参数为官方聚光平台参数，需自行抓包，原样透传。
  {
    type: 'juguang_keyword_plan_web',
    name: '聚光关键词规划(Web)',
    shortName: '聚光规划Web',
    price: 0.05,
    method: 'POST',
    upstream: 'matcha',
    apiId: '31',
    params: [],                       // 官方参数自行抓包，不固定字段
    mapParams: (q) => ({ ...q }),     // 透传客户传入的全部参数给上游
  },
  // ===== V5 上游（小红书 V5/V4 APP接口，POST JSON + X-API-KEY）。成本 0.025元/次(1000点=1元)，失败不扣。
  // 统一后缀 _v5。详见《已实测接口清单_20260701.md》。排序版一级评论/二级评论上游侧暂不稳定，未注册。 =====
  // 小红书笔记搜索V5（search_sync_v5）。笔记在 data.items[].note，每页约20条，page 从1递增跨页零重复。
  {
    type: 'search_note_v5',
    name: '小红书笔记搜索V5',
    shortName: '笔记搜索V5',
    price: 0.05,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/xhs_app_api/search_sync_v5',
    params: [
      { name: 'keyword', required: true, desc: '搜索关键词', example: '旅游' },
      { name: 'page', required: false, desc: '页码，从 1 开始，默认 1', example: '1' },
      { name: 'sort', required: false, desc: '排序：综合(默认)/最新/最多点赞/最多评论/最多收藏/英文优先', example: '综合' },
      { name: 'note_type', required: false, desc: '笔记类型：不限(默认)/视频笔记/普通笔记' },
      { name: 'note_time', required: false, desc: '时间范围：不限(默认)/一天内/一周内/一个月内/一年内' },
    ],
    // 上游要求 page 为整数；筛选参数仅在有值时传
    mapParams: (q) => {
      const p = { keyword: q.keyword };
      if (q.page) p.page = Number(q.page) || 1;
      for (const k of ['sort', 'note_type', 'note_time']) if (q[k]) p[k] = q[k];
      return p;
    },
  },
  // 小红书笔记详情V5（note_detail_sync_v5_upgrade，升级版，实测759/759成功）。
  // unwrap 剥到 result.data，返回 [{user, note_list, comment_list}]，与 get_note_detail_v1 同构。
  {
    type: 'get_note_detail_v5',
    name: '小红书笔记详情V5',
    shortName: '笔记详情V5',
    price: 0.05,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/xhs_app_api/note_detail_sync_v5_upgrade',
    notFoundMsg: '笔记不存在或已删除',
    unitCost: 0.025,   // "笔记不存在"也照常计费时的上游成本标记（上游对该查询同样收费）
    params: [
      { name: 'note_id', required: true, desc: '笔记 ID', example: '6a446dae0000000021008bac', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
      { name: 'xsec_token', required: false, desc: '小红书安全参数（选填）' },
    ],
    // 剥壳到核心数组；墓碑占位（笔记已删除/被屏蔽）返回 null → 走 notFoundMsg 404
    unwrap: (d) => {
      const core = (((d || {}).data || {}).result || {}).data;
      return isNoteTombstone(core) ? null : core;
    },
  },
  // 小红书用户发文列表V5（user_posted_sync_v5）。列表在 data.list[]，游标 data.cursor，到底看 data.has_more。
  {
    type: 'user_note_list_v5',
    name: '小红书用户发文列表V5',
    shortName: '发文列表V5',
    price: 0.05,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/xhs_app_api/user_posted_sync_v5',
    params: [
      { name: 'user_id', required: true, desc: '用户 ID', example: '5fc46b6b00000000010098a8', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制用户ID' },
      { name: 'page', required: false, desc: '页码，从 1 开始', example: '1' },
      { name: 'cursor', required: false, desc: '分页游标，翻页时传上次响应 data.cursor（与 page 二选一，优先 cursor）' },
    ],
    mapParams: (q) => {
      if (q.cursor) return { user_id: q.user_id, cursor: q.cursor };
      const p = { user_id: q.user_id };
      if (q.page) p.page = Number(q.page) || 1;
      return p;
    },
  },
  // 小红书一级评论V5。评论在 data.comments[]，comment_count_l1 为一级总数，
  // 游标 data.cursor 为 JSON 串翻页原样回传。无需 xsec_token。每页约10条。
  // 候选链（2026-07-08 加）：排序版(comment_sort_sync_v5)优先，任何请求都先试它；
  // 无排序版(comment_sync_v5)只有「不传排序/传default」时才作为兜底顶上，显式要 latest/like_count 没有兜底。
  {
    type: 'get_note_comment_v5',
    name: '小红书一级评论V5',
    shortName: '一级评论V5',
    price: 0.04,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/xhs_app_api/comment_sync_v5',
    chain: COMMENT_V5_CHAIN,
    params: [
      { name: 'note_id', required: true, desc: '笔记 ID', example: '6a053d0d0000000006023dbc', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
      { name: 'sort_strategy', required: false, desc: '排序：default=默认，latest=最新，like_count=最多点赞（只含有点赞的评论，抓全量用 latest）', example: 'default', pattern: /^(default|latest|like_count)$/, patternDesc: 'default / latest / like_count' },
      { name: 'cursor', required: false, desc: '分页游标(JSON串)，首次留空，翻页原样回传上次响应的 cursor' },
    ],
  },
  // 小红书二级评论V5（sub_comment_sync_v5）。获取某条一级评论下的回复，comment_id 取自一级评论的 id。
  // 评论在 data.comments[]，游标 data.cursor(JSON串)，has_more 终止；含 target_comment 回复关系。
  {
    type: 'get_note_sub_comment_v5',
    name: '小红书二级评论V5',
    shortName: '二级评论V5',
    price: 0.04,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/xhs_app_api/sub_comment_sync_v5',
    params: [
      { name: 'note_id', required: true, desc: '笔记 ID', example: '6a053d0d0000000006023dbc', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
      { name: 'comment_id', required: true, desc: '一级评论 ID（来自一级评论的 id）', example: '6a140277000000002803ab8b', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制评论ID' },
      { name: 'cursor', required: false, desc: '分页游标(JSON串)，首次留空，翻页回传上次响应的 cursor' },
    ],
  },
  // 小红书话题笔记V5（topic_sync_v5）。列表在 data.list[]，游标 data.cursor，到底看 data.has_more。
  // 候选链（2026-07-10 加）：V5 主力 → datadrifter V4(topic_feed_sync_v4) 兜底，星河老接口(10503持续
  // 撞风控 + 翻页参数结构未经验证)不接入，见 TAG_NOTES_CHAIN 定义处注释。
  {
    type: 'tag_notes_v5',
    name: '小红书话题笔记V5',
    shortName: '话题笔记V5',
    price: 0.05,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/xhs_app_api/topic_sync_v5',
    chain: TAG_NOTES_CHAIN,
    params: [
      { name: 'page_id', required: true, desc: '话题页面 ID', example: '5bf77bed6b36ef0001fb339a', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制话题页面ID' },
      { name: 'sort', required: false, desc: '排序，默认 hot(最热)', example: 'hot' },
      { name: 'cursor', required: false, desc: '分页游标，首次留空，翻页回传上次响应的 cursor' },
    ],
  },
  // 获取话题标签笔记（老接口，2026-07-10 从 userApi.js 硬编码路由迁入）。原来单一星河上游，持续撞
  // 风控(10503)、历史成功率仅 0.16%(11/6968)；改接 TAG_NOTES_CHAIN（跟 tag_notes_v5 共用同一条链：
  // V5→V4，不含星河）。参数改造：pageId 保留旧驼峰名兼容老客户；first_load_time/last_note_ct/
  // last_note_id/cursor_score/session_id 这五个星河专用的翻页/会话字段全部去掉，统一成 V5 风格的单一
  // cursor 翻页（跟 tag_notes_v5 一致，首页留空、翻页原样回传上次响应的 cursor）——这几个字段在星河
  // 迁移前历史成功率就只有 0.16%，绝大多数调用方从未真正用它们翻过页，改动风险很低。
  {
    type: 'tag_notes',
    name: '获取话题标签笔记',
    shortName: '话题笔记',
    price: 0.05,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/xhs_app_api/topic_sync_v5',
    chain: TAG_NOTES_CHAIN,
    params: [
      { name: 'pageId', required: true, desc: '话题页面 ID', example: '5c014b045b29cb0001ead530', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制话题页面ID' },
      { name: 'sort', required: false, desc: '排序，默认 hot(最热)', example: 'hot' },
      { name: 'cursor', required: false, desc: '分页游标，首次留空，翻页回传上次响应的 cursor' },
    ],
  },
  // 小红书用户信息V5（上游为 user_info_sync_v4）。成功标志 code:0/success:true（V5适配器已兼容），data 直接是用户对象。
  {
    type: 'get_user_info_v5',
    name: '小红书用户信息V5',
    shortName: '用户信息V5',
    price: 0.04,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/xhs_app_api/user_info_sync_v4',
    params: [
      { name: 'user_id', required: true, desc: '用户 ID（24位真实ID 或 29位评论区脱敏ID）', example: '5fc46b6b00000000010098a8', pattern: /^([0-9a-fA-F]{24}|[0-9a-fA-F]{29})$/, patternDesc: '24位用户ID或29位脱敏ID', patternMsg: '输入用户ID格式错误,请检查后重新输入,本次请求不扣费' },
    ],
    mapParams: (q) => ({ userid: q.user_id }),  // 客户传 user_id → V5 要 userid
  },

  // ==================== V6（2026-07-11 加，新供应商 8.134.84.194，GET+X-API-Key）====================
  // 【暂不对外公开文档】static/index.html 不展示这几个 _v6 接口，仅供内部验证阶段调用，价格/参数后续可能调整。
  // 一级评论/二级评论/搜索/详情翻页均实测基本可靠（一级评论 2026-07-12 更正：此前"折叠区中断拿不全"
  // 是拿错分母误判的，见 NOTE_COMMENT_CHAIN 的 swagger 候选注释）。user_info 需要传 user_id 时 24/29位ID都能查。
  {
    type: 'get_note_detail_v6',
    name: '小红书笔记详情V6',
    shortName: '笔记详情V6',
    price: 0.02,
    method: 'GET',
    upstream: 'swagger',
    unitCost: 0.008,
    path: '/api/v1/detail',
    notFoundMsg: '笔记不存在或已删除',
    params: [
      { name: 'note_id', required: true, desc: '笔记 ID', example: '6a0cfd7200000000080023e8', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
      { name: 'node_type', required: false, desc: '笔记类型：images(默认)/video，图文笔记不要传video，否则可能返回随机数据', example: 'images' },
    ],
    mapParams: (q) => ({ note_id: q.note_id, node_type: q.node_type || 'images' }),
  },
  {
    type: 'get_note_comment_v6',
    name: '小红书一级评论V6',
    shortName: '一级评论V6',
    price: 0.02,
    method: 'GET',
    upstream: 'swagger',
    unitCost: 0.008,
    path: '/api/v1/comments',
    notFoundMsg: '笔记不存在或评论不可见',
    params: [
      { name: 'note_id', required: true, desc: '笔记 ID', example: '6a053d0d0000000006023dbc', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
      { name: 'sort', required: false, desc: '排序：默认/最新/最多点赞，不传走服务端默认序', example: '默认' },
      { name: 'cursor', required: false, desc: '分页游标，首次留空，翻页回传上次响应 data.cursor 里的内层 cursor 值（裸hex，不要传整串JSON）。has_more 为 true 但取不出下一页 cursor 值时视为已到底，应停止翻页' },
    ],
    mapParams: (q) => {
      const p = { note_id: q.note_id };
      if (q.sort) p.sort = q.sort;
      if (q.cursor) p.cursor = q.cursor;
      return p;
    },
  },
  {
    type: 'get_note_sub_comment_v6',
    name: '小红书二级评论V6',
    shortName: '二级评论V6',
    price: 0.02,
    method: 'GET',
    upstream: 'swagger',
    unitCost: 0.008,
    path: '/api/v1/sub_comments',
    notFoundMsg: '评论不存在或已删除',
    params: [
      { name: 'note_id', required: true, desc: '笔记 ID', example: '6a053d0d0000000006023dbc', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
      { name: 'comment_id', required: true, desc: '一级评论 ID（来自一级评论的 id）', example: '6a140277000000002803ab8b', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制评论ID' },
      { name: 'num', required: false, desc: '每页数量，默认10' },
      { name: 'cursor', required: false, desc: '分页游标，首次留空，翻页回传上次响应 data.cursor 里的内层 cursor 值（裸hex）' },
    ],
    mapParams: (q) => {
      const p = { note_id: q.note_id, comment_id: q.comment_id };
      if (q.num) p.num = q.num;
      if (q.cursor) p.cursor = q.cursor;
      return p;
    },
  },
  {
    type: 'search_note_v6',
    name: '小红书笔记搜索V6',
    shortName: '笔记搜索V6',
    price: 0.03,
    method: 'GET',
    upstream: 'swagger',
    unitCost: 0.008,
    path: '/api/v1/search',
    params: [
      { name: 'keyword', required: true, desc: '搜索关键词', example: '咖啡' },
      { name: 'page', required: false, desc: '页码，默认1' },
      { name: 'page_size', required: false, desc: '每页数量，默认20' },
      { name: 'sort', required: false, desc: '排序：综合/最新/最多点赞/最多评论/最多收藏/英文优先，默认综合', example: '综合' },
      { name: 'note_type', required: false, desc: '笔记类型：不限/视频笔记/普通笔记/直播笔记，默认不限', example: '不限' },
      { name: 'note_range', required: false, desc: '搜索范围：不限/已看过/未看过/已关注，默认不限' },
      { name: 'note_time', required: false, desc: '发布时间：不限/一天内/一周内/一个月内/一年内，默认不限' },
      { name: 'search_id', required: false, desc: '搜索标识，翻页时回传上次响应的 search_request_id' },
      { name: 'session_id', required: false, desc: '会话标识，翻页时使用' },
    ],
    mapParams: (q) => {
      const p = { keyword: q.keyword };
      if (q.page) p.page = q.page;
      if (q.page_size) p.page_size = q.page_size;
      if (q.sort) p.sort = q.sort;
      if (q.note_type) p.note_type = q.note_type;
      if (q.note_range) p.note_range = q.note_range;
      if (q.note_time) p.note_time = q.note_time;
      if (q.search_id) p.search_id = q.search_id;
      if (q.session_id) p.session_id = q.session_id;
      return p;
    },
  },
  {
    type: 'get_user_info_v6',
    name: '小红书用户信息V6',
    shortName: '用户信息V6',
    price: 0.02,
    method: 'GET',
    upstream: 'swagger',
    unitCost: 0.008,
    path: '/api/v1/user_info',
    notFoundMsg: '用户不存在',
    params: [
      { name: 'user_id', required: true, desc: '用户 ID（24位真实ID 或 29位评论区脱敏ID，两种都能查）', example: '5fc46b6b00000000010098a8', pattern: /^([0-9a-fA-F]{24}|[0-9a-fA-F]{29})$/, patternDesc: '24位用户ID或29位脱敏ID' },
    ],
    mapParams: (q) => ({ user_id: q.user_id }),
  },
  {
    type: 'user_note_list_v6',
    name: '小红书用户主页笔记V6',
    shortName: '用户主页V6',
    price: 0.03,
    method: 'GET',
    upstream: 'swagger',
    unitCost: 0.008,
    path: '/api/v1/user_post',
    params: [
      { name: 'user_id', required: true, desc: '用户 ID（24位真实ID 或 29位评论区脱敏ID，两种都能查）', example: '5fc46b6b00000000010098a8', pattern: /^([0-9a-fA-F]{24}|[0-9a-fA-F]{29})$/, patternDesc: '24位用户ID或29位脱敏ID' },
      { name: 'cursor', required: false, desc: '分页游标，首次留空，翻页回传上次响应的 cursor' },
    ],
    mapParams: (q) => {
      const p = { user_id: q.user_id };
      if (q.cursor) p.cursor = q.cursor;
      return p;
    },
  },
  {
    // 话题列表V6：2026-07-11 测试时该上游此接口返回"话题列表接口升级维护中"，暂未验证真实响应结构，
    // 先按文档参数注册，恢复后需要补测翻页/字段结构
    type: 'tag_notes_v6',
    name: '小红书话题笔记V6',
    shortName: '话题笔记V6',
    price: 0.03,
    method: 'GET',
    upstream: 'swagger',
    unitCost: 0.008,
    path: '/api/v1/topic',
    params: [
      { name: 'topic_id', required: true, desc: '话题 ID', example: '5c014b045b29cb0001ead530', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制话题ID' },
      { name: 'sort', required: false, desc: '排序：最新/最热，默认最新', example: '最新' },
      { name: 'last_note_ct', required: false, desc: '翻页字段：上一页最后一条笔记发布时间，首页不填' },
      { name: 'last_note_id', required: false, desc: '翻页字段：上一页最后一条笔记ID，首页不填' },
      { name: 'cursor_score', required: false, desc: '翻页字段：上一页最后一条笔记的cursor，首页不填' },
    ],
    mapParams: (q) => {
      const p = { topic_id: q.topic_id };
      if (q.sort) p.sort = q.sort;
      if (q.last_note_ct) p.last_note_ct = q.last_note_ct;
      if (q.last_note_id) p.last_note_id = q.last_note_id;
      if (q.cursor_score) p.cursor_score = q.cursor_score;
      return p;
    },
  },

  // ==================== 小红书蒲公英（pgy_api/*，2026-07-12 接入）====================
  // 同 datadrifter 账号同服务器，从其 Apifox 文档站点"蒲公英同步"分类挖出（11个接口全部实测通过）。
  // 业务线完全不同于以上笔记/评论/搜索内容抓取：这是博主商业化数据（报价、粉丝画像、推广效果核算、达人搜索），
  // 服务小红书广告主/MCN，字段风格全是 camelCase（跟内容类接口的 snake_case 不同，原样透传，不做改写）。
  // 全部走 sendV5Request（POST JSON + X-API-KEY），响应比其余 V5 接口多包一层，统一用 _pgyUnwrap 剥到真实数据。
  {
    type: 'pgy_author_info',
    name: '蒲公英作者信息',
    shortName: '作者信息',
    price: 0.04,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/pgy_api/pgy_author_info_sync_v3',
    unitCost: 0.025,
    params: [
      { name: 'user_id', required: true, desc: '小红书用户 ID', example: '556aceba484fb624f84be04d', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制用户ID' },
    ],
    mapParams: (q) => ({ userid: q.user_id }),
    unwrap: _pgyUnwrap,
  },
  {
    type: 'pgy_author_data_performance',
    name: '蒲公英作者数据表现',
    shortName: '作者数据表现',
    price: 0.04,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/pgy_api/pgy_author_data_performance_sync_v3',
    unitCost: 0.025,
    params: [
      { name: 'user_id', required: true, desc: '小红书用户 ID', example: '556aceba484fb624f84be04d', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制用户ID' },
      { name: 'business', required: false, desc: '0=日常笔记（默认），1=合作笔记', example: '0' },
      { name: 'note_type', required: false, desc: '1=图文，2=视频，3=图文+视频（默认）', example: '3' },
      { name: 'advertise_switch', required: false, desc: '0=自然流量（默认），1=全流量（含投流）', example: '0' },
      { name: 'date_type', required: false, desc: '1=近30天（默认），2=近90天', example: '1' },
    ],
    mapParams: (q) => ({
      userid: q.user_id,
      business: q.business !== undefined && q.business !== '' ? Number(q.business) : 0,
      noteType: q.note_type ? Number(q.note_type) : 3,
      advertiseSwitch: q.advertise_switch !== undefined && q.advertise_switch !== '' ? Number(q.advertise_switch) : 0,
      dateType: q.date_type ? Number(q.date_type) : 1,
    }),
    unwrap: _pgyUnwrap,
  },
  {
    type: 'pgy_author_growth_performance',
    name: '蒲公英作者成长表现',
    shortName: '作者成长表现',
    price: 0.04,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/pgy_api/pgy_author_growth_performance_sync_v3',
    unitCost: 0.025,
    params: [
      { name: 'user_id', required: true, desc: '小红书用户 ID', example: '556aceba484fb624f84be04d', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制用户ID' },
    ],
    mapParams: (q) => ({ userid: q.user_id }),
    unwrap: _pgyUnwrap,
  },
  {
    type: 'pgy_author_notes_list',
    name: '蒲公英作者笔记列表',
    shortName: '作者笔记列表',
    price: 0.04,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/pgy_api/pgy_author_notes_list_sync_v3',
    unitCost: 0.025,
    params: [
      { name: 'user_id', required: true, desc: '小红书用户 ID', example: '556aceba484fb624f84be04d', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制用户ID' },
      { name: 'page', required: false, desc: '页码，从 1 开始，默认 1', example: '1' },
      { name: 'note_type', required: false, desc: '1=图文，2=视频，3=合作笔记，4=全部（默认）', example: '4' },
      { name: 'order_type', required: false, desc: '1=最新（默认），2=阅读最多，3=互动最多', example: '1' },
      { name: 'advertise_switch', required: false, desc: '0=自然流量（默认），1=全流量', example: '0' },
      { name: 'is_third_platform', required: false, desc: '是否第三方平台数据，0=否（默认），1=是', example: '0' },
    ],
    mapParams: (q) => ({
      userid: q.user_id,
      page: q.page ? (Number(q.page) || 1) : 1,
      noteType: q.note_type ? Number(q.note_type) : 4,
      orderType: q.order_type ? Number(q.order_type) : 1,
      advertiseSwitch: q.advertise_switch !== undefined && q.advertise_switch !== '' ? Number(q.advertise_switch) : 0,
      isThirdPlatform: q.is_third_platform !== undefined && q.is_third_platform !== '' ? Number(q.is_third_platform) : 0,
    }),
    unwrap: _pgyUnwrap,
  },
  {
    type: 'pgy_author_promotion_cost',
    name: '蒲公英作者推广成本估算',
    shortName: '推广成本估算',
    price: 0.04,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/pgy_api/pgy_author_promotion_cost_sync_v3',
    unitCost: 0.025,
    params: [
      { name: 'user_id', required: true, desc: '小红书用户 ID', example: '556aceba484fb624f84be04d', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制用户ID' },
    ],
    mapParams: (q) => ({ userid: q.user_id }),
    unwrap: _pgyUnwrap,
  },
  {
    type: 'pgy_blogger_list',
    name: '蒲公英达人列表',
    shortName: '达人列表',
    price: 0.04,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/pgy_api/pgy_blogger_list_sync_v3',
    unitCost: 0.025,
    params: [
      { name: 'keyword', required: true, desc: '搜索关键词（达人昵称/小红书号/内容关键词）', example: '美妆' },
      { name: 'page_num', required: false, desc: '页码，从 1 开始，默认 1', example: '1' },
      { name: 'page_size', required: false, desc: '每页数量，默认由上游决定' },
      { name: 'search_type', required: false, desc: '0=号/昵称精确搜索，1=综合搜索（默认）', example: '1' },
    ],
    mapParams: (q) => {
      const p = { keyword: q.keyword, pageNum: q.page_num ? (Number(q.page_num) || 1) : 1 };
      if (q.page_size) p.pageSize = Number(q.page_size) || undefined;
      p.searchType = q.search_type !== undefined && q.search_type !== '' ? Number(q.search_type) : 1;
      return p;
    },
    unwrap: _pgyUnwrap,
  },
  {
    type: 'pgy_core_metrics',
    name: '蒲公英核心指标',
    shortName: '核心指标',
    price: 0.04,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/pgy_api/pgy_core_metrics_sync_v3',
    unitCost: 0.025,
    params: [
      { name: 'user_id', required: true, desc: '小红书用户 ID', example: '556aceba484fb624f84be04d', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制用户ID' },
      { name: 'business', required: false, desc: '0=日常笔记（默认），1=合作笔记', example: '0' },
      { name: 'note_type', required: false, desc: '1=图文，2=视频，3=图文+视频（默认）', example: '3' },
      { name: 'date_type', required: false, desc: '1=近30天（默认），2=近90天', example: '1' },
      { name: 'advertise_switch', required: false, desc: '0=自然流量（默认），1=全流量', example: '0' },
    ],
    mapParams: (q) => ({
      userid: q.user_id,
      business: q.business !== undefined && q.business !== '' ? Number(q.business) : 0,
      noteType: q.note_type ? Number(q.note_type) : 3,
      dateType: q.date_type ? Number(q.date_type) : 1,
      advertiseSwitch: q.advertise_switch !== undefined && q.advertise_switch !== '' ? Number(q.advertise_switch) : 0,
    }),
    unwrap: _pgyUnwrap,
  },
  {
    type: 'pgy_data_overview',
    name: '蒲公英数据概览',
    shortName: '数据概览',
    price: 0.04,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/pgy_api/pgy_data_overview_sync_v3',
    unitCost: 0.025,
    params: [
      { name: 'user_id', required: true, desc: '小红书用户 ID', example: '556aceba484fb624f84be04d', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制用户ID' },
      { name: 'business', required: false, desc: '0=按规模（默认），1=按成本', example: '0' },
    ],
    mapParams: (q) => ({
      userid: q.user_id,
      business: q.business !== undefined && q.business !== '' ? Number(q.business) : 0,
    }),
    unwrap: _pgyUnwrap,
  },
  {
    type: 'pgy_fans_growth',
    name: '蒲公英粉丝增长',
    shortName: '粉丝增长',
    price: 0.04,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/pgy_api/pgy_fans_growth_sync_v3',
    unitCost: 0.025,
    params: [
      { name: 'user_id', required: true, desc: '小红书用户 ID', example: '556aceba484fb624f84be04d', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制用户ID' },
      { name: 'date_type', required: false, desc: '1=近30天（默认），2=近60天', example: '1' },
      { name: 'increase_type', required: false, desc: '1=总量（默认），2=增量', example: '1' },
    ],
    mapParams: (q) => ({
      userid: q.user_id,
      dateType: q.date_type ? Number(q.date_type) : 1,
      increaseType: q.increase_type ? Number(q.increase_type) : 1,
    }),
    unwrap: _pgyUnwrap,
  },
  {
    type: 'pgy_fans_tags',
    name: '蒲公英粉丝标签',
    shortName: '粉丝标签',
    price: 0.04,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/pgy_api/pgy_fans_tags_sync_v3',
    unitCost: 0.025,
    params: [
      { name: 'user_id', required: true, desc: '小红书用户 ID', example: '556aceba484fb624f84be04d', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制用户ID' },
    ],
    mapParams: (q) => ({ userid: q.user_id }),
    unwrap: _pgyUnwrap,
  },
  {
    // 注意：该接口请求体字段是全小写 noteid（跟其余蒲公英接口的 userid 风格一致，但跟内容类接口的 note_id 不同）
    type: 'pgy_note_detail',
    name: '蒲公英笔记详情',
    shortName: '笔记详情',
    price: 0.04,
    method: 'GET',
    upstream: 'datadrifter',
    path: '/pgy_api/pgy_note_detail_sync_v3',
    unitCost: 0.025,
    params: [
      { name: 'note_id', required: true, desc: '笔记 ID', example: '6a325a5c000000002201727c', pattern: /^[0-9a-fA-F]{24}$/, patternDesc: '24位十六进制笔记ID' },
    ],
    mapParams: (q) => ({ noteid: q.note_id }),
    unwrap: _pgyUnwrap,
  },
];

// 生成给后台 ENDPOINT_META 用的元数据（与老接口同结构）
function metaFromRegistry() {
  // 注意：ENDPOINT_META 只喂后台管理面板（Settings/ApiTest 的下游API测试等，均在 /dashboard 下 adminRequired），
  // 客户实际看到的文档是完全独立维护的 static/index.html，从来没收录过 _v6，所以这里不需要也不应该过滤 _v6——
  // 曾经加过 !/_v6$/ 过滤，副作用是连带把 V6 从「下游API测试」下拉框里也删了，导致没法在后台验证 V6 路由是否还正常，
  // 已撤销（2026-07-12）。
  return ENDPOINTS.map(ep => ({
    type: ep.type,
    name: ep.name,
    shortName: ep.shortName || ep.name,
    method: ep.method || 'GET',
    url: `/api/${ep.type}`,
    params: (ep.params || []).map(p => p.name),
    // 在线测试默认值：{ 参数名: 示例值 }，前端 API 测试页用来预填
    paramExamples: Object.fromEntries((ep.params || []).filter(p => p.example != null).map(p => [p.name, p.example]))
  }));
}

module.exports = { ENDPOINTS, metaFromRegistry };
