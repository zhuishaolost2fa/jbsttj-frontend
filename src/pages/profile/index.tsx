/**
 * 个人中心。
 *
 * 账号相关的操作原先挤在首页顶部的一条窄条里，改成 tabBar 后归拢到这里。
 * 导入 DM 手册（含上传 → 匹配剧本 → 填表提交的完整链路）已从首页迁入本页，
 * 属于「贡献者行为」，与账号资料放在一起更顺。首页只保留搜索。
 */

import { useCallback, useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { goLogin, useAuth } from '../../store/auth'
import Avatar from '../../components/Avatar'
import ImportDmGuide from '../../components/ImportDmGuide'
import ScriptSubmitForm, { deriveScriptName } from '../../components/ScriptSubmitForm'
import {
  searchScriptByName,
  type ScriptItemCamel,
} from '../../services/script'
import type { UploadResult } from '../../utils/ossMultipartUpload'
import { replayActiveTabIcon } from '../../utils/replayActiveTabIcon'
import './index.less'

const GENDER_LABEL: Record<string, string> = {
  male: '男',
  female: '女',
  other: '保密',
}

function ProfilePage() {
  useDidShow(replayActiveTabIcon);
  const { status, user, isAuthenticated, logout } = useAuth()

  // 导入 DM 指南后「匹配剧本 → 填表 → 提交」流程的上下文
  const [submitVisible, setSubmitVisible] = useState(false)
  const [submitCtx, setSubmitCtx] = useState<{
    file: UploadResult
    candidates: ScriptItemCamel[]
    derivedName: string
  } | null>(null)

  const handleLogout = useCallback(() => {
    void Taro.showModal({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      confirmText: '退出',
      confirmColor: '#e54d42',
    }).then((res) => {
      if (res.confirm) {
        logout()
        Taro.showToast({ title: '已退出登录', icon: 'none' })
      }
    })
  }, [logout])

  /**
   * 导入成功后，用文件名推导剧本名，去剧本库模糊匹配候选，再弹表单提交。
   * 推导不出有效剧本名时跳过匹配、直接进手动填写，避免 422。
   * 匹配接口异常时降级为手动填写，不阻断已上传的结果。
   */
  const handleImportSuccess = useCallback(async (result: UploadResult) => {
    const derived = deriveScriptName(result.fileName)
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
      console.error('[profile] 剧本名匹配失败，降级为手动填写:', err)
      setSubmitCtx({
        file: result,
        candidates: [],
        derivedName: derived,
      })
      setSubmitVisible(true)
    }
  }, [])

  /**
   * 剧本提交成功后跳到「我的剧本」。
   * 解析要跑十几分钟，停在首页看不到后续反馈，送到列表页正好看着进度条走完。
   */
  const handleSubmitted = useCallback((created: ScriptItemCamel) => {
    setSubmitVisible(false)
    Taro.showToast({ title: '已提交，正在解析手册', icon: 'none', duration: 1800 })
    setTimeout(() => {
      void Taro.navigateTo({ url: '/pages/myScripts/index' })
    }, 800)
    return created
  }, [])

  const displayName = user?.nickname || user?.email || '未登录'
  const genderText = user?.gender ? GENDER_LABEL[user.gender] : ''
  const subLine = [user?.region, genderText].filter(Boolean).join(' · ') || '剧本与解析记录都挂在此账号下'

  return (
    <View className='profile-page'>
      {/* ===== 账号卡片 ===== */}
      <View className='account-card'>
        {status === 'loading' ? (
          <Text className='account-loading'>正在恢复登录状态…</Text>
        ) : isAuthenticated ? (
          <View className='account-inner'>
            <Avatar
              name={user?.nickname || user?.email}
              url={user?.avatarUrl}
              color={user?.avatarColor}
              size={56}
            />
            <View className='account-body'>
              <Text className='account-email'>{displayName}</Text>
              <Text className='account-sub'>{subLine}</Text>
            </View>
            <View
              className='account-edit'
              onClick={() => Taro.navigateTo({ url: '/pages/profile/edit/index' })}
            >
              <Text className='account-edit-text'>编辑</Text>
            </View>
          </View>
        ) : (
          <View className='account-inner'>
            <Avatar name='guest' color={0} size={56} />
            <View className='account-body'>
              <Text className='account-email'>未登录</Text>
              <Text className='account-sub'>登录后可导入剧本、使用 AI 问答</Text>
            </View>
            <View className='login-btn' onClick={() => goLogin()}>
              <Text className='login-btn-text'>登录</Text>
            </View>
          </View>
        )}
      </View>

      {/* ===== 资料 / 安全 ===== */}
      {isAuthenticated ? (
        <View className='menu-group'>
          <View
            className='menu-item'
            onClick={() => Taro.navigateTo({ url: '/pages/profile/edit/index' })}
          >
            <Text className='menu-icon'>📝</Text>
            <Text className='menu-label'>编辑资料</Text>
            <Text className='menu-arrow'>&#x203A;</Text>
          </View>
          <View
            className='menu-item'
            onClick={() => Taro.navigateTo({ url: '/pages/profile/security/index' })}
          >
            <Text className='menu-icon'>🔐</Text>
            <Text className='menu-label'>账号与安全</Text>
            <Text className='menu-arrow'>&#x203A;</Text>
          </View>
        </View>
      ) : null}

      {/* ===== 功能入口 ===== */}
      <View className='menu-group'>
        <View
          className='menu-item'
          onClick={() => Taro.navigateTo({ url: '/pages/myScripts/index' })}
        >
          <Text className='menu-icon'>📚</Text>
          <Text className='menu-label'>我的剧本</Text>
          <Text className='menu-arrow'>&#x203A;</Text>
        </View>
        <View
          className='menu-item'
          onClick={() => Taro.navigateTo({ url: '/pages/scriptRequests/index' })}
        >
          <Text className='menu-icon'>🙋</Text>
          <Text className='menu-label'>求解析</Text>
          <Text className='menu-arrow'>&#x203A;</Text>
        </View>
      </View>

      {/* ===== 导入 DM 手册（从首页迁入） ===== */}
      <View className='import-card'>
        <View className='import-card-head'>
          <Text className='import-card-title'>📥 导入 DM 手册</Text>
          <Text className='import-card-sub'>贡献剧本，参与收益分成</Text>
        </View>

        {/* 仅支持 Word 的说明 */}
        <View className='import-hint'>
          <View className='import-hint-row'>
            <Text className='import-hint-k'>支持格式</Text>
            <Text className='import-hint-v'>
              仅支持 Word 文档（.doc / .docx）导入
            </Text>
          </View>
          <View className='import-hint-row'>
            <Text className='import-hint-k'>为什么不能直接传 PDF</Text>
            <Text className='import-hint-v'>
              PDF 需 OCR 识别才能解析，成本太高暂不支持
            </Text>
          </View>
          <View className='import-hint-row'>
            <Text className='import-hint-k'>PDF 转 Word 方法</Text>
            <Text className='import-hint-v'>
              超大型 PDF 先用 Edge 浏览器打印模式拆分，再用夸克网盘转成 Word
            </Text>
          </View>
          <View className='import-hint-row'>
            <Text className='import-hint-k'>收益分配</Text>
            <Text className='import-hint-v'>
              剧本解析费用抽取 20%，其余收益分配给导入者与知识库共建者
            </Text>
          </View>
        </View>

        {isAuthenticated ? (
          <ImportDmGuide onSuccess={handleImportSuccess} />
        ) : (
          <View className='import-locked' onClick={() => goLogin()}>
            <Text className='locked-icon'>🔒</Text>
            <Text className='locked-text'>登录后导入 DM 指南</Text>
          </View>
        )}
      </View>

      {/* 导入成功后的「匹配剧本 → 填表 → 提交」弹层 */}
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

      <View className='menu-group'>
        <View
          className='menu-item'
          onClick={() =>
            Taro.showModal({
              title: '关于',
              content:
                '剧本杀复盘助手：导入 DM 主持人手册后自动建立语义索引，带本时可即时检索规则与流程。',
              showCancel: false,
            })
          }
        >
          <Text className='menu-icon'>ℹ️</Text>
          <Text className='menu-label'>关于</Text>
          <Text className='menu-arrow'>&#x203A;</Text>
        </View>
      </View>

      {isAuthenticated ? (
        <View className='logout-btn' onClick={handleLogout}>
          <Text className='logout-text'>退出登录</Text>
        </View>
      ) : null}

      <Text className='foot-hint'>⚠️ 复盘含剧透，未玩过的本请勿查看</Text>
    </View>
  )
}

export default ProfilePage
