/**
 * DM 主持人手册接口层。
 *
 * - 索引状态 / 纯向量检索 / 解析进度：路径式 `GET /api/v1/scripts/{code}/dm-guide/*`
 * - 问答（检索 + LLM 合成）：**扁平接口** `POST /api/v1/dm-guide/ask`，
 *   `code` 与「询问」都放请求体（旧的 `/scripts/{id}/dm-guide/ask` 仍保留向后兼容）。
 *
 * 除了裸接口封装，这里还承担一件业务逻辑：**问答的两级分流**。
 *
 * 后端 `POST /dm-guide/ask` 是「检索 + LLM 合成」一体的，每问一次必然烧一次
 * 大模型额度。但实际带本场景里，主持人问的大多是「凶手是谁」「第二幕几点开始」
 * 这类手册解析阶段就已经预生成好问答对的问题 —— 向量库里躺着现成答案，
 * 再花钱让 LLM 复述一遍纯属浪费，还平白多出两三秒延迟。
 *
 * 所以 {@link askScriptQuestion} 做了一层编排：
 *
 *   1. 先只做向量检索（只消耗一次 embedding，成本约为 LLM 的千分之一）；
 *   2. 命中的问答对相似度 ≥ {@link DIRECT_ANSWER_THRESHOLD} → 直接返回手册原答案，
 *      **完全不调用大模型**；
 *   3. 只召回到一堆似是而非的内容，或压根没召回 → 这才把问题连同上下文交给
 *      大模型，由它整合成一段可念的答案。
 *
 * 返回值里的 `source` 字段标明了这次答案的来路（manual / ai / none），
 * UI 据此给出不同的标签，让用户知道哪些是手册白纸黑字写的、哪些是 AI 推的。
 */

import { get, request, ApiError } from './request'

/* -------------------------------------------------------------------------- */
/*                                   类型                                      */
/* -------------------------------------------------------------------------- */

/** 解析任务进度（对应后端 JobProgress） */
export interface JobProgress {
  jobId: string
  scriptId: string
  documentId?: string | null
  /** pending / downloading / extracting / chunking / generating_qa / embedding / completed / failed / cancelled */
  status: string
  stageDetail?: string | null
  totalPages: number
  processedPages: number
  totalShards: number
  finishedShards: number
  totalChunks: number
  embeddedChunks: number
  totalQa: number
  embeddedQa: number
  errorMessage?: string | null
  startedAt?: string | null
  finishedAt?: string | null
}

/** DM 手册索引状态（对应后端 DMGuideStatus） */
export interface DMGuideStatus {
  scriptId: string
  hasGuide: boolean
  indexed: boolean
  documentId?: string | null
  fileName?: string | null
  totalPages: number
  totalChunks: number
  totalQa: number
  version: number
  job?: JobProgress | null
}

/** 导入流程中的单个阶段（对应后端 ImportPhase） */
export interface ImportPhase {
  /** upload / parse / ready */
  key: string
  label: string
  /** pending / active / done / failed / cancelled / skipped */
  status: string
  progress: number
  detail?: Record<string, unknown> | null
}

/** 剧本导入整体进度（对应后端 ImportStatus） */
export interface ImportStatus {
  scriptId: string
  title?: string | null
  /** uploading / parsing / ready / failed / no_guide / pending */
  overallStatus: string
  phases: ImportPhase[]
  upload?: Record<string, unknown> | null
  dmGuide: Record<string, unknown>
}

/** 命中的原文分块 */
export interface ChunkHit {
  id: string
  documentId: string
  content: string
  sectionPath: string[]
  pageStart: number
  pageEnd: number
  similarity: number
}

/** 命中的问答对 */
export interface QAHit {
  id: string
  documentId: string
  question: string
  answer: string
  category?: string | null
  chunkId?: string | null
  similarity: number
  /** 后端后续补充的出处字段，做可选容错 */
  sectionPath?: string[]
  pageStart?: number
  pageEnd?: number
}

/** 向量检索结果 */
export interface SearchResult {
  query: string
  mode: string
  documentId?: string | null
  chunks: ChunkHit[]
  qa: QAHit[]
  hits: Array<{ type: string; similarity: number; rawSimilarity: number; payload: Record<string, any> }>
  tookMs: number
}

/** QA 标题链中的一个叶子问答（对应后端 QATitleItem） */
export interface QATitleItem {
  id: string
  question: string
  answer: string
  /** rule / plot / role / clue / flow / other */
  category: string
  pageStart?: number | null
  pageEnd?: number | null
}

/** QA 标题链节点（对应后端 QATitleNode），层级来自手册章节面包屑 */
export interface QATitleNode {
  title: string
  path: string[]
  qaCount: number
  qa: QATitleItem[]
  children: QATitleNode[]
}

/** /qa-titles 返回：按标题分组的全量问答目录（对应后端 QATitleChain） */
export interface QATitleChain {
  scriptCode: string
  scriptTitle?: string | null
  totalTitles: number
  totalQa: number
  titles: QATitleNode[]
}

/** 答案引用的一条出处 */
export interface AskSource {
  type: 'qa' | 'chunk' | string
  similarity: number
  question?: string | null
  answer?: string | null
  content?: string | null
  sectionPath: string[]
  pageStart: number
  pageEnd: number
}

/** 后端 ask 接口原始返回 */
export interface AskResponse {
  question: string
  answer: string
  sources: AskSource[]
  mode: string
  documentId?: string | null
  tookMs: number
}

/** 答案来源：手册直答 / 大模型生成 / 无结果 */
export type AnswerSource = 'manual' | 'ai' | 'none'

/** {@link askScriptQuestion} 的统一返回 */
export interface AnswerResult {
  question: string
  answer: string
  source: AnswerSource
  /** 是否真的调用了大模型（用于成本感知与 UI 标签） */
  llmUsed: boolean
  /** 命中的最高相似度，便于 UI 展示置信度 */
  similarity: number
  /** source=manual 时，命中的那条预置问题原文 */
  matchedQuestion?: string
  sources: AskSource[]
  tookMs: number
}

/* -------------------------------------------------------------------------- */
/*                                  阈值配置                                    */
/* -------------------------------------------------------------------------- */

/**
 * 问答对相似度达到该值即视为「手册里已有现成答案」，直接返回、不调大模型。
 *
 * 取 0.82 是权衡后的结果：BGE 中文向量在语义高度一致时通常落在 0.85~0.95，
 * 同话题但问的不是一回事一般在 0.6~0.75。定太低会把「差不多的问题」当成
 * 精确命中，答非所问；定太高则退化成每次都走 LLM，省不下钱。
 */
export const DIRECT_ANSWER_THRESHOLD = 0.82

/**
 * 低于该相似度的召回视为噪声，不作为「匹配到内容」的依据。
 * 与后端 `dm_search_min_similarity` 默认值保持一致。
 */
export const NOISE_THRESHOLD = 0.25

/* -------------------------------------------------------------------------- */
/*                                  裸接口                                      */
/* -------------------------------------------------------------------------- */

/** 查询 DM 手册索引状态（公开接口，未登录也能读）。 */
export function fetchDmGuideStatus(idOrCode: string): Promise<DMGuideStatus> {
  return get<DMGuideStatus>(`/scripts/${encodeURIComponent(idOrCode)}/dm-guide`)
}

/**
 * 查询剧本导入整体进度（上传 → 解析 → 可问答）。
 * 列表页与详情页的进度条都用它，一个接口看全流程。
 */
export function fetchImportStatus(
  idOrCode: string,
  uploadTaskId?: string
): Promise<ImportStatus> {
  const params: Record<string, any> = {}
  if (uploadTaskId) params.upload_task_id = uploadTaskId
  return get<ImportStatus>(`/scripts/${encodeURIComponent(idOrCode)}/import-status`, params)
}

/**
 * 批量查询多个剧本的导入整体进度（对应后端 GET /scripts/import-status）。
 *
 * 「我的剧本」列表页专用：一次请求拿回所有本的状态，替代逐本轮询
 * `GET /scripts/{id}/import-status`，把原本 N 次/轮压成 1 次/轮。
 *
 * 入参是剧本 ID/code 数组，内部拼成逗号分隔字符串（对请求库的数组序列化方式无依赖）；
 * 返回以 `scriptId` 为键的状态表，直接 `setStatusMap(prev => ({ ...prev, ...map }))` 合并即可。
 * 空数组直接返回空对象，不发起请求。
 */
export function fetchImportStatusBatch(ids: string[]): Promise<Record<string, ImportStatus>> {
  const clean = Array.from(new Set((ids || []).filter(Boolean)))
  if (!clean.length) return Promise.resolve({})
  return get<Record<string, ImportStatus>>('/scripts/import-status', { ids: clean.join(',') })
}

/** 查询单个解析任务的进度。 */
export function fetchJobProgress(idOrCode: string, jobId: string): Promise<JobProgress> {
  return get<JobProgress>(
    `/scripts/${encodeURIComponent(idOrCode)}/dm-guide/jobs/${encodeURIComponent(jobId)}`
  )
}

/**
 * 拉取手册「问答标题链」—— 全量 QA 按章节标题分组的树形目录。
 *
 * 走路径式公开接口（未登录也能读）：`GET /scripts/{code}/dm-guide/qa-titles`。
 * 与 search 的区别：这是全量结构化浏览（无语义过滤、不调 embedding），
 * 适合渲染「问答目录」概览面板，让用户先看到手册里有哪些可问的东西。
 */
export function fetchQaTitleChain(idOrCode: string): Promise<QATitleChain> {
  return get<QATitleChain>(
    `/scripts/${encodeURIComponent(idOrCode)}/dm-guide/qa-titles`
  )
}

/** 触发（或重试）手册解析入库，需登录。 */
export function ingestDmGuide(idOrCode: string, force = false): Promise<{
  jobId: string
  status: string
  reused: boolean
  message: string
}> {
  return request({
    url: `/scripts/${encodeURIComponent(idOrCode)}/dm-guide/ingest`,
    method: 'POST',
    data: { force },
  })
}

export interface SearchOptions {
  mode?: 'chunk' | 'qa' | 'hybrid'
  topK?: number
  minSimilarity?: number
  category?: string
}

/**
 * 纯向量检索，不经过大模型。
 *
 * 注意 query 参数名是 `topK` / `minSimilarity`（后端开了驼峰 alias），
 * 传蛇形会被 FastAPI 当成未知参数直接忽略，静默用默认值。
 */
export function searchDmGuide(
  idOrCode: string,
  question: string,
  options: SearchOptions = {}
): Promise<SearchResult> {
  const params: Record<string, any> = {
    q: question,
    mode: options.mode ?? 'hybrid',
    topK: options.topK ?? 6,
  }
  if (options.minSimilarity != null) params.minSimilarity = options.minSimilarity
  if (options.category) params.category = options.category
  return get<SearchResult>(`/scripts/${encodeURIComponent(idOrCode)}/dm-guide/search`, params)
}

/**
 * 直接调用后端「检索 + LLM 合成」问答（每次都会消耗大模型额度）。
 *
 * 走**扁平接口** `POST /dm-guide/ask`：剧本标识 `code` 与「询问」都放请求体，
 * 不再需要把 scriptId/code 拼进 URL 路径（旧的 `/scripts/{id}/dm-guide/ask`
 * 仍保留向后兼容，但新前端统一用扁平接口）。
 *
 * 兼容说明：后端 pydantic 同时接受 `询问` 与 `question`，二者都传以 `询问` 为准；
 * 这里优先发 `询问`（对中文场景更顺手）。`code` 可为业务 code 或 UUID，
 * 检索范围被严格限定在该剧本手册内，不会跨剧本串味。
 */
export function askDmGuide(
  code: string,
  question: string,
  options: SearchOptions = {}
): Promise<AskResponse> {
  return request<AskResponse>({
    url: `/dm-guide/ask`,
    method: 'POST',
    data: {
      code,
      询问: question,
      mode: options.mode ?? 'hybrid',
      topK: options.topK ?? 6,
      ...(options.minSimilarity != null ? { minSimilarity: options.minSimilarity } : {}),
      ...(options.category ? { category: options.category } : {}),
    },
    // LLM 合成答案比普通接口慢得多，30s 默认超时容易误杀
    timeout: 60000,
  })
}

/* -------------------------------------------------------------------------- */
/*                            向量优先的问答编排                                 */
/* -------------------------------------------------------------------------- */

/** 把检索结果转成统一的引用出处列表，qa 在前、chunk 在后 */
function toSources(result: SearchResult, qaCap = 3, chunkCap = 3): AskSource[] {
  const sources: AskSource[] = []
  for (const h of (result.qa ?? []).slice(0, qaCap)) {
    sources.push({
      type: 'qa',
      similarity: h.similarity,
      question: h.question,
      answer: h.answer,
      sectionPath: h.sectionPath ?? [],
      pageStart: h.pageStart ?? 0,
      pageEnd: h.pageEnd ?? 0,
    })
  }
  for (const c of (result.chunks ?? []).slice(0, chunkCap)) {
    sources.push({
      type: 'chunk',
      similarity: c.similarity,
      content: c.content,
      sectionPath: c.sectionPath ?? [],
      pageStart: c.pageStart ?? 0,
      pageEnd: c.pageEnd ?? 0,
    })
  }
  return sources
}

export interface AskOptions extends SearchOptions {
  /** 手册直答的相似度门槛，默认 {@link DIRECT_ANSWER_THRESHOLD} */
  directThreshold?: number
  /** 检索不中时是否允许调用大模型，默认 true。关掉即为「纯手册检索」模式 */
  allowLlm?: boolean
}

/**
 * 向剧本手册提问 —— **向量优先，大模型兜底**。
 *
 * 决策链：
 *   命中高置信问答对 → 直接返回手册原答案（`source=manual`，零 LLM 开销）
 *   召回内容但不够确定 → 交给大模型整合（`source=ai`）
 *   完全没召回且允许调用 → 仍交给大模型，由它说明手册中无相关内容（`source=ai`）
 *   完全没召回且禁止调用 → 返回空答案（`source=none`）
 *
 * @param code 剧本业务 code 或 UUID（扁平 ask 接口用它在请求体里界定检索范围）
 * @param question 自然语言问题
 */
export async function askScriptQuestion(
  code: string,
  question: string,
  options: AskOptions = {}
): Promise<AnswerResult> {
  const started = Date.now()
  const q = (question || '').trim()
  if (!q) {
    throw new ApiError('问题不能为空', 0, 'question_required')
  }

  const threshold = options.directThreshold ?? DIRECT_ANSWER_THRESHOLD
  const allowLlm = options.allowLlm !== false

  // ---- 第一级：向量检索（仍走路径式公开接口，用 code 限定范围） ----
  const result = await searchDmGuide(code, q, {
    mode: options.mode ?? 'hybrid',
    topK: options.topK ?? 6,
    minSimilarity: options.minSimilarity,
    category: options.category,
  })

  const bestQa = (result.qa ?? [])[0]
  const bestChunk = (result.chunks ?? [])[0]
  const bestSimilarity = Math.max(bestQa?.similarity ?? 0, bestChunk?.similarity ?? 0)

  // 命中预置问答对且足够像 —— 手册里白纸黑字写着，没必要再问一遍大模型
  if (bestQa && bestQa.similarity >= threshold) {
    return {
      question: q,
      answer: bestQa.answer,
      source: 'manual',
      llmUsed: false,
      similarity: bestQa.similarity,
      matchedQuestion: bestQa.question,
      sources: toSources(result),
      tookMs: Date.now() - started,
    }
  }

  const hasUsableHit = bestSimilarity >= NOISE_THRESHOLD

  // ---- 第二级：交给大模型 ----
  if (!allowLlm) {
    return {
      question: q,
      answer: hasUsableHit
        ? '手册中没有完全对应的答案，下方是相关度最高的原文片段，供你自行判断。'
        : '手册中没有检索到相关内容。',
      source: 'none',
      llmUsed: false,
      similarity: bestSimilarity,
      sources: toSources(result),
      tookMs: Date.now() - started,
    }
  }

  try {
    const res = await askDmGuide(code, q, options)
    return {
      question: q,
      answer: (res.answer || '').trim(),
      source: 'ai',
      llmUsed: true,
      similarity: bestSimilarity,
      sources: res.sources?.length ? res.sources : toSources(result),
      tookMs: Date.now() - started,
    }
  } catch (err) {
    // 降级而不是抛错：检索这一步其实已经成功了，手里有内容却弹个报错框最气人。
    // 仅当 ask 接口「本身不可用」时才降级到纯手册检索：
    //   401                       —— ask 需要登录（search 是公开接口，走到这说明确实没登录）
    //   405 / 404(未知 code)      —— 扁平 ask 接口尚未上线，用检索结果兜底
    // 以下属于真实业务错误，原样抛出（详情页会弹 toast 提示）：
    //   404 script_not_found      —— code 不对
    //   409 dm_not_indexed         —— 手册还没索引完，引导等待、不要重试（见对接文档 §2.3）
    //   409 dm_dispatch_failed      —— 消息队列不可用，稍后重试
    const status = err instanceof ApiError ? err.status : 0
    const errCode = err instanceof ApiError ? err.code : ''
    const isDegrade =
      status === 401 ||
      status === 405 ||
      (status === 404 && errCode !== 'script_not_found')
    if (isDegrade) {
      const reason = status === 401 ? '登录后可使用 AI 作答' : '智能作答暂不可用'
      return {
        question: q,
        answer: hasUsableHit
          ? `${reason}。下方是手册中相关度最高的原文片段，供你自行判断。`
          : `${reason}，且手册中未检索到相关内容。`,
        source: 'none',
        llmUsed: false,
        similarity: bestSimilarity,
        sources: toSources(result),
        tookMs: Date.now() - started,
      }
    }
    throw err
  }
}

/* -------------------------------------------------------------------------- */
/*                            用户提问沉淀（低相似度问题 → 真人解答）              */
/* -------------------------------------------------------------------------- */

/** 一条用户提问记录（对应后端 QuestionRecord，字段已转 camelCase） */
export interface QuestionRecord {
  id: string
  scriptId: string
  scriptCode: string
  question: string
  /** 被问次数（重复提问原子累加，引导问题的排序依据） */
  askCount: number
  /** 历次提问检索到的最高相似度 */
  bestSimilarity: number
  /** pending 待解答 / answered 已解答 / dismissed 已忽略 */
  status: string
  /** 真人解答（answered 时有值） */
  answer?: string | null
  answeredBy?: string | null
  answeredAt?: string | null
  createdBy?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  // 提问者展示信息
  createdByNickname?: string | null
  createdByAvatarUrl?: string | null
  createdByAvatarColor?: number | null
  // 解答者展示信息
  answeredByNickname?: string | null
  answeredByAvatarUrl?: string | null
  answeredByAvatarColor?: number | null
}

/** 提问记录分页列表（对应后端 QuestionListResult） */
export interface QuestionListResult {
  total: number
  items: QuestionRecord[]
}

/** 剧本引导问题（对应后端 GuideQuestions） */
export interface GuideQuestions {
  scriptCode: string
  scriptTitle?: string | null
  items: QuestionRecord[]
}

/** 提问状态文案 */
export const QUESTION_STATUS_TEXT: Record<string, string> = {
  pending: '待解答',
  answered: '已解答',
  dismissed: '已忽略',
}

/** 状态过滤选项 */
export type QuestionStatusFilter = 'pending' | 'answered' | 'dismissed' | undefined

/**
 * 拉取用户提问列表（待解答问题池）。
 *
 * 走扁平接口 `GET /dm-guide/questions`，需登录。`code` 与 `title` 至少传一个，
 * 同时传以 `code` 为准。返回按 `askCount` 倒序的提问记录，重复提问越多排越前。
 */
export function fetchDmQuestions(
  code: string,
  options: {
    title?: string
    status?: QuestionStatusFilter
    limit?: number
    offset?: number
  } = {}
): Promise<QuestionListResult> {
  const params: Record<string, any> = { code }
  if (options.title) params.title = options.title
  if (options.status) params.status = options.status
  if (options.limit != null) params.limit = options.limit
  if (options.offset != null) params.offset = options.offset
  return get<QuestionListResult>('/dm-guide/questions', params)
}

/**
 * 真人解答用户提问。
 *
 * 提交后问题转为 `answered`，之后会在引导问题接口里带着答案透出。
 * 对 `answered` 状态再次提交视为修改答案；`dismissed` 状态返回 409。需登录。
 */
export function answerDmQuestion(
  questionId: string,
  answer: string
): Promise<QuestionRecord> {
  return request<QuestionRecord>({
    url: `/dm-guide/questions/${encodeURIComponent(questionId)}/answer`,
    method: 'POST',
    data: { answer },
  })
}

/**
 * 拉取剧本引导问题（用户真实提问 Top3）。
 *
 * 按剧本维度取用户真实提问中人气最高的前三条（`askCount` 倒序，
 * 已解答的优先），作为剧本问答页的引导问题。公开接口，未登录也可读。
 */
export function fetchGuideQuestions(
  code: string,
  options: { title?: string; limit?: number } = {}
): Promise<GuideQuestions> {
  const params: Record<string, any> = { code }
  if (options.title) params.title = options.title
  if (options.limit != null) params.limit = options.limit
  return get<GuideQuestions>('/dm-guide/guide-questions', params)
}

/* -------------------------------------------------------------------------- */
/*                        故事还原（LLM 采集的剧本脉络）                          */
/* -------------------------------------------------------------------------- */

/** 一条故事还原条目（对应后端 StoryItem，字段已转 camelCase） */
export interface StoryItem {
  id: string
  documentId: string
  scriptCode: string
  chunkId?: string | null
  /** 条目序号（文档内行文顺序） */
  storyIndex: number
  /** timeline / truth / role / clue / ending / other */
  storyType: string
  title: string
  /** 还原正文（LLM 从手册原文整理） */
  content: string
  /** 一句话摘要 */
  summary?: string | null
  /** 结构化补充：时间线事件（{events:[{when,what}]}）、人物关系对等 */
  meta: Record<string, any>
  sectionPath: string[]
  pageStart?: number | null
  pageEnd?: number | null
  charCount: number
  createdAt?: string | null
  /** 公开划线数（共读时间线计数，列表页展示用） */
  publicHighlights: number
  /** 全部活跃划线数（含私有，作者视角） */
  highlightCount: number
}

/** 故事条目详情（对应后端 StoryDetail）：条目本体 + 公开划线（共读时间线） */
export interface StoryDetail extends StoryItem {
  highlights: HighlightRecord[]
}

/** 剧本维度的故事还原分页列表（对应后端 StoryListResult） */
export interface StoryListResult {
  scriptCode: string
  scriptTitle?: string | null
  total: number
  items: StoryItem[]
}

/** 故事类型的中文文案 */
export const STORY_TYPE_TEXT: Record<string, string> = {
  timeline: '时间线',
  truth: '真相还原',
  role: '角色背景',
  clue: '线索关联',
  ending: '结局收束',
  other: '其他',
}

/** 故事类型 → 标签色系类名（详见 StoryPanel 样式） */
export const STORY_TYPE_TONE: Record<string, string> = {
  timeline: 'is-timeline',
  truth: 'is-truth',
  role: 'is-role',
  clue: 'is-clue',
  ending: 'is-ending',
  other: 'is-other',
}

export type StoryTypeFilter =
  | 'timeline' | 'truth' | 'role' | 'clue' | 'ending' | 'other' | undefined

/**
 * 拉取故事还原列表（公开接口，未登录可读）。
 *
 * 走扁平接口 `GET /dm-guide/stories`：`code` 优先，或传 `title` 自动派生。
 * 条目按 `storyIndex`（手册行文顺序）排列，`storyType` 可过滤。
 */
export function fetchStories(
  code: string,
  options: {
    title?: string
    storyType?: StoryTypeFilter
    limit?: number
    offset?: number
  } = {}
): Promise<StoryListResult> {
  const params: Record<string, any> = { code }
  if (options.title) params.title = options.title
  if (options.storyType) params.storyType = options.storyType
  if (options.limit != null) params.limit = options.limit
  if (options.offset != null) params.offset = options.offset
  return get<StoryListResult>('/dm-guide/stories', params)
}

/** 拉取单条故事还原详情（含公开划线，共读时间线）。公开接口。 */
export function fetchStoryDetail(storyId: string, limit = 50): Promise<StoryDetail> {
  return get<StoryDetail>(`/dm-guide/stories/${encodeURIComponent(storyId)}`, { limit })
}

/* -------------------------------------------------------------------------- */
/*                       划线评论（Web Annotation 式文本锚点）                     */
/* -------------------------------------------------------------------------- */

/** 一条划线评论（对应后端 HighlightRecord，字段已转 camelCase） */
export interface HighlightRecord {
  id: string
  scriptId: string
  scriptCode: string
  /** 划线诞生时的文档版本 */
  documentId: string
  /** 当前挂接的故事条目；orphaned 时为空 */
  storyId?: string | null
  storyTitle?: string | null
  storyType?: string | null
  userId: string
  /** 划线原文 */
  quote: string
  startOffset: number
  endOffset: number
  /** 划线前文（≤64 字符指纹，重锚用） */
  prefix: string
  /** 划线后文（≤64 字符指纹，重锚用） */
  suffix: string
  /** 评论内容，可为空（纯划线） */
  comment?: string | null
  /** private 仅自己可见 / public 进入共读时间线 */
  visibility: string
  /** active 正常 / orphaned 待重锚 */
  status: string
  likeCount: number
  createdAt?: string | null
  updatedAt?: string | null
  userNickname?: string | null
  userAvatarUrl?: string | null
  userAvatarColor?: number | null
}

/** 划线评论分页列表（对应后端 HighlightListResult） */
export interface HighlightListResult {
  total: number
  items: HighlightRecord[]
}

/** 提交划线的请求体（对应后端 CreateHighlightRequest，驼峰字段） */
export interface CreateHighlightPayload {
  storyId: string
  quote: string
  startOffset: number
  endOffset: number
  prefix: string
  suffix: string
  comment?: string
  visibility?: 'private' | 'public'
}

/**
 * 拉取划线评论列表。
 *
 * 默认共读时间线视角：`code` 限定剧本、返回全部公开划线（跨条目、时间倒序）。
 * `mine=true` 返回当前用户自己的全部划线（含 private），需登录。
 * 也可用 `storyId` 单独限定某一条目。
 */
export function fetchHighlights(
  options: {
    code?: string
    title?: string
    storyId?: string
    mine?: boolean
    limit?: number
    offset?: number
  } = {}
): Promise<HighlightListResult> {
  const params: Record<string, any> = {}
  if (options.code) params.code = options.code
  if (options.title) params.title = options.title
  if (options.storyId) params.storyId = options.storyId
  if (options.mine) params.mine = true
  if (options.limit != null) params.limit = options.limit
  if (options.offset != null) params.offset = options.offset
  return get<HighlightListResult>('/dm-guide/highlights', params)
}

/** 提交划线评论（需登录）。同一用户在同一条目同一段文本重复划线返回 409。 */
export function createHighlight(
  payload: CreateHighlightPayload
): Promise<HighlightRecord> {
  return request<HighlightRecord>({
    url: '/dm-guide/highlights',
    method: 'POST',
    data: payload,
  })
}

/** 修改划线评论（只更新传入字段：comment 传 null 清除 / visibility 互转）。只能改自己的。 */
export function updateHighlight(
  highlightId: string,
  patch: { comment?: string | null; visibility?: 'private' | 'public' }
): Promise<HighlightRecord> {
  return request<HighlightRecord>({
    url: `/dm-guide/highlights/${encodeURIComponent(highlightId)}`,
    method: 'PATCH',
    data: patch,
  })
}

/** 删除自己的划线（软删）。 */
export function deleteHighlight(highlightId: string): Promise<void> {
  return request<void>({
    url: `/dm-guide/highlights/${encodeURIComponent(highlightId)}`,
    method: 'DELETE',
  })
}

/* -------------------------------------------------------------------------- */
/*                                  状态文案                                    */
/* -------------------------------------------------------------------------- */

/** 解析任务各阶段的中文说明，列表与详情页共用 */
export const JOB_STAGE_TEXT: Record<string, string> = {
  pending: '排队中',
  downloading: '下载手册',
  extracting: '提取文字',
  chunking: '语义分块',
  generating_qa: '生成问答对',
  embedding: '写入向量库',
  completed: '解析完成',
  failed: '解析失败',
  cancelled: '已取消',
  skipped: '复用已有索引',
}

/** 整体导入状态的中文说明 */
export const OVERALL_STATUS_TEXT: Record<string, string> = {
  no_guide: '未上传手册',
  pending: '待解析',
  uploading: '上传中',
  parsing: '解析中',
  ready: '可问答',
  failed: '解析失败',
}

/**
 * 把任务进度换算成 0~100 的子进度。
 *
 * 刻意不做「四阶段线性插值」——各阶段耗时差着两个数量级（提取几十秒、
 * 问答对生成十几分钟），插出来的数字会长时间卡在同一个值上，看着像卡死。
 * 这里只在**当前阶段内部**算百分比，配合阶段名展示才不误导。
 */
export function jobStageProgress(job?: JobProgress | null): number {
  if (!job) return 0
  const { status } = job
  if (status === 'completed' || status === 'skipped') return 100
  if (status === 'extracting' && job.totalPages > 0) {
    return Math.min(100, Math.round((job.processedPages / job.totalPages) * 100))
  }
  if (status === 'embedding' && job.totalChunks > 0) {
    return Math.min(100, Math.round((job.embeddedChunks / job.totalChunks) * 100))
  }
  if (status === 'generating_qa' && job.totalShards > 0) {
    return Math.min(100, Math.round((job.finishedShards / job.totalShards) * 100))
  }
  return 0
}

/** 任务是否已进入终态，用于决定停止轮询 */
export function isTerminalStatus(status?: string | null): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'skipped' ||
    status === 'ready' ||
    status === 'no_guide'
  )
}

/* -------------------------------------------------------------------------- */
/*                              进度条展示换算                                  */
/* -------------------------------------------------------------------------- */

/** {@link resolveJobProgress} 的返回：进度条需要的全部展示信息 */
export interface JobProgressBar {
  /** 进度条标题 / 文案（优先取后端下发的 stageDetail） */
  text: string
  /** 是否处于「进行中但无法精确量化」态：用滑动动效代替静止百分比，避免误导 */
  indeterminate: boolean
  /** 确定态下的填充百分比；indeterminate 时为 0（由 CSS 动效接管） */
  percent: number
}

/**
 * 把解析任务进度换算成进度条所需的全部展示信息。
 *
 * **文案优先级**：后端下发的 `stageDetail` 最可信 —— 它携带实时计数（例如
 * 「问答对生成中：已累计 37 条」），直接用它；没有时就退回「阶段中文名 +
 * 阶段内子进度%」。
 *
 * **不确定态（indeterminate）**：当任务仍在进行、且当前阶段没有可精确量化的
 * 百分比（问答对生成阶段只有累计条数、没有总条数可除）时，进度条改用滑动
 * 动效，而不是显示一个会误导用户的静止百分比或虚假满格。
 *
 * 之所以要区分：旧逻辑在 `generating_qa` 阶段用「已完成的切片数 / 总切片数」
 * 当百分比，但切片在分块阶段就已全部完成，于是问答对还在生成进度条却先顶满
 * 100%，与「问答对生成中」自相矛盾。
 */
export function resolveJobProgress(job?: JobProgress | null): JobProgressBar {
  if (!job) return { text: '', indeterminate: false, percent: 0 }

  const terminal = job.status === 'completed' || job.status === 'skipped'
  // 这两个阶段有「处理量 / 总量」可精确量化
  const hasMeasurable =
    (job.status === 'extracting' && job.totalPages > 0) ||
    (job.status === 'embedding' && job.totalChunks > 0)

  if (job.stageDetail) {
    return {
      text: job.stageDetail,
      indeterminate: !terminal && !hasMeasurable,
      percent: hasMeasurable ? jobStageProgress(job) : 0,
    }
  }

  const base = job.status ? JOB_STAGE_TEXT[job.status] ?? job.status : ''
  const pct = jobStageProgress(job)
  return {
    text: pct > 0 ? `${base} ${pct}%` : base || '解析中',
    indeterminate: !terminal && !hasMeasurable && pct <= 0,
    percent: pct,
  }
}
