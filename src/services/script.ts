/**
 * 剧本库接口层（对接 jbsttj-backend 的 /api/v1/scripts 与 /api/v1/script-options）。
 *
 * 三个用途：
 *   1. `searchScriptByName` —— 导入 DM 指南后，按文件名推导出的剧本名去剧本库模糊匹配；
 *   2. `fetchScriptOptions` —— 拉取玩法/题材/发行方式/难度等字典维度，用于渲染表单筛选项；
 *   3. `createScript`       —— 把「上传的 DM 指南 + 剧本信息」提交到后端，新建剧本。
 *
 * 后端响应约定（见 app/schemas/script.py）：
 *   - `/scripts/byname` 与剧本出参均为**小驼峰**字段（playerMin / releaseType …），
 *     这里直接按驼峰定义 TS 类型，省去一层映射。
 *   - 找不到时 `found=false`、`items=[]`（HTTP 200），前端看 `found` 即可。
 */

import { get, request, type ApiError } from './request'

/* -------------------------------------------------------------------------- */
/*                                   类型                                      */
/* -------------------------------------------------------------------------- */

/** 编码 + 中文标签，后端已查过字典，前端直接展示 */
export interface LabeledCode {
  code: string
  label: string
}

/** 剧本出参（小驼峰，对应后端 ScriptItemCamel）。仅声明前端用得到的字段。 */
export interface ScriptItemCamel {
  id: string
  code: string
  title: string
  aliases?: string[]
  summary?: string | null
  author?: string | null
  publisher?: string | null
  releaseType?: string | null
  difficulty?: string | null
  playstyles?: string[]
  themes?: string[]
  tags?: string[]
  releaseLabel?: string | null
  difficultyLabel?: string | null
  playstyleLabels?: LabeledCode[]
  themeLabels?: LabeledCode[]
  playerMin?: number | null
  playerMax?: number | null
  maleCount?: number | null
  femaleCount?: number | null
  flexibleCount?: number
  allowGenderSwap?: boolean | null
  playerText?: string | null
  durationMin?: number | null
  durationMax?: number | null
  durationText?: string | null
  rating?: number | null
  ratingCount?: number
  playCount?: number
  publishedYear?: number | null
  coverUrl?: string | null
  isRecommended?: boolean
  status?: string
  /** 是否已关联 DM 主持人手册（后端由 extra.dmGuide.objectKey 推导） */
  hasGuide?: boolean
  source?: string | null
  extra?: Record<string, unknown>
  createdAt?: string | null
  updatedAt?: string | null
}

/** GET /scripts/byname 的返回结构 */
export interface ScriptSearchResult {
  found: boolean
  query: string
  count: number
  items: ScriptItemCamel[]
}

/** 自动补全（联想）条目（对应后端 ScriptAutocompleteItem 的驼峰版，蛇形→驼峰已归一） */
export interface ScriptAutocompleteItem {
  id: string
  code: string
  title: string
  author?: string | null
  coverUrl?: string | null
  /** 是否已关联 DM 主持人手册，前端可据此提示「该剧本已导入过」 */
  hasGuide: boolean
}

/** GET /scripts/autocomplete 的返回结构 */
export interface ScriptAutocompleteResult {
  query: string
  count: number
  items: ScriptAutocompleteItem[]
}

/** 单个字典选项（对应后端 ScriptOptionItem 的驼峰版） */
export interface ScriptOptionItem {
  code: string
  label: string
  aliases?: string[]
  description?: string | null
  minValue?: number | null
  maxValue?: number | null
  unit?: string | null
  sortOrder?: number
  isHot?: boolean
}

/** 维度 + 其下选项（对应后端 ScriptOptionGroup） */
export interface ScriptOptionGroup {
  code: string
  name: string
  description?: string | null
  multiSelect?: boolean
  sortOrder?: number
  optionCount?: number
  options: ScriptOptionItem[]
}

/** GET /script-options 的全量维度树 */
export interface ScriptOptionTree {
  categories: ScriptOptionGroup[]
  totalCategories: number
  totalOptions: number
}

/** 上传的 DM 指南引用，写入新建剧本的 extra.dmGuide 透传存储 */
export interface DmGuideRef {
  fileId: string
  fileName: string
  fileUrl: string
  objectKey: string
  fileSize: number
  instant?: boolean
}

/** 新建剧本入参（对应后端 ScriptCreate，title 必填，其余可选） */
export interface ScriptCreatePayload {
  title: string
  aliases?: string[]
  summary?: string
  author?: string
  publisher?: string
  tags?: string[]
  playstyles?: string[]
  themes?: string[]
  releaseType?: string
  difficulty?: string
  playerMin?: number
  playerMax?: number
  durationMin?: number
  durationMax?: number
  publishedYear?: number
  extra?: Record<string, unknown>
}

/* -------------------------------------------------------------------------- */
/*                                  接口调用                                    */
/* -------------------------------------------------------------------------- */

/**
 * 按名称模糊查找剧本。
 * 后端在标题 / 别名上做匹配，返回按匹配质量排序的候选列表。
 */
export async function searchScriptByName(
  name: string,
  limit = 10
): Promise<ScriptSearchResult> {
  return get<ScriptSearchResult>('/scripts/byname', { name, limit })
}

/** 联想条目：蛇形 → 小驼峰（与 normalizeScript 同款 key 翻转） */
function normalizeAutocompleteItem(row: Record<string, any>): ScriptAutocompleteItem {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(row || {})) {
    out[camelKey(k)] = v
  }
  return out as ScriptAutocompleteItem
}

/**
 * 剧本名自动补全（联想搜索）。
 *
 * 对接 `GET /scripts/autocomplete`：边输入边查的轻量接口，只召回**已上架**剧本的
 * 精简字段（id / code / title / author / coverUrl / hasGuide），不拉字典标签、
 * 不拼展示文案，保证下拉框实时响应。`hasGuide=true` 表示该剧本已导入过 DM 手册。
 *
 * 找不到时后端返回 `items=[]`（HTTP 200），这里直接返回空数组，调用方看数组长度即可。
 */
export async function autocompleteScripts(
  q: string,
  limit = 8
): Promise<ScriptAutocompleteItem[]> {
  const res = await get<{ query: string; count: number; items: Record<string, any>[] }>(
    '/scripts/autocomplete',
    { q, limit }
  )
  return (res?.items ?? []).map(normalizeAutocompleteItem)
}

/** 拉取全部筛选维度及选项（玩法 / 题材 / 发行方式 / 难度 / 人数 / 时长）。 */
export async function fetchScriptOptions(onlyHot = false): Promise<ScriptOptionTree> {
  return get<ScriptOptionTree>('/script-options', { only_hot: onlyHot })
}

/* -------------------------------------------------------------------------- */
/*                                 我的剧本                                     */
/* -------------------------------------------------------------------------- */

/** 分页信息（对应后端 Pagination） */
export interface Pagination {
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

/** 我的剧本列表返回 */
export interface MyScriptListResult {
  items: ScriptItemCamel[]
  pagination: Pagination
}

/** 下划线转小驼峰：player_min → playerMin */
function camelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
}

/**
 * 把后端对象的 key 统一成小驼峰。
 *
 * 存在的理由是后端两个接口出参风格不一致：`/scripts/byname` 用了
 * `ScriptItemCamel`（驼峰），而 `/scripts` 列表仍是 `ScriptItem`（蛇形）。
 * 前端类型一律按驼峰声明，所以进门先统一一次，免得页面里到处写
 * `s.playerMin ?? s.player_min` 这种双写。
 *
 * 只翻一层 key —— `extra` 是自由 JSON，翻进去反而会破坏 `dmGuide.objectKey`
 * 这类前端自己写进去的驼峰键。
 */
function normalizeScript(row: Record<string, any>): ScriptItemCamel {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(row || {})) {
    out[camelKey(k)] = v
  }
  return out as ScriptItemCamel
}

export interface MyScriptsQuery {
  keyword?: string
  limit?: number
  offset?: number
  /** hot / rating / newest / year / title，我的列表默认按最新录入排 */
  sort?: 'hot' | 'rating' | 'newest' | 'year' | 'title'
}

/**
 * 拉取「我导入的剧本」（需登录）。
 *
 * 走 `GET /scripts?mine=true`：后端识别到 mine 后按当前用户的 `created_by` 过滤，
 * 并且**放开 status 限制** —— 草稿、已下架的记录本人也看得到。刚导入还没走完
 * 流程的剧本正属于此类，用普通列表接口是查不出来的。
 */
export async function fetchMyScripts(query: MyScriptsQuery = {}): Promise<MyScriptListResult> {
  const params: Record<string, any> = {
    mine: true,
    sort: query.sort ?? 'newest',
    limit: query.limit ?? 20,
    offset: query.offset ?? 0,
  }
  if (query.keyword?.trim()) params.keyword = query.keyword.trim()

  const res = await get<{ items: Record<string, any>[]; pagination: Record<string, any> }>(
    '/scripts',
    params
  )
  const pg = (res?.pagination ?? {}) as Record<string, any>
  return {
    items: (res?.items ?? []).map(normalizeScript),
    pagination: {
      total: Number(pg.total ?? 0),
      limit: Number(pg.limit ?? params.limit),
      offset: Number(pg.offset ?? params.offset),
      hasMore: Boolean(pg.hasMore ?? pg.has_more ?? false),
    },
  }
}

/** 取剧本详情（UUID 或 code 都行），返回归一化后的驼峰对象。 */
export async function fetchScriptDetail(idOrCode: string): Promise<ScriptItemCamel> {
  const row = await get<Record<string, any>>(`/scripts/${encodeURIComponent(idOrCode)}`)
  return normalizeScript(row)
}

/**
 * 新建剧本（需登录）。DM 指南通过 extra.dmGuide 一并带上。
 *
 * ⚠️ 关键坑：后端 `ScriptCreate` 这个**入参**模型没有开驼峰别名
 * （只有出参 ScriptItemCamel 开了 `alias_generator=to_camel`），
 * 所以它只认**蛇形命名**：`release_type` / `player_min` / `duration_min` / `published_year`……
 * 前端组件里用驼峰（releaseType / playerMin）更顺手，所以在这里集中转一次，
 * 避免把字段名拼错导致后端直接忽略（看起来就像「提交了但啥也没存」）。
 * `extra` 本身是自由 JSON，原样透传即可。
 */
export async function createScript(payload: ScriptCreatePayload): Promise<ScriptItemCamel> {
  const body: Record<string, unknown> = { title: payload.title }
  if (payload.aliases?.length) body.aliases = payload.aliases
  if (payload.summary) body.summary = payload.summary
  if (payload.author) body.author = payload.author
  if (payload.publisher) body.publisher = payload.publisher
  if (payload.tags?.length) body.tags = payload.tags
  if (payload.playstyles?.length) body.playstyles = payload.playstyles
  if (payload.themes?.length) body.themes = payload.themes
  if (payload.releaseType) body.release_type = payload.releaseType
  if (payload.difficulty) body.difficulty = payload.difficulty
  if (payload.playerMin != null) body.player_min = payload.playerMin
  if (payload.playerMax != null) body.player_max = payload.playerMax
  if (payload.durationMin != null) body.duration_min = payload.durationMin
  if (payload.durationMax != null) body.duration_max = payload.durationMax
  if (payload.publishedYear != null) body.published_year = payload.publishedYear
  if (payload.extra) body.extra = payload.extra
  return request<ScriptItemCamel>({ url: '/scripts', method: 'POST', data: body })
}

/**
 * 删除剧本（需登录）。走 `DELETE /scripts/{id}`，删除的是当前用户自己
 * 导入 / 创建的剧本，关联的 DM 手册索引也会一并清掉。后端返回 204，这里按
 * `request` 的约定把空响应归一为 void。
 */
export async function deleteScript(idOrCode: string): Promise<void> {
  await request({ url: `/scripts/${encodeURIComponent(idOrCode)}`, method: 'DELETE' })
}

/* -------------------------------------------------------------------------- */
/*                               剧本库（全量浏览）                              */
/* -------------------------------------------------------------------------- */

/** 排序选项（与后端 SORTS 白名单一致） */
export type ScriptSort = 'hot' | 'rating' | 'newest' | 'year' | 'title'

/** 剧本库筛选参数 */
export interface ScriptListQuery {
  keyword?: string
  playstyles?: string[]
  themes?: string[]
  difficulties?: string[]
  releases?: string[]
  /** 按人数区间包含匹配：players=6 命中 player_min≤6 且 player_max≥6 的剧本 */
  players?: number
  /** 按时长区间包含匹配：duration=300 命中 duration_min≤300 且 duration_max≥300 的剧本（分钟） */
  duration?: number
  /** 只看已关联 DM 主持人手册（已完成解析）的剧本 */
  hasGuide?: boolean
  sort?: ScriptSort
  limit?: number
  offset?: number
}

/**
 * 拼接查询字符串，数组参数生成重复键（FastAPI `Query(List[str])` 要求 `?playstyle=a&playstyle=b`，
 * 不能用 `playstyle[]=a` 或 `playstyle=a,b`）。
 */
function buildListQS(params: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      for (const v of value) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`)
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    }
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

/**
 * 拉取剧本库全量列表（公开接口，未登录也可浏览）。
 *
 * 走 `GET /scripts`，不走 `mine=true`。后端默认 `status=published` 只返回已上架剧本。
 * 前端手动拼 query string 以保证数组参数以重复键形式发出，避免 Taro 序列化成
 * `playstyle[]=xxx` 导致后端 FastAPI 无法识别。
 *
 * 响应结构同 `fetchMyScripts`：`{ items: ScriptItem[], pagination }`，
 * 这里复用 `normalizeScript` 把蛇形 key 归一成驼峰。
 */
export async function fetchScriptList(
  query: ScriptListQuery = {}
): Promise<MyScriptListResult> {
  const params: Record<string, unknown> = {
    sort: query.sort ?? 'hot',
    limit: query.limit ?? 20,
    offset: query.offset ?? 0,
  }
  if (query.keyword?.trim()) params.keyword = query.keyword.trim()
  if (query.playstyles?.length) params.playstyle = query.playstyles
  if (query.themes?.length) params.theme = query.themes
  if (query.difficulties?.length) params.difficulty = query.difficulties
  if (query.releases?.length) params.release = query.releases
  if (query.players != null) params.players = query.players
  if (query.duration != null) params.duration = query.duration
  if (query.hasGuide != null) params.has_guide = query.hasGuide

  const qs = buildListQS(params)
  const res = await get<{ items: Record<string, any>[]; pagination: Record<string, any> }>(
    `/scripts${qs}`
  )
  const pg = (res?.pagination ?? {}) as Record<string, any>
  return {
    items: (res?.items ?? []).map(normalizeScript),
    pagination: {
      total: Number(pg.total ?? 0),
      limit: Number(pg.limit ?? params.limit),
      offset: Number(pg.offset ?? params.offset),
      hasMore: Boolean(pg.hasMore ?? pg.has_more ?? false),
    },
  }
}

export type { ApiError }
