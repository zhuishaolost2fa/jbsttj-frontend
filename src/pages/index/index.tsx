import { useState, useRef, useCallback, useEffect } from 'react'
import { View, Text, Image } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { SearchBar } from '@nutui/nutui-react-taro'
import ImportDmGuide from '../../components/ImportDmGuide'
import ScriptSubmitForm, { deriveScriptName } from '../../components/ScriptSubmitForm'
import {
  searchScriptByName,
  autocompleteScripts,
  type ScriptItemCamel,
  type ScriptAutocompleteItem,
} from '../../services/script'
import type { UploadResult } from '../../utils/ossMultipartUpload'
import { goLogin, useAuth } from '../../store/auth'
import './index.less'

function Index() {
  // 账号信息与退出登录已挪到「我的」tab，首页只关心「是否已登录」这一件事
  const { isAuthenticated } = useAuth()
  const [searchValue, setSearchValue] = useState('')
  const [searchResults, setSearchResults] = useState<ScriptAutocompleteItem[]>([])
  const [showResults, setShowResults] = useState(false)
  const [searching, setSearching] = useState(false)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 联想请求序号：仅应用最新一次的结果，丢弃乱序的旧响应 */
  const reqSeq = useRef(0)

  // 导入 DM 指南后「匹配剧本 → 填表 → 提交」流程的上下文
  const [submitVisible, setSubmitVisible] = useState(false)
  const [submitCtx, setSubmitCtx] = useState<{
    file: UploadResult
    candidates: ScriptItemCamel[]
    derivedName: string
  } | null>(null)

  /**
   * 真正发联想请求：调用后端 `/scripts/autocomplete`，只召回已上架剧本。
   * 用 reqSeq 做「最新响应胜出」的竞态保护，避免快速输入时旧请求后到覆盖新结果。
   * 接口异常时安静降级（清空候选），不让搜索框报错卡住输入。
   */
  const runSearch = useCallback(async (raw: string) => {
    const keyword = raw.trim()
    if (!keyword) {
      setSearchResults([])
      setShowResults(false)
      setSearching(false)
      return
    }
    const seq = ++reqSeq.current
    setSearching(true)
    try {
      const items = await autocompleteScripts(keyword, 8)
      if (seq !== reqSeq.current) return // 已有更新的请求发出，丢弃本次结果
      setSearchResults(items)
      setShowResults(true)
      setSearching(false)
    } catch {
      if (seq !== reqSeq.current) return
      // 联想失败不应阻断输入：清空候选、收起报错，保持搜索框可用
      setSearchResults([])
      setSearching(false)
    }
  }, [])

  // 防抖搜索函数：输入停下 300ms 后才真正发请求
  const debouncedSearch = useCallback(
    (keyword: string) => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current)
      }
      debounceTimer.current = setTimeout(() => {
        void runSearch(keyword)
      }, 300)
    },
    [runSearch]
  )

  // 组件卸载时清除定时器
  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current)
      }
    }
  }, [])

  const handleSearchChange = (value: string) => {
    setSearchValue(value)
    debouncedSearch(value)
  }

  const handleSearchConfirm = (value: string) => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current)
    }
    void runSearch(value)
  }

  const handleClear = () => {
    setSearchValue('')
    setSearchResults([])
    setShowResults(false)
    setSearching(false)
  }

  /** 选中联想项：跳到剧本详情（复盘 + DM 手册问答） */
  const handleResultClick = (item: ScriptAutocompleteItem) => {
    setShowResults(false)
    setSearchValue(item.title)
    Taro.navigateTo({
      url: `/pages/scriptDetail/index?code=${encodeURIComponent(
        item.code
      )}&title=${encodeURIComponent(item.title)}`,
    })
  }

  /**
   * 剧本提交成功后跳到「我的剧本」。
   *
   * 解析要跑十几分钟，停在首页用户看不到任何后续反馈，很容易以为没生效。
   * 送到列表页正好能看着进度条走完，也顺带告诉他「导入的本都在这儿」。
   */
  const handleSubmitted = useCallback((created: ScriptItemCamel) => {
    setSubmitVisible(false)
    Taro.showToast({ title: '已提交，正在解析手册', icon: 'none', duration: 1800 })
    setTimeout(() => {
      void Taro.switchTab({ url: '/pages/scripts/index' })
    }, 800)
    return created
  }, [])

  return (
    <View className='home-page'>
      <View className='main-content'>
        {/* 标题 - 简洁 */}
        <View className='brand'>
          <Text className='brand-emoji'>🎭</Text>
          <Text className='brand-title'>剧本杀复盘助手</Text>
        </View>

        {/* 搜索框 - 核心 */}
        <View className='search-section'>
          <SearchBar
            value={searchValue}
            placeholder='搜索你玩过的剧本...'
            shape='round'
            onChange={handleSearchChange}
            onSearch={handleSearchConfirm}
            onClear={handleClear}
            onBlur={() => {
              if (!searchValue) setShowResults(false)
            }}
          />
          {showResults && (
            <View className='search-results'>
              {searching ? (
                <View className='search-loading'>
                  <Text className='loading-text'>搜索中…</Text>
                </View>
              ) : searchResults.length > 0 ? (
                searchResults.map((item) => (
                  <View
                    className='search-result-item'
                    key={item.id || item.code}
                    onClick={() => handleResultClick(item)}
                  >
                    {item.coverUrl ? (
                      <Image
                        className='result-cover'
                        src={item.coverUrl}
                        mode='aspectFill'
                      />
                    ) : (
                      <Text className='result-icon'>📜</Text>
                    )}
                    <View className='result-text'>
                      <Text className='result-name'>{item.title}</Text>
                      {item.author ? (
                        <Text className='result-author'>{item.author}</Text>
                      ) : null}
                    </View>
                    {item.hasGuide ? <Text className='result-tag'>已导入</Text> : null}
                    <Text className='result-arrow'>&#x203A;</Text>
                  </View>
                ))
              ) : (
                <View className='search-empty'>
                  <Text className='empty-icon'>🔍</Text>
                  <Text className='empty-text'>未找到相关剧本，换个关键词试试</Text>
                </View>
              )}
            </View>
          )}
        </View>

        {/* 导入 DM 指南：上传接口需要 Bearer token，未登录先引导登录 */}
        <View className='import-section'>
          {isAuthenticated ? (
            <ImportDmGuide
              onSuccess={async (result) => {
                // 导入成功后，用文件名推导剧本名，去剧本库模糊匹配
                const derived = deriveScriptName(result.fileName)
                // 文件名推导不出有效剧本名（如「DM指南.pdf」会被剥干净）时，
                // 后端 /byname 会因 name 为空 422。这里直接跳过匹配、进入手动填写，
                // 避免弹出误导性的「匹配失败」提示
                if (!derived) {
                  setSubmitCtx({ file: result, candidates: [], derivedName: '' })
                  setSubmitVisible(true)
                  return
                }
                try {
                  const res = await searchScriptByName(derived)
                  setSubmitCtx({
                    file: result,
                    candidates: res.items ?? [],
                    derivedName: derived,
                  })
                  setSubmitVisible(true)
                } catch (err) {
                  // 匹配接口异常不应阻断「已上传」的结果：
                  // 降级为「手动填写」模式，让用户仍能把这份 DM 指南提交到后端
                  console.error('[index] 剧本名匹配失败，降级为手动填写:', err)
                  setSubmitCtx({
                    file: result,
                    candidates: [],
                    derivedName: derived,
                  })
                  setSubmitVisible(true)
                }
              }}
            />
          ) : (
            <View className='import-locked' onClick={() => goLogin()}>
              <Text className='locked-icon'>🔒</Text>
              <Text className='locked-text'>登录后导入 DM 指南</Text>
            </View>
          )}
        </View>

        {/* 提示 - 最小化 */}
        <Text className='warning-hint'>
          ⚠️ 复盘含剧透，未玩过的本请勿查看
        </Text>
      </View>

      {/* 导入 DM 指南后的「匹配剧本 → 填表 → 提交」弹层 */}
      {submitCtx && (
        <ScriptSubmitForm
          visible={submitVisible}
          file={submitCtx.file}
          candidates={submitCtx.candidates}
          derivedName={submitCtx.derivedName}
          onClose={() => setSubmitVisible(false)}
          onSubmitted={handleSubmitted}
        />
      )}
    </View>
  )
}

export default Index
